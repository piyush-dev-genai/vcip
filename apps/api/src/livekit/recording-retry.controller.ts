/**
 * The one externally reachable way to run a recording retry pass (T28).
 *
 * The same two reasons the offer and call sweepers have routes: proving "a call
 * whose recording failed gets one" by sleeping past a ten-second interval is a
 * slow test that fails on a loaded machine, and an operator who has just
 * restarted the egress container wants the recovery now rather than at the next
 * tick.
 *
 * `InternalTokenGuard` and nothing else (D10). The pass acts across every
 * tenant, so no tenant-scoped credential could be authorised for it.
 *
 * Counts only in the response. Which sessions are missing a recording is not
 * something an operations endpoint should enumerate.
 */

import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import type { RecordingRetryResult } from './recording-retry.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { RecordingRetrySweeper } from './recording-retry.service.js';

@Controller('internal/recordings')
export class RecordingRetryController {
  constructor(private readonly sweeper: RecordingRetrySweeper) {}

  /**
   * Run one pass now.
   *
   * Naturally idempotent: a session that started recording no longer matches
   * the query, and `RecordingService` refuses to start a second recording for a
   * session that already has one.
   */
  @Post('retry')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  async retry(): Promise<ApiData<RecordingRetryResult>> {
    return data(await this.sweeper.sweep());
  }
}
