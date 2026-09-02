/**
 * The agent's verdict: `IN_CALL -> APPROVED | REJECTED | ABORTED` (T35, §18, §45).
 *
 * The most important transaction in the system, and the one §46 justifies:
 * nobody wants a session `APPROVED` with no billing row, and nobody wants a
 * billing row for a session that never reached a verdict. Both are impossible
 * only if the transition, the charge, the attestation, the AI snapshot, the
 * history and the outbox commit together — so they do, in
 * `SessionRepository.submitVerdict`, and this service is everything that must
 * happen before and after it.
 *
 * **Before.** Establish who is asking and what they are answering: the session
 * is theirs, the checklist matches the template pinned to it (T34), the billing
 * follows from the outcome (`@vcip/shared`, never computed here), and the AI
 * HUD is read out of Redis while it still exists. All reads, no locks — a
 * refused checklist costs a 422 rather than an opened and rolled-back
 * transaction on the row that is about to be billed.
 *
 * **After.** Free the agent and tell both screens. Neither can fail the
 * verdict: the transaction has committed, the money is recorded, and a
 * presence key that would not clear is a smaller problem than an exception
 * thrown at an agent whose verdict is already law.
 *
 * **Single-winner (D17).** A customer disconnect and this verdict race, and
 * exactly one commits. The guard lives in the UPDATE's WHERE clause, not here:
 * anything decided by reading first and writing second has a window between the
 * two, and this is the one operation where that window would mean two billing
 * rows for one verification.
 *
 * **The AI decides nothing (I7).** The HUD is read to be *recorded*, never
 * consulted. There is no branch in this file on a liveness score.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentVerdictRequest } from '@vcip/shared';
import {
  DomainError,
  ErrorCode,
  SessionEventType,
  SessionStatus,
  getBillingForOutcome,
} from '@vcip/shared';
import type { Logger } from 'pino';
import type { AiHudRepository } from '../ai/ai-hud.repository.js';
import { InjectAiHudRepository } from '../ai/ai-hud.repository.js';
import type { AgentActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { ChecklistService } from '../checklist/checklist.service.js';
import type { Notifications } from '../realtime/notifications.js';
import { InjectNotifications } from '../realtime/notifications.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { PresenceService } from './presence.service.js';

/**
 * `POST /v1/agent/sessions/{id}/verdict` response body (§18).
 *
 * Exactly the five documented fields. `bill_amount_paise` is reported because
 * the agent's portal shows what the verification cost, and reporting it from
 * the row that was written means the number on screen is the number in the
 * ledger rather than one the client recomputed.
 */
export interface VerdictResult {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly verdict: string;
  readonly bill_category: string;
  readonly bill_amount_paise: number;
}

/** The webhook event name the outbox row carries (§20). */
export const SESSION_COMPLETED_EVENT = 'session.completed';

export type VerdictClock = () => Date;

export const VERDICT_CLOCK = Symbol('VERDICT_CLOCK');

