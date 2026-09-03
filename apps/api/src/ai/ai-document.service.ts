/**
 * Receiving a document-check result, and getting it in front of the agent.
 *
 * ```text
 * AI service -> /internal/ai/document-result -> Redis HUD -> pub/sub -> WS -> HUD
 * ```
 *
 * The same three steps as `AiResultService`, deliberately: store, resolve who
 * to tell, publish. A document check arriving on its own transport with its own
 * panel would be a second source of truth the agent has to reconcile, so it
 * lands on the HUD the agent is already watching.
 *
 * **What differs, and why.**
 *
 * The write is partial. `saveDocument` touches three fields of a hash the
 * sampled result also writes, and the merged state comes back from the same
 * round trip — so what is published is what is stored, and neither writer can
 * blank the other.
 *
 * A missed publish matters more here. A sampled result is one of hundreds and
 * the next arrives in two seconds; this one is the answer to a button an agent
 * pressed and is watching a spinner for. It is still best-effort — nothing on
 * this path may fail the AI service's request (D6) — but it is logged at a
 * level somebody will see rather than shrugged off.
 *
 * **Nothing here carries the document.** The request schema has no field for
 * it, so there is nothing to redact: this service handles a type, a status and
 * a reason token. See `packages/shared/src/api/document.ts`.
 */

import { Injectable } from '@nestjs/common';
import type { DocumentResultRequest } from '@vcip/shared';
import { SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { Notifications } from '../realtime/notifications.js';
import { InjectNotifications } from '../realtime/notifications.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
import type { AiHudRepository } from './ai-hud.repository.js';
import { InjectAiHudRepository } from './ai-hud.repository.js';

/** What the Control API did with a document result. Mirrors `AiResultOutcome`. */
export const DocumentResultOutcome = {
  /** Stored, and published to the agent on the call. */
  DELIVERED: 'DELIVERED',
  /** Stored, but nobody was there to tell. */
  STORED: 'STORED',
  /** The session is not one this deployment knows. */
  UNKNOWN_SESSION: 'UNKNOWN_SESSION',
} as const;

export type DocumentResultOutcome =
  (typeof DocumentResultOutcome)[keyof typeof DocumentResultOutcome];

export interface DocumentResultReceipt {
  readonly outcome: DocumentResultOutcome;
}

@Injectable()
export class AiDocumentService {
  constructor(
    @InjectAiHudRepository() private readonly hud: AiHudRepository,
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectNotifications() private readonly notify: Notifications,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async receive(
    result: DocumentResultRequest,
    now: Date = new Date(),
  ): Promise<DocumentResultReceipt> {
    const merged = await this.store(result, now);

    const session = await this.sessions.findForCallEvent(result.session_id);
    if (session === null) {
      this.logger.warn(
        { event: 'ai.document_unknown_session', session_id: result.session_id },
        'a document result named a session that does not exist',
      );
      return { outcome: DocumentResultOutcome.UNKNOWN_SESSION };
    }

    // The status, the type and the reason token are logged. There is nothing
    // else to log: the payload has no other fields.
    this.logger.info(
      {
        event: 'ai.document_checked',
        session_id: result.session_id,
        document_type: result.document_type,
        status: result.status,
        reason: result.reason ?? null,
      },
      'a document check was recorded',
    );

    if (session.status !== SessionStatus.IN_CALL || session.agentId === null) {
      return { outcome: DocumentResultOutcome.STORED };
    }

    if (merged === null) {
      // The write failed or the read-back was unusable, so there is no whole
      // HUD to send. Publishing the document fields alone would arrive at the
      // panel as a payload with no liveness status and blank the rest.
      this.logger.warn(
        { event: 'ai.document_not_published', session_id: result.session_id },
        'a document check was not published: the HUD could not be read back',
      );
      return { outcome: DocumentResultOutcome.STORED };
    }

    await this.notify.aiUpdated(session.tenantId, session.agentId, merged);

    return { outcome: DocumentResultOutcome.DELIVERED };
  }

  /** Store the check, and treat a failure as one. Never fails the request. */
  private async store(result: DocumentResultRequest, now: Date) {
    try {
      return await this.hud.saveDocument(
        result.session_id,
        result.document_type,
        result.status,
        // Server time, not the AI service's. The panel ages this field, and a
        // clock the caller controls is one an unreachable caller could have
        // left in the future — the same reasoning as `updated_at`.
        now.toISOString(),
      );
    } catch (error) {
      this.logger.error(
        { event: 'ai.document_write_failed', session_id: result.session_id, err: error },
        'could not store a document check; the agent will not see it',
      );
      return null;
    }
  }
}
