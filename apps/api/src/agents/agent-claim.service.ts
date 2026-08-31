/**
 * Claiming a queued session: `QUEUED -> OFFERED` (T18).
 *
 * The MVP is pull-claim (D4). No matcher assigns work; an agent looks at the
 * queue T17 renders and takes one session, and this is the whole of "takes".
 *
 * **One statement decides it.** Everything before the call to
 * `SessionRepository.claim` is a pre-check that produces a better error than a
 * bare 409 — the session exists, it is this tenant's, it is still queued, the
 * agent speaks its language, the agent is at their desk. None of those
 * pre-checks is the guard. Two agents can pass every one of them
 * simultaneously; the conditional UPDATE inside `claim` is what makes exactly
 * one of them win (D5), and the loser is told so.
 *
 * **Redis is downstream of that decision, never upstream of it.** `BUSY` is
 * written after PostgreSQL has committed, and a failure to write it does not
 * fail the claim — the offer is real, it is in `sessions` and in
 * `session_events`, and a presence key is a hint about a desk. The consequence
 * is stated where it belongs, in the log and in the contract: a claim whose
 * `BUSY` write failed leaves an agent who looks free for up to the presence TTL
 * and may be handed a second offer. `max_concurrent` in PostgreSQL is what
 * actually stops that, which is precisely why the authority is there and not
 * here (D1, D2).
 *
 * **Nothing here touches the queue projection.** The Redis member outlives the
 * claim by design: T17 filters it out on the next view because PostgreSQL says
 * the session is no longer `QUEUED`, and leaving the score in place is what
 * lets T20 return an expired offer to its original position without having to
 * reconstruct one.
 *
 * **The agent is whoever the JWT says.** The session id is a path parameter;
 * the agent id and the tenant are not parameters at all.
 */

import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError, ErrorCode, SessionEventType, SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
import type {
  ClaimableSessionRow,
  SessionClaimOutcome,
  SessionRepository,
} from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantsService } from '../tenants/tenants.service.js';
import type { AgentProfileRow, AgentRepository } from './agent.repository.js';
import { InjectAgentRepository } from './agent.repository.js';
import { offerExpiresAt, presenceAllowsClaim } from './agent-claim.rules.js';
import { eligibleLanguages, speaks } from './agent-queue.rules.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { PresenceService } from './presence.service.js';

/**
 * `POST /v1/agent/sessions/{id}/claim` response body, as §17.1 defines it.
 *
 * Four fields. There is no `external_ref`, no customer identity, no room name,
 * and no queue internals: the claim answers "is this mine, and until when?",
 * and the session's own routes answer everything else.
 */
export interface ClaimResult {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly offered_to_agent_id: string;
  readonly offer_expires_at: string;
}

/** The clock, injected so `offer_expires_at` is testable. */
export type ClaimClock = () => Date;

/**
 * Optional override for the clock.
 *
 * A token rather than a bare optional parameter, for the reason
 * `PRESENCE_CLOCK` and `AGENT_QUEUE_CLOCK` both document: a function type
 * erases to `Function` in `design:paramtypes`, which Nest cannot resolve, and
 * the failure lands at boot rather than in a unit test.
 */
export const AGENT_CLAIM_CLOCK = Symbol('AGENT_CLAIM_CLOCK');

/**
 * Statuses that mean the session already belongs to an agent.
 *
 * Used only to choose between two 409s. `SESSION_ALREADY_ASSIGNED` when someone
 * holds it, `SESSION_INVALID_STATE` when it is simply not claimable — a session
 * that never queued, or one that ended.
 */
const ASSIGNED_STATUSES: readonly SessionStatus[] = Object.freeze([
  SessionStatus.OFFERED,
  SessionStatus.IN_CALL,
]);

const alreadyAssigned = (): DomainError =>
  new DomainError(
    ErrorCode.SESSION_ALREADY_ASSIGNED,
    'The session has already been claimed by another agent.',
  );