@Injectable()
export class AgentVerdictService {
  private readonly now: VerdictClock;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    private readonly checklist: ChecklistService,
    @InjectAiHudRepository() private readonly hud: AiHudRepository,
    private readonly presence: PresenceService,
    private readonly scope: TenantScope,
    @InjectNotifications() private readonly notify: Notifications,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(VERDICT_CLOCK) now?: VerdictClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  async submit(
    actor: AgentActor,
    sessionId: string,
    request: AgentVerdictRequest,
  ): Promise<VerdictResult> {
    setContextSession(sessionId);

    const session = this.scope.assertOwnership(
      actor,
      await this.sessions.findForMediaToken(actor.tenantId, sessionId),
    );

    // Read first, for the error rather than for the decision. The UPDATE's
    // WHERE clause is what actually protects the transition; this exists so an
    // agent who wandered into a colleague's call is told so, instead of being
    // told the session already has an outcome.
    this.requireOwnCall(actor, session.agentId, session.status, sessionId);

    // Against the template this session is pinned to, not the tenant's current
    // one (D8). Throws 422 naming the items, and writes nothing.
    const checklist = await this.checklist.validate({
      tenantId: actor.tenantId,
      sessionId,
      answers: request.checklist,
      // The reading of §18 that makes rejection possible at all — see
      // `SubmissionOptions` in `@vcip/shared`.
      requireAllChecked: request.verdict === SessionStatus.APPROVED,
    });

    const billing = getBillingForOutcome(request.verdict);
    /* c8 ignore next 4 -- unreachable: the three submittable verdicts all bill */
    if (!billing.billable) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'This outcome has no billing rule.');
    }

    // Read before the transaction, because Redis is not part of it. A HUD that
    // expired or was never written is null, and null is recorded as "no AI"
    // rather than as an all-zero summary (T32).
    const aiSummary = await this.readHud(sessionId);

    const now = this.now();
    const outcome = await this.sessions.submitVerdict({
      sessionId,
      tenantId: actor.tenantId,
      agentId: actor.userId,
      verdict: request.verdict,
      now,
      billCategory: billing.category,
      billAmountPaise: billing.amountPaise,
      checklist,
      aiSummary,
      events: [
        {
          type: SessionEventType.VERDICT_SUBMITTED,
          actorType: 'AGENT',
          actorId: actor.userId,
          payload: {
            from: SessionStatus.IN_CALL,
            to: request.verdict,
            verdict: request.verdict,
            // Which items were confirmed, as history. The row set in
            // `session_checklist_items` is the record; this makes the same fact
            // legible in the one append-only log an auditor reads end to end.
            checklist: checklist.map((item) => ({ key: item.key, checked: item.checked })),
          },
        },
        {
          type: SessionEventType.BILLING_CREATED,
          actorType: 'SYSTEM',
          actorId: null,
          payload: { category: billing.category, amount_paise: billing.amountPaise },
        },
      ],
      // D21: written now, without the evidence keys, because they do not exist
      // yet. T42 enriches this same row when the export resolves.
      webhookEventType: SESSION_COMPLETED_EVENT,
      webhookPayload: {
        event: SESSION_COMPLETED_EVENT,
        session_id: sessionId,
        verdict: request.verdict,
        bill_category: billing.category,
        bill_amount_paise: billing.amountPaise,
        occurred_at: now.toISOString(),
      },
    });

    if (outcome.kind === 'LOST') this.refuseLost(actor, sessionId);

    // Everything below has committed already and none of it may throw.
    await this.freeAgent(actor.userId, sessionId);
    await this.announce(actor, sessionId, outcome.session.status, outcome.session.verdict);

    this.logger.info(
      {
        event: 'agent.verdict.submitted',
        tenant_id: actor.tenantId,
        agent_id: actor.userId,
        session_id: sessionId,
        verdict: outcome.session.verdict,
        bill_category: outcome.session.billCategory,
        bill_amount_paise: outcome.session.billAmountPaise,
        talk_ms: outcome.session.talkMs,
        ai_summary: aiSummary !== null,
      },
      'verdict submitted',
    );

    return {
      session_id: outcome.session.id,
      status: outcome.session.status,
      verdict: outcome.session.verdict,
      bill_category: outcome.session.billCategory,
      bill_amount_paise: outcome.session.billAmountPaise,
    };
  }

  /**
   * The agent must be on this call.
   *
   * Status first, assignment second, for the reason `decideMediaToken` orders
   * them that way: an agent asking about a `QUEUED` session is told the state
   * is wrong, which reveals nothing, rather than being told it belongs to
   * somebody else — a statement about a session they have no relationship with.
   */
  private requireOwnCall(
    actor: AgentActor,
    assignedAgentId: string | null,
    status: SessionStatus,
    sessionId: string,
  ): void {
    if (status !== SessionStatus.IN_CALL) {
      throw new DomainError(
        ErrorCode.SESSION_INVALID_STATE,
        'A verdict can only be submitted for a session that is in call.',
      );
    }

    if (assignedAgentId !== actor.userId) {
      this.logger.warn(
        {
          event: 'agent.verdict.not_assigned',
          tenant_id: actor.tenantId,
          agent_id: actor.userId,
          session_id: sessionId,
          assigned_agent_id: assignedAgentId,
        },
        'an agent tried to submit a verdict on a session they do not hold',
      );
      throw new DomainError(ErrorCode.FORBIDDEN, 'This session is not assigned to you.');
    }
  }

  /**
   * Someone else reached a terminal outcome first (D17).
   *
   * 409, and deliberately without saying which someone. From the loser's side
   * the customer dropping, the sweeper timing out an agent, and a duplicate of
   * their own request are one fact: this session already has an outcome and it
   * is not this one. The winner is in `session_events` for anyone who needs to
   * know.
   */
  private refuseLost(actor: AgentActor, sessionId: string): never {
    this.logger.info(
      {
        event: 'agent.verdict.lost',
        tenant_id: actor.tenantId,
        agent_id: actor.userId,
        session_id: sessionId,
      },
      'verdict lost: the session already reached a terminal outcome',
    );

    throw new DomainError(ErrorCode.CONFLICT, 'This session already has a terminal outcome.');
  }

  /**
   * The HUD, or nothing.
   *
   * A Redis failure is not a reason to refuse a verdict. AI is assistive (D6)
   * and the summary is a record of a signal that decided nothing (I7), so a
   * verification whose summary could not be read is still a verification —
   * losing the row is strictly better than losing the verdict.
   */
  private async readHud(sessionId: string) {
    try {
      return await this.hud.read(sessionId);
    } catch (error) {
      this.logger.warn(
        { event: 'agent.verdict.hud_unreadable', session_id: sessionId, err: error },
        'could not read the AI HUD; the verdict is recorded without a summary',
      );
      return null;
    }
  }

  /** R5: BUSY is cleared when the session ends. Never fails the verdict. */
  private async freeAgent(agentId: string, sessionId: string): Promise<void> {
    try {
      await this.presence.markAvailable(agentId);
    } catch (error) {
      this.logger.error(
        { event: 'agent.verdict.presence_failed', session_id: sessionId, err: error },
        'the verdict committed but the agent could not be freed',
      );
    }
  }

  /**
   * Both screens have somewhere else to be.
   *
   * The customer sees the outcome and the agent's portal releases the work.
   * Best-effort by construction: T27 owns the transport, and a socket nobody
   * is listening on must not throw an exception at an agent whose verdict has
   * already been recorded.
   */
  private async announce(
    actor: AgentActor,
    sessionId: string,
    status: SessionStatus,
    verdict: string,
  ): Promise<void> {
    try {
      await this.notify.sessionCompleted(sessionId, status, verdict, {
        tenantId: actor.tenantId,
        userId: actor.userId,
      });
    } catch (error) {
      this.logger.warn(
        { event: 'agent.verdict.notify_failed', session_id: sessionId, err: error },
        'the verdict committed but the notification could not be published',
      );
    }
  }
}
