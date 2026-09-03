/**
 * The agent asking for a document to be read (§19).
 *
 * `POST /v1/agent/sessions/{id}/document-check`. The customer is holding a card
 * up to the camera and the agent has said so; this establishes that the agent is
 * entitled to ask, and passes the request to the AI service.
 *
 * **What it does not do is the interesting part.** It does not capture an image,
 * receive one, or hold one. The frames are already in the AI service (D23), so
 * this hop carries a session id and a document type. It also does not wait for
 * the answer: the result comes back on the socket the HUD already uses (T31), so
 * an agent's HTTP request is never held open across an OCR read and an external
 * registry lookup.
 *
 * **Nothing here can fail a call.** An AI service that is down, slow, or has no
 * analysis for this session all produce `accepted: false` and a 200. That is
 * D6 and T32's property applied to a new trigger: the verification carries on
 * without AI, and the agent decides on what they can see.
 *
 * **The AI still decides nothing (I7).** A `VERIFIED` document is a signal on a
 * panel. No transition, no checklist item and no verdict is gated on it.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DocumentCheckResult, DocumentType } from '@vcip/shared';
import { DomainError, ErrorCode, SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import type { DocumentReader } from '../ai/ai-document.client.js';
import { InjectDocumentReader } from '../ai/ai-document.client.js';
import type { AiConfig } from '../ai/ai.config.js';
import { InjectAiConfig } from '../ai/ai.config.js';
import type { AgentActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';

/**
 * How often one agent may ask for the same session, in milliseconds.
 *
 * A document read decodes a frame burst and calls an external registry, and the
 * button is the kind a person presses again when nothing has visibly happened
 * yet. Without a floor, an agent tapping four times sends four registry lookups
 * for one card — which costs money on a metered API and tells them nothing new.
 *
 * Deliberately short. This is a guard against a double-press, not a rate limit:
 * an agent who genuinely wants to retry after asking the customer to reposition
 * the card is several seconds away already.
 */
export const DOCUMENT_CHECK_COOLDOWN_MS = 3_000;

export type DocumentClock = () => Date;

export const DOCUMENT_CLOCK = Symbol('DOCUMENT_CLOCK');

@Injectable()
export class AgentDocumentService {
  private readonly now: DocumentClock;

  /**
   * When each session was last checked, for the cooldown above.
   *
   * In memory, and that is the right scope: it guards a double-press from one
   * agent on one screen, which is a property of the process handling their
   * requests. Redis would make it exact across instances and would also make a
   * button press depend on Redis being up, which is a bad trade for a guard
   * whose failure mode is one extra lookup.
   */
  private readonly lastCheck = new Map<string, number>();

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectDocumentReader() private readonly reader: DocumentReader,
    @InjectAiConfig() private readonly config: AiConfig,
    private readonly scope: TenantScope,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(DOCUMENT_CLOCK) now?: DocumentClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  async check(
    actor: AgentActor,
    sessionId: string,
    documentType: DocumentType,
  ): Promise<DocumentCheckResult> {
    setContextSession(sessionId);

    const session = this.scope.assertOwnership(
      actor,
      await this.sessions.findForMediaToken(actor.tenantId, sessionId),
    );

    this.requireOwnCall(actor, session.agentId, session.status, sessionId);

    if (!this.config.enabled) {
      // Configured off. Reported the same way an absent analyzer is, because
      // from the agent's side they are the same fact: no AI on this call.
      return this.refused(sessionId, documentType, 'ai_disabled');
    }

    if (this.tooSoon(sessionId)) {
      return this.refused(sessionId, documentType, 'cooldown');
    }

    try {
      const outcome = await this.reader.read(sessionId, documentType);
      this.lastCheck.set(sessionId, this.now().getTime());

      this.logger.info(
        {
          event: 'agent.document.requested',
          tenant_id: actor.tenantId,
          agent_id: actor.userId,
          session_id: sessionId,
          document_type: documentType,
          accepted: outcome.accepted,
        },
        'an agent asked for a document check',
      );

      return { session_id: sessionId, document_type: documentType, accepted: outcome.accepted };
    } catch (error) {
      // The AI service is down, slow, or refused. Never the call's problem, and
      // never a 500 at an agent who pressed a button: they are told the check
      // did not run and carry on.
      this.logger.warn(
        { event: 'agent.document.unreachable', session_id: sessionId, err: error },
        'the AI service could not be asked for a document check',
      );
      return { session_id: sessionId, document_type: documentType, accepted: false };
    }
  }

  /** Answer "not run" without going anywhere, and say why in the log only. */
  private refused(
    sessionId: string,
    documentType: DocumentType,
    reason: string,
  ): DocumentCheckResult {
    this.logger.info(
      { event: 'agent.document.not_requested', session_id: sessionId, reason },
      'a document check was not forwarded',
    );
    return { session_id: sessionId, document_type: documentType, accepted: false };
  }

  private tooSoon(sessionId: string): boolean {
    const last = this.lastCheck.get(sessionId);
    if (last === undefined) return false;
    return this.now().getTime() - last < DOCUMENT_CHECK_COOLDOWN_MS;
  }

  /**
   * The agent must be on this call.
   *
   * Status before assignment, the same order `AgentVerdictService` uses: an
   * agent asking about a `QUEUED` session is told the state is wrong, which
   * reveals nothing, rather than being told it belongs to somebody else — a
   * statement about a session they have no relationship with.
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
        'A document can only be checked during a call.',
      );
    }

    if (assignedAgentId !== actor.userId) {
      this.logger.warn(
        {
          event: 'agent.document.not_assigned',
          tenant_id: actor.tenantId,
          agent_id: actor.userId,
          session_id: sessionId,
        },
        'an agent tried to check a document on a session they do not hold',
      );
      throw new DomainError(ErrorCode.FORBIDDEN, 'This session is not assigned to you.');
    }
  }
}