@Injectable()
export class AgentClaimService {
  private readonly now: ClaimClock;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectAgentRepository() private readonly agents: AgentRepository,
    private readonly presence: PresenceService,
    private readonly tenants: TenantsService,
    private readonly scope: TenantScope,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(AGENT_CLAIM_CLOCK) now?: ClaimClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  async claim(actor: AgentActor, sessionId: string): Promise<ClaimResult> {
    setContextSession(sessionId);

    const profile = await this.requireProfile(actor);
    const session = await this.load(actor, sessionId);

    // Read before anything is decided: the timeout is needed both to report an
    // offer this agent already holds and to describe a new one, and a missing
    // tenant row is a 500 rather than something that should surface halfway
    // through a transaction.
    const config = await this.tenants.requireConfig(actor.tenantId);

    // Already theirs. Answered before language, presence, and capacity, because
    // none of those is being decided — the offer exists, and this is a report
    // of it. A retry after a lost response is the ordinary way to arrive here,
    // and the old behaviour told that agent another agent had taken a session
    // they were in fact holding, with no route left to find it.
    const own = this.ownOffer(actor, session, config.offerTimeoutSeconds);
    if (own !== null) return own;

    this.requireClaimable(session);
    this.requireLanguage(actor, profile, session);
    await this.requirePresent(actor);

    const offeredAt = this.now();
    const outcome = await this.sessions.claim({
      sessionId,
      tenantId: actor.tenantId,
      agentId: actor.userId,
      maxConcurrent: profile.maxConcurrent,
      offeredAt,
      // Computed once, here, and stored. The response then reports the row
      // rather than a second derivation of it.
      offerExpiresAt: offerExpiresAt(offeredAt, config.offerTimeoutSeconds),
      // The canonical name for this transition. `SESSION_ASSIGNED` is what
      // `docs/06-database-schema.md` §15 calls it, and the vocabulary is
      // closed — the payload carries the edge, so no new name is needed to
      // distinguish claim from accept.
      event: {
        type: SessionEventType.SESSION_ASSIGNED,
        actorType: 'AGENT',
        actorId: actor.userId,
        payload: {
          from: SessionStatus.QUEUED,
          to: SessionStatus.OFFERED,
          agent_id: actor.userId,
          offer_timeout_seconds: config.offerTimeoutSeconds,
        },
      },
    });

    return this.resolve(actor, sessionId, outcome, config.offerTimeoutSeconds);
  }

  // ----------------------------------------------------------- pre-checks

