/**
 * Receiving an AI result, and getting it in front of the agent (T31).
 *
 * ```text
 * AI service -> /internal/ai/result -> Redis HUD -> pub/sub -> WS -> Agent HUD
 * ```
 *
 * Three steps, in this order and for this reason:
 *
 *   1. **Write the HUD.** It is the durable-enough copy (D2) and it is what
 *      T35 snapshots into `session_ai_summaries`. Writing it first means a
 *      result that arrives while nobody is connected is not lost — the agent's
 *      next connection is handed it (§38's "fetch the current state again",
 *      answered by the gateway rather than by a REST route).
 *   2. **Find out who to tell.** An agent's connection is scoped to tenant and
 *      user, not to a session, so a result carrying only a session id has to be
 *      resolved against PostgreSQL before it can be routed. That read is the
 *      only place this path touches the database, and it is a read: nothing
 *      about an AI result may write business state (I7).
 *   3. **Publish.** Best-effort, to exactly one agent.
 *
 * **The customer is never told.** R3 lists `ai.updated` as an agent event and
 * this service only ever names an agent channel. A customer being shown a
 * liveness score about themselves would be a privacy failure and an invitation
 * to argue with a machine that decides nothing (I7).
 *
 * **Nothing here can fail the AI service's request.** A Redis that will not
 * take the write and an agent nobody can find are both logged and answered
 * 200. The analyzer publishes a fresh snapshot every couple of seconds, so
 * there is nothing worth retrying and nothing worth queueing.
 */

import { Injectable } from '@nestjs/common';
import type { AiHudPayload, AiResultRequest } from '@vcip/shared';
import { SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { Notifications } from '../realtime/notifications.js';
import { InjectNotifications } from '../realtime/notifications.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
import type { AiHudRepository } from './ai-hud.repository.js';
import { InjectAiHudRepository } from './ai-hud.repository.js';

/** What the Control API did with a result. */
export const AiResultOutcome = {
  /** Stored, and published to the agent on the call. */
  DELIVERED: 'DELIVERED',
  /**
   * Stored, but nobody was told.
   *
   * The session ended, or no agent holds it. Not an error: a call ends while
   * the analyzer is mid-cycle almost every time, and the HUD is still worth
   * writing because T35 may yet snapshot it.
   */
  STORED: 'STORED',
  /** The session is not one this deployment knows. */
  UNKNOWN_SESSION: 'UNKNOWN_SESSION',
} as const;

export type AiResultOutcome = (typeof AiResultOutcome)[keyof typeof AiResultOutcome];

export interface AiResultReceipt {
  readonly outcome: AiResultOutcome;
}

export type AiClock = () => Date;

@Injectable()
export class AiResultService {
  constructor(
    @InjectAiHudRepository() private readonly hud: AiHudRepository,
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectNotifications() private readonly notify: Notifications,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async receive(result: AiResultRequest, now: Date = new Date()): Promise<AiResultReceipt> {
    // What gets published is what the store came back with, not what was sent.
    // The HUD has a second writer — the agent-triggered document check — and
    // publishing this result's own payload would carry its null document fields
    // and blank a status the agent asked for, every couple of seconds.
    const payload = await this.store(toHudPayload(result, now));

    const session = await this.sessions.findForCallEvent(result.session_id);
    if (session === null) {
      // A result for a session this deployment has never heard of. Logged
      // rather than raised: the AI service cannot do anything useful with an
      // error, and retrying would send the same result to the same place.
      this.logger.warn(
        { event: 'ai.result_unknown_session', session_id: result.session_id },
        'an AI result named a session that does not exist',
      );
      return { outcome: AiResultOutcome.UNKNOWN_SESSION };
    }

    if (session.status !== SessionStatus.IN_CALL || session.agentId === null) {
      // Nobody is watching. The HUD is written anyway — the verdict
      // transaction may still snapshot it — but there is no agent channel to
      // publish on, and inventing one would be a message to whoever held the
      // session last.
      return { outcome: AiResultOutcome.STORED };
    }

    await this.notify.aiUpdated(session.tenantId, session.agentId, payload);

    return { outcome: AiResultOutcome.DELIVERED };
  }

  /**
   * Store the HUD, and treat a failure as one.
   *
   * Redis being unavailable degrades the HUD and the eventual summary. It does
   * not degrade the call, and it must not stop the agent being told what the
   * AI just said — so the publish below happens either way.
   */
  private async store(payload: AiHudPayload): Promise<AiHudPayload> {
    try {
      return await this.hud.save(payload.session_id, payload);
    } catch (error) {
      this.logger.warn(
        { event: 'ai.hud_write_failed', session_id: payload.session_id, err: error },
        'could not store the AI HUD; the next result will try again',
      );
      // The agent is still told what the AI just said. Without the merged read
      // this carries null document fields, which is why the panel treats a null
      // document status as "no update" rather than as "no document check".
      return payload;
    }
  }
}

/**
 * The wire payload plus the instant we took delivery.
 *
 * Server time, not a timestamp the AI service chose. The agent's panel decides
 * the HUD has gone stale from this field, and a clock the caller controls is
 * one an unreachable caller could have left in the future.
 */
export function toHudPayload(result: AiResultRequest, now: Date): AiHudPayload {
  return {
    session_id: result.session_id,
    liveness_score: result.liveness_score,
    liveness_status: result.liveness_status,
    face_match_score: result.face_match_score,
    ocr_status: result.ocr_status,
    model_versions: result.model_versions,
    updated_at: now.toISOString(),
    // Null because a sampled result knows nothing about them, not because there
    // is no document check. `toHudFields` does not write these, so nulls here
    // never reach Redis — they exist only until the merged read replaces them.
    document_type: null,
    document_status: null,
    document_checked_at: null,
  };
}
