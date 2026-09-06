/**
 * Starting the evidence recording (T28, R17).
 *
 * **When.** The moment both participants are in the room — the same moment T26
 * appends `CALL_STARTED`. The plan calls this task "recording start on accept",
 * and that is not implementable: at accept nobody has joined, so the room does
 * not exist and LiveKit answers `requested room does not exist`. Design §21.2
 * already says recording starts "when the actual call begins", and that is what
 * happens. Recording from the first arrival instead would open every file with
 * however long one party waited alone.
 *
 * **What is recorded about it.** The egress id, in the `EGRESS_STARTED` event
 * payload. No column: D18 and D25 both refused one for exactly this kind of
 * in-flight fact, and T38 reads the id back from the log. A failure gets
 * `EGRESS_FAILED` — added to the catalogue for this, because "the recording
 * never started" and "the recording is still running" must not look the same to
 * an auditor asking where the video is.
 *
 * **What it never does.** Fail the call. A verification whose recording could
 * not start is still a verification: the agent's verdict stands, billing is
 * unaffected, and T46 is what eventually tells the enterprise that no evidence
 * exists. Blocking would punish the customer for an infrastructure fault — and
 * there is nothing to block anyway, since this runs from a webhook after both
 * parties are already talking.
 *
 * **Stopping is not here.** Room-composite egress ends when the room does, and
 * `infra/livekit.yaml` closes an empty room after `empty_timeout`. Nothing in
 * this codebase calls `stopEgress`.
 */

import { Injectable } from '@nestjs/common';
import { SessionEventType } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
import type { RecordingStarter } from './recording.client.js';
import { InjectRecordingStarter } from './recording.client.js';
import type { RecordingConfig } from './recording.config.js';
import { InjectRecordingConfig } from './recording.config.js';

/** What one attempt did, for the retry pass and for tests. */
export const RecordingOutcome = {
  STARTED: 'STARTED',
  FAILED: 'FAILED',
  /** Already recording. A second attempt must not open a second file. */
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  /** No room name on the row, so there is nothing to address. */
  NO_ROOM: 'NO_ROOM',
  /**
   * `RECORDING_ENABLED=false`. Not a failure and not recorded as one.
   *
   * Distinct from `FAILED` on purpose: nothing went wrong, so no
   * `EGRESS_FAILED` is appended. An auditor reading the log of a Core-MVP
   * deployment should find no evidence events at all, rather than a failure
   * for every call that says the recording broke when it was never asked for.
   */
  DISABLED: 'DISABLED',
} as const;

export type RecordingOutcome = (typeof RecordingOutcome)[keyof typeof RecordingOutcome];

@Injectable()
export class RecordingService {
  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectRecordingStarter() private readonly starter: RecordingStarter,
    @InjectRecordingConfig() private readonly config: RecordingConfig,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /**
   * Start recording one session's room.
   *
   * Guarded on `EGRESS_STARTED` not already being present, so a retry pass that
   * races the original attempt cannot open a second recording of the same call.
   * PostgreSQL answers that, not Redis: whether a call was ever recorded is
   * durable history, and the answer has to survive a restart.
   */
  async start(
    sessionId: string,
    tenantId: string,
    roomName: string | null,
  ): Promise<RecordingOutcome> {
    // First, and before the room-name check: a deployment that is not
    // recording should not log an error about a session it was never going to
    // record. The retry sweeper is off for the same reason (`livekit.module`),
    // so this is the guard for the one call the webhook makes directly.
    if (!this.config.enabled) return RecordingOutcome.DISABLED;

    if (roomName === null) {
      this.logger.error(
        { event: 'recording.no_room', session_id: sessionId, tenant_id: tenantId },
        'cannot record a session with no room name',
      );
      return RecordingOutcome.NO_ROOM;
    }

    if (await this.sessions.hasEvent(sessionId, SessionEventType.EGRESS_STARTED)) {
      return RecordingOutcome.ALREADY_RUNNING;
    }

    let started;
    try {
      started = await this.starter.start(roomName, sessionId);
    } catch (error) {
      await this.recordFailure(sessionId, error);
      return RecordingOutcome.FAILED;
    }

    // The id is the whole point of the event: T38 has no other way to find the
    // file, and the row carries no column for it.
    await this.sessions.appendCallEvent(sessionId, {
      type: SessionEventType.EGRESS_STARTED,
      actorType: 'SYSTEM',
      actorId: null,
      payload: {
        egress_id: started.egressId,
        room_name: roomName,
        video_key: started.key,
      },
    });

    this.logger.info(
      {
        event: 'recording.started',
        session_id: sessionId,
        tenant_id: tenantId,
        egress_id: started.egressId,
      },
      'evidence recording started',
    );

    return RecordingOutcome.STARTED;
  }

  /**
   * Record that a start failed — once.
   *
   * The retry pass will try again every few seconds for the length of the call,
   * and an event per attempt would bury the session's real history under
   * identical rows. One `EGRESS_FAILED` says the recording did not start; the
   * log carries every attempt.
   */
  private async recordFailure(sessionId: string, error: unknown): Promise<void> {
    this.logger.error(
      { event: 'recording.start_failed', session_id: sessionId, err: error },
      'could not start the evidence recording',
    );

    if (await this.sessions.hasEvent(sessionId, SessionEventType.EGRESS_FAILED)) return;

    await this.sessions.appendCallEvent(sessionId, {
      type: SessionEventType.EGRESS_FAILED,
      actorType: 'SYSTEM',
      actorId: null,
      // The message, not the object: an SDK error can carry a request that
      // includes the storage credentials this call was configured with.
      payload: { reason: error instanceof Error ? error.message : 'unknown' },
    });
  }
}