  /** A user with no agent profile is not someone a session can be offered to. */
  private async requireProfile(actor: AgentActor): Promise<AgentProfileRow> {
    const profile = await this.agents.findProfile(actor.userId, actor.tenantId);
    if (profile === null) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'This user is not an agent.',
      });
    }
    return profile;
  }

  /**
   * Load the session, prove the tenant owns it, and prove it is claimable.
   *
   * `assertOwnership` gives another tenant's session and a session that never
   * existed the same 404, so a claim cannot be used to probe for ids across
   * tenants (I8). That check runs before status, language, and presence — none
   * of which may leak anything about a row this agent may not see.
   */
  private async load(actor: AgentActor, sessionId: string): Promise<ClaimableSessionRow> {
    // The read is already tenant-scoped in SQL, so this can only be reached
    // with a matching row or none. `assertOwnership` is still what turns "none"
    // into the 404, so a session in another tenant and a session that never
    // existed keep giving the identical answer, decided in one place (I8).
    return this.scope.assertOwnership(
      actor,
      await this.sessions.findClaimable(actor.tenantId, sessionId),
    );
  }

  /**
   * The offer this agent already holds, or null.
   *
   * Reported as a success rather than a conflict, with the expiry derived from
   * the stored `offered_at` — so a retry gets the *original* window, not a
   * fresh one. Nothing is re-claimed and no event is appended; the only write
   * is the best-effort `BUSY`, which repairs a presence whose first write
   * failed.
   */
  private ownOffer(
    actor: AgentActor,
    session: ClaimableSessionRow,
    timeoutSeconds: number,
  ): ClaimResult | null {
    if (session.status !== SessionStatus.OFFERED) return null;
    if (session.offeredToAgentId !== actor.userId) return null;

    // The stored expiry, not a fresh derivation. The sweeper acts on this
    // column, so an agent must be told the same instant the sweeper will use;
    // the fallback covers only a row written before the column was persisted.
    const expiresAt =
      session.offerExpiresAt ?? offerExpiresAt(session.offeredAt ?? this.now(), timeoutSeconds);

    void this.markBusy(actor, session.id);

    this.logger.info(
      {
        event: 'agent.claim.already_held',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        session_id: session.id,
      },
      'returning the offer this agent already holds',
    );

    return {
      session_id: session.id,
      status: SessionStatus.OFFERED,
      offered_to_agent_id: actor.userId,
      offer_expires_at: expiresAt.toISOString(),
    };
  }

  /** Reject a session that is not waiting in the queue for someone to take. */
  private requireClaimable(session: ClaimableSessionRow): void {
    if (session.status === SessionStatus.QUEUED) return;
    // By here the offer is not this agent's — `ownOffer` returned first — so
    // "another agent" is accurate rather than a guess.
    if (ASSIGNED_STATUSES.includes(session.status)) throw alreadyAssigned();
    throw new DomainError(
      ErrorCode.SESSION_INVALID_STATE,
      'The session is not waiting in the queue.',
    );
  }

  /**
   * The agent must speak the session's language.
   *
   * Normalised on both sides, exactly as the queue view does it, so an agent
   * configured for `EN` and a session stored as `en` are the same language and
   * `en-IN` remains a different one (R13).
   *
   * A 403 rather than a 404: the session is this tenant's and the agent may
   * know it exists — T17 does not show it to them, so reaching here means a
   * hand-built request, and telling them plainly why it was refused leaks
   * nothing they could not already see.
   */
  private requireLanguage(
    actor: AgentActor,
    profile: AgentProfileRow,
    session: ClaimableSessionRow,
  ): void {
    if (speaks(eligibleLanguages(profile.languages), session.language)) return;

    this.logger.warn(
      {
        event: 'agent.claim.rejected',
        reason: 'language',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        session_id: session.id,
      },
      'claim rejected: agent does not speak the session language',
    );
    throw new ForbiddenException({
      code: ErrorCode.FORBIDDEN,
      message: 'This session is not in a language you are configured for.',
    });
  }

  /**
   * The agent must be live and `AVAILABLE`.
   *
   * An eligibility rule, not a lock. Presence lives in Redis and can lapse a
   * millisecond after this returns; PostgreSQL still decides the claim. What
   * this buys is that an agent who closed their laptop, or who is already on a
   * call, does not silently take a customer off the queue.
   */
  private async requirePresent(actor: AgentActor): Promise<void> {
    const status = await this.presence.liveStatus(actor);
    if (presenceAllowsClaim(status)) return;

    throw new DomainError(
      ErrorCode.CONFLICT,
      status === null
        ? 'You are not available. Go available before claiming a session.'
        : `You cannot claim a session while your status is ${status}.`,
    );
  }

  // -------------------------------------------------------------- outcome

  private async resolve(
    actor: AgentActor,
    sessionId: string,
    outcome: SessionClaimOutcome,
    timeoutSeconds: number,
  ): Promise<ClaimResult> {
    if (outcome.kind === 'AT_CAPACITY') {
      this.logger.info(
        {
          event: 'agent.claim.rejected',
          reason: 'max_concurrent',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
          active_sessions: outcome.active,
        },
        'claim rejected: agent is at capacity',
      );
      throw new DomainError(
        ErrorCode.CONFLICT,
        'You are already handling as many sessions as your profile allows.',
      );
    }

    if (outcome.kind === 'LOST') {
      this.logger.info(
        {
          event: 'agent.claim.lost',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
        },
        'claim lost: the session was no longer queued',
      );
      throw alreadyAssigned();
    }

    const { session } = outcome;
    await this.markBusy(actor, sessionId);

    this.logger.info(
      {
        event: 'agent.claim.offered',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        session_id: sessionId,
        offer_timeout_seconds: timeoutSeconds,
      },
      'session offered to agent',
    );

    return {
      session_id: session.id,
      status: session.status,
      offered_to_agent_id: session.offeredToAgentId,
      // What the row holds, so the agent and the sweeper agree.
      offer_expires_at: session.offerExpiresAt.toISOString(),
    };
  }

  /**
   * Mark the agent busy, and never fail the claim for it.
   *
   * There is no distributed transaction here and there should not be: the
   * offer is committed in PostgreSQL before this runs, so the two stores can
   * disagree for as long as the presence TTL, and PostgreSQL is right (D1).
   * Both failure shapes are handled the same way and logged distinctly —
   * `false` means the presence key was gone (the TTL lapsed between the
   * eligibility check and here), and a throw means Redis itself was
   * unreachable.
   */
  private async markBusy(actor: AgentActor, sessionId: string): Promise<void> {
    try {
      const marked = await this.presence.markBusy(actor.userId);
      if (marked) return;
      this.logger.warn(
        {
          event: 'agent.claim.presence_missing',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
        },
        'claim committed but the agent had no presence to mark BUSY',
      );
    } catch (error) {
      this.logger.error(
        {
          event: 'agent.claim.presence_failed',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
          err: error,
        },
        'claim committed but the BUSY write failed',
      );
    }
  }
}
