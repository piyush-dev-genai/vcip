/**
 * Receiving an AI result (T30).
 *
 * The AI service reports what it found every couple of seconds. T30 takes
 * delivery and validates it; T31 is what makes it visible, writing the HUD to
 * Redis and publishing `ai.updated` to the agent's WebSocket.
 *
 * What this deliberately does **not** do, now or in T31:
 *
 *   - Touch `sessions.status`. A result is a signal, never a transition (I7).
 *   - Write `session_ai_summaries`. That row is the snapshot taken inside the
 *     verdict transaction (T35), not a running log of every two-second update
 *     — §20 is explicit that the summary is a snapshot and not a stream.
 *   - Fail loudly on a result for a session that is over. A call ends while
 *     the analyzer is mid-cycle almost every time; treating that as an error
 *     would make a normal race look like a fault.
 */

import { Injectable } from '@nestjs/common';
import type { AiResultRequest } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';

/** What the Control API did with a result. */
export const AiResultOutcome = {
  ACCEPTED: 'ACCEPTED',
  /** The session is not one this deployment knows. */
  UNKNOWN_SESSION: 'UNKNOWN_SESSION',
} as const;

export type AiResultOutcome = (typeof AiResultOutcome)[keyof typeof AiResultOutcome];

export interface AiResultReceipt {
  readonly outcome: AiResultOutcome;
}

@Injectable()
export class AiResultService {
  constructor(@InjectLogger() private readonly logger: Logger) {}

  /**
   * Take delivery of one result.
   *
   * Returns rather than throws for an unrecognised session: the AI service
   * cannot do anything useful with an error, and retrying would send the same
   * result to the same place. The log line is for us.
   */
  async receive(result: AiResultRequest): Promise<AiResultReceipt> {
    this.logger.debug(
      {
        event: 'ai.result_received',
        session_id: result.session_id,
        liveness_status: result.liveness_status,
        ocr_status: result.ocr_status,
        // The scores are logged and the payload is not: `model_versions` is
        // free-form JSON from another service, and a log line is not the place
        // to find out what somebody put in it.
        liveness_score: result.liveness_score,
        face_match_score: result.face_match_score,
      },
      'AI result received',
    );

    // T31 writes the HUD and publishes `ai.updated` from here.
    return { outcome: AiResultOutcome.ACCEPTED };
  }
}
