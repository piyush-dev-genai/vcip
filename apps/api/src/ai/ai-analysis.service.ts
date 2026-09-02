/**
 * Starting the AI analysis of a call (T30, D23).
 *
 * **When.** The moment both participants are in the room — the same
 * `CALL_STARTED` that starts the evidence recording (T28). Not at accept: at
 * accept nobody has joined, so there is no room to subscribe to and no
 * customer video to analyse. Not at the customer's arrival either: the room
 * exists then, but analysing a customer sitting alone spends a core on frames
 * nobody is going to be shown the results of.
 *
 * **What it hands over.** A room name and a LiveKit token this API mints, both
 * server-derived. The AI service holds no database, no Redis, and no LiveKit
 * signing key (§5), so a request that did not carry them would have the
 * analyzer either querying for state it must not hold or minting credentials
 * it must not be able to mint.
 *
 * **What it never does.** Fail the call. Every failure below is caught, logged,
 * recorded once as `AI_UNAVAILABLE`, and dropped. AI is assistive (D6): a
 * verification whose HUD is blank is still a verification, the agent still
 * submits the verdict, and the only thing lost is a signal that was never
 * allowed to decide anything (I7).
 */

import { Injectable } from '@nestjs/common';
import { SessionEventType } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { LiveKitConfig } from '../livekit/livekit.config.js';
import { InjectLiveKitConfig } from '../livekit/livekit.config.js';
import type { MediaTokenMinter } from '../livekit/media-token.minter.js';
import { InjectMediaTokenMinter } from '../livekit/media-token.minter.js';
import { MediaRole } from '../livekit/media-token.rules.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
import type { AiConfig } from './ai.config.js';
import { InjectAiConfig } from './ai.config.js';
import type { AnalysisStarter } from './ai-analysis.client.js';
import { InjectAnalysisStarter } from './ai-analysis.client.js';

/** What one attempt did. Reported for tests and for the log line. */
export const AiAnalysisOutcome = {
  STARTED: 'STARTED',
  /** `AI_ENABLED=false`. Not a failure and not recorded as one. */
  DISABLED: 'DISABLED',
  /** No room name on the row, so there is nothing to point the analyzer at. */
  NO_ROOM: 'NO_ROOM',
  /** The AI service refused or could not be reached. */
  FAILED: 'FAILED',
} as const;

export type AiAnalysisOutcome = (typeof AiAnalysisOutcome)[keyof typeof AiAnalysisOutcome];

@Injectable()
export class AiAnalysisService {
  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectMediaTokenMinter() private readonly minter: MediaTokenMinter,
    @InjectAnalysisStarter() private readonly starter: AnalysisStarter,
    @InjectAiConfig() private readonly config: AiConfig,
    @InjectLiveKitConfig() private readonly livekit: LiveKitConfig,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /**
   * Ask the AI service to analyse this call.
   *
   * Unguarded against duplicates on this side on purpose. The AI service
   * already refuses to start a second analysis for a session it is analysing,
   * and it is the only party that knows whether one is still running — a guard
   * here would be a second, staler opinion about the same fact.
   */
  async start(
    sessionId: string,
    tenantId: string,
    roomName: string | null,
  ): Promise<AiAnalysisOutcome> {
    if (!this.config.enabled) return AiAnalysisOutcome.DISABLED;

    if (roomName === null) {
      this.logger.error(
        { event: 'ai.no_room', session_id: sessionId, tenant_id: tenantId },
        'cannot analyse a session with no room name',
      );
      return AiAnalysisOutcome.NO_ROOM;
    }

    try {
      const token = await this.minter.mint({
        // Subscribe-only and hidden. `grantsFor` is where that is decided and
        // where the reasons are written down.
        role: MediaRole.ANALYZER,
        roomName,
        sessionId,
        tenantId,
        // No user. The analyzer is not a person, and `user_id` in the
        // participant metadata is the agent's id or nothing.
        userId: null,
        ttlSeconds: this.livekit.tokenTtlSeconds,
      });

      await this.starter.start(sessionId, {
        room_name: roomName,
        token,
        livekit_url: this.livekit.url,
      });
    } catch (error) {
      await this.recordUnavailable(sessionId, error);
      return AiAnalysisOutcome.FAILED;
    }

    this.logger.info(
      { event: 'ai.analysis_started', session_id: sessionId, tenant_id: tenantId },
      'AI analysis requested',
    );

    return AiAnalysisOutcome.STARTED;
  }

  /**
   * Record that this call has no AI — once.
   *
   * `AI_UNAVAILABLE` is already in the event catalogue, which is the right
   * name: from the agent's side and from an auditor's, "the analyzer never
   * started" and "the analyzer started and the model was down" are the same
   * fact, and the payload distinguishes them for anyone who cares.
   *
   * Once, for the reason `EGRESS_FAILED` is written once: this is not a
   * terminal condition and nothing retries it today, but a session's history
   * should not be padded with identical rows if something ever does.
   */
  private async recordUnavailable(sessionId: string, error: unknown): Promise<void> {
    this.logger.warn(
      { event: 'ai.start_failed', session_id: sessionId, err: error },
      'could not start AI analysis; the call continues without it',
    );

    if (await this.sessions.hasEvent(sessionId, SessionEventType.AI_UNAVAILABLE)) return;

    await this.sessions.appendCallEvent(sessionId, {
      type: SessionEventType.AI_UNAVAILABLE,
      actorType: 'SYSTEM',
      actorId: null,
      // The message, not the error: a fetch failure stringifies with the
      // request it failed on, and that request carried a LiveKit join token
      // and the internal credential.
      payload: { reason: error instanceof Error ? error.message : 'unknown' },
    });
  }
}
