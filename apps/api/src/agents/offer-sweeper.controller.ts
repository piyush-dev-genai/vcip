/**
 * The one externally reachable way to run an offer sweep (T20).
 *
 * A route exists for two reasons, and neither is that the sweeper needs one:
 * the interval inside `OfferSweeper` is what runs in production.
 *
 *   1. **Determinism in tests and verification.** Proving "an expired offer
 *      returns to the queue, unbilled" by sleeping past a timer is a slow test
 *      that fails on a loaded machine. Triggering a pass and asserting on its
 *      result is neither.
 *   2. **Operations.** When something is stuck, being able to run the recovery
 *      immediately — and see what it did — beats restarting a process.
 *
 * `InternalTokenGuard` and nothing else (D10). There is no agent, customer, or
 * enterprise credential that reaches this: the sweep acts across every tenant,
 * so no tenant-scoped caller could be authorised for it in the first place, and
 * an internal actor deliberately carries no tenant.
 *
 * The response is counts only. Session ids and agent ids are not this
 * endpoint's business, and a sweep report is not a route through which to
 * enumerate them.
 */

import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import type { SweepResult } from './offer-sweeper.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { OfferSweeper } from './offer-sweeper.service.js';

@Controller('internal/offers')
export class OfferSweeperController {
  constructor(private readonly sweeper: OfferSweeper) {}

  /**
   * Run one pass now.
   *
   * No `Idempotency-Key`: the sweep is naturally idempotent. Running it twice
   * expires the same offers once, because the second pass finds them already
   * `QUEUED` — which is the same property that lets several instances run it
   * concurrently.
   */
  @Post('sweep')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  async sweep(): Promise<ApiData<SweepResult>> {
    return data(await this.sweeper.sweep());
  }
}
