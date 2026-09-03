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
import { DocumentCheckRefusal, DomainError, ErrorCode, SessionStatus } from '@vcip/shared';
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

export type DocumentClock = () => Date;

export const DOCUMENT_CLOCK = Symbol('DOCUMENT_CLOCK');

@Injectable()
export class AgentDocumentService {
  private readonly now: DocumentClock;

  /**
   * The sessions with a check in flight.
   *
   * A double-press must not fire two registry lookups for one card — that costs
   * money on a metered API and tells the agent nothing new. But the guard is
   * "one at a time", not "one every N seconds": once an answer is on screen, a
   * retry is a deliberate act, and `UNREADABLE` is answered precisely by asking
   * the customer to reposition the card and checking again.
   *
   * The first version used a three-second window after the last check, and it
   * refused exactly the retry it should have allowed — the mock answers
   * instantly, so an agent who read "could not read" and immediately tried
   * again was turned away.
   *
   * In memory, and that is the right scope: it guards one agent's screen
   * against itself, which is a property of the process handling their requests.
   * Redis would make it exact across instances and would also make a button
   * press depend on Redis being up, a bad trade for a guard whose failure mode
   * is one extra lookup.
   */
  private readonly inFlight = new Set<string>();

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
      return this.refused(sessionId, documentType, DocumentCheckRefusal.AI_DISABLED);
    }

    if (this.inFlight.has(sessionId)) {
      return this.refused(sessionId, documentType, DocumentCheckRefusal.IN_PROGRESS);
    }

    this.inFlight.add(sessionId);
    try {
      const outcome = await this.reader.read(sessionId, documentType);

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

      return {
        session_id: sessionId,
        document_type: documentType,
        accepted: outcome.accepted,
        // The AI service answered, and said it had no analysis for this call.
        reason: outcome.accepted ? null : DocumentCheckRefusal.NO_ANALYSIS,
      };
    } catch (error) {
      // The AI service is down, slow, or refused. Never the call's problem, and
      // never a 500 at an agent who pressed a button: they are told the check
      // did not run and carry on.
      this.logger.warn(
        { event: 'agent.document.unreachable', session_id: sessionId, err: error },
        'the AI service could not be asked for a document check',
      );
      return this.refused(sessionId, documentType, DocumentCheckRefusal.UNREACHABLE);
    } finally {
      // Released on every path, including the throw above. A session left in
      // this set would be permanently unable to check a document again, which
      // is a worse failure than the duplicate lookup the set exists to prevent.
      this.inFlight.delete(sessionId);
    }
  }

  /**
   * Answer "not run", and say precisely why.
   *
   * The reason travels to the portal rather than only to the log. It used not
   * to, and the cost was immediate: the panel showed "No AI on this call" for
   * every refusal, so an agent who pressed the button twice was told the AI was
   * missing while it was working perfectly — and the previous result was still
   * on screen beside it, contradicting the message.
   */
  private refused(
    sessionId: string,
    documentType: DocumentType,
    reason: DocumentCheckRefusal,
  ): DocumentCheckResult {
    this.logger.info(
      { event: 'agent.document.not_requested', session_id: sessionId, reason },
      'a document check was not forwarded',
    );
    return { session_id: sessionId, document_type: documentType, accepted: false, reason };
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
