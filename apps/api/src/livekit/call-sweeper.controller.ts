/**
 * The one externally reachable way to run a call sweep (T26).
 *
 * The same two reasons `OfferSweeperController` exists, and the same answer to
 * "why does a timer need a route": proving "a customer who does not come back
 * is dropped and billed once" by sleeping past an interval is a slow test that
 * fails on a loaded machine, and when something is stuck an operator wants to
 * run the recovery now and see what it did.
 *
 * `InternalTokenGuard` and nothing else (D10) — unlike the webhook beside it,
 * this route has a caller we control, so the shared credential applies
 * normally. The sweep acts across every tenant, so no tenant-scoped credential
 * could be authorised for it.
 *
 * Counts only in the response. Which sessions ended is not something an
 * operations endpoint should enumerate.
 */

import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import type { CallSweepResult } from './call-sweeper.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { CallSweeper } from './call-sweeper.service.js';

@Controller('internal/calls')
export class CallSweeperController {
  constructor(private readonly sweeper: CallSweeper) {}

  /**
   * Run one pass now.
   *
   * Naturally idempotent: a second pass finds the sessions already terminal, so
   * every guarded UPDATE matches nothing and nothing is billed twice.
   */
  @Post('sweep')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  async sweep(): Promise<ApiData<CallSweepResult>> {
    return data(await this.sweeper.sweep());
  }
}
