/**
 * Trying again for calls that are under way with nothing recording them (T28).
 *
 * The third sweeper in this codebase, and the same shape as the other two: a
 * timer nobody calls, a bounded batch per pass, and an internal route kept for
 * deterministic testing and for operations.
 *
 * It exists because the alternative to retrying is losing the evidence for
 * every call that began while the egress container was restarting. A recording
 * that starts late is imperfect — the file misses the opening of the
 * conversation — but a file that covers most of a verification is worth more
 * than none, and `EGRESS_FAILED` stays in the log to say the start was not
 * clean.
 *
 * The pass is naturally self-limiting. A session qualifies only while it is
 * `IN_CALL` with a `CALL_STARTED` and no `EGRESS_STARTED`, so a call that ends
 * stops being retried, and a call that starts recording drops out on the next
 * pass. Nothing needs a counter.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { RecordingService } from './recording.service.js';
import { RecordingOutcome } from './recording.service.js';
import { RECORDING_RETRY_BATCH, RECORDING_RETRY_INTERVAL_MS } from './recording.rules.js';

/** What one pass did. Counts only — no identifiers. */
export interface RecordingRetryResult {
  /** Calls found running with nothing recording them. */
  readonly found: number;
  /** Recordings this pass got going. */
  readonly started: number;
  /** Still failing. They will be tried again while the call lasts. */
  readonly failed: number;
}

/** Whether the interval runs. Off in tests, which trigger passes explicitly. */
export const RECORDING_RETRY_ENABLED = Symbol('RECORDING_RETRY_ENABLED');

@Injectable()
export class RecordingRetrySweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    private readonly recording: RecordingService,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(RECORDING_RETRY_ENABLED) enabled?: boolean,
  ) {
    if (enabled === true) this.start();
  }

  private start(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error(
          { event: 'recording.retry.failed', err: error },
          'a recording retry pass failed',
        );
      });
    }, RECORDING_RETRY_INTERVAL_MS);
    // Never hold the process open for a recovery pass.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<RecordingRetryResult> {
    const stalled = await this.sessions.findUnrecordedCalls(RECORDING_RETRY_BATCH);

    let started = 0;
    let failed = 0;

    for (const call of stalled) {
      const outcome = await this.recording.start(call.id, call.tenantId, call.roomName);
      if (outcome === RecordingOutcome.STARTED) started += 1;
      // ALREADY_RUNNING means another pass or the original attempt won the
      // race; that is a success, not a failure, and is simply not counted.
      else if (outcome === RecordingOutcome.FAILED || outcome === RecordingOutcome.NO_ROOM) {
        failed += 1;
      }
    }

    if (stalled.length > 0) {
      this.logger.info(
        { event: 'recording.retry.pass', found: stalled.length, started, failed },
        'recording retry pass complete',
      );
    }

    return { found: stalled.length, started, failed };
  }
}
