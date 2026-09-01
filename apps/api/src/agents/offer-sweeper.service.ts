/**
 * Returning lapsed offers to the queue (T20).
 *
 * D4 gives an agent an exclusive window on a session and says nothing happens
 * automatically if they walk away. Without this, that is literally true: the
 * session stays `OFFERED` for ever, the customer waits for ever, the agent's
 * `max_concurrent` stays consumed, and the row is invisible to every view in
 * the product. This is the only component that can recover it.
 *
 * **Three properties, in the order they matter.**
 *
 * 1. *It is safe to run everywhere at once.* The sweep is one conditional
 *    `UPDATE ... RETURNING`, so a row is taken by exactly one instance and a
 *    second sweeper simply gets nothing back for it. No leader election, no
 *    advisory lock, no configuration that has to be right.
 * 2. *It cannot lose a race with an accept.* Both act on `status = 'OFFERED'`,
 *    so PostgreSQL serialises them; and the predicates are complementary —
 *    accept requires `offer_expires_at > now`, the sweep requires `<= now` —
 *    so a single clock reading can satisfy only one of them.
 * 3. *It frees the agent.* `BUSY` is a Redis status on a key the heartbeat
 *    keeps refreshing, so an agent whose offer lapsed would otherwise stay
 *    `BUSY` indefinitely and never be offered work again. This is the first
 *    caller of `markAvailable`, and the reason that method existed unused.
 *
 * **It is not tenant-scoped, and that is not an I8 exception to argue about.**
 * Invariant I8 constrains what a *caller* may reach; a sweeper has no caller
 * and acts as the system. No route reaches this class, and the only externally
 * triggerable path is the internal-token endpoint the controller exposes for
 * tests and operations.
 *
 * **It writes nothing to Redis's queue.** T18 deliberately leaves the ZSET
 * member in place on claim, so a session returning to `QUEUED` is already
 * sitting at its original score — "preserving queue score" costs zero writes,
 * and the customer keeps the place they have been waiting in.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SessionEventType } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { ExpiredOfferRow, SessionRepository } from '../sessions/session.repository.js';
import type { Notifications } from '../realtime/notifications.js';
import { InjectNotifications } from '../realtime/notifications.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { PresenceService } from './presence.service.js';

/**
 * How often a pass runs.
 *
 * Well below the 30-second default offer window, so an abandoned offer comes
 * back while the customer is still plausibly waiting rather than after they
 * have given up. A server constant: nothing a client sends can change it.
 */
export const SWEEP_INTERVAL_MS = 5_000;

/**
 * How many offers one pass may return.
 *
 * A bound, not a target. It keeps a single statement proportional to the batch
 * rather than to however many offers lapsed while the process was down, and
 * the next pass five seconds later takes the rest.
 */
export const SWEEP_BATCH = 100;

/** What one pass did. Counts only — no session ids leave this service. */
export interface SweepResult {
  readonly expired: number;
  readonly freed: number;
}

export type SweepClock = () => Date;

export const OFFER_SWEEP_CLOCK = Symbol('OFFER_SWEEP_CLOCK');

/**
 * Whether the timer starts.
 *
 * Off by default in tests: a background timer that fires between cases makes
 * failures depend on wall-clock timing. The application module turns it on.
 */
export const OFFER_SWEEP_ENABLED = Symbol('OFFER_SWEEP_ENABLED');

@Injectable()
export class OfferSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly now: SweepClock;
  private timer: NodeJS.Timeout | null = null;
  /** One pass at a time within a process; overlapping passes help nobody. */
  private running = false;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    private readonly presence: PresenceService,
    @InjectNotifications() private readonly notify: Notifications,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(OFFER_SWEEP_ENABLED) private readonly enabled: boolean = false,
    @Optional() @Inject(OFFER_SWEEP_CLOCK) now?: SweepClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    // Never hold the process open for a sweep that can wait for the next boot.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass, and the only method worth calling directly.
   *
   * Returns counts so an operator or a test can see what happened. It is
   * deliberately callable while the timer is also running: the statement makes
   * concurrent passes safe, so there is nothing to guard against.
   */
  async sweep(): Promise<SweepResult> {
    const expired = await this.sessions.expireOffers({
      now: this.now(),
      limit: SWEEP_BATCH,
      // Not `SESSION_QUEUED`: the audit trail has to distinguish a customer
      // joining the queue from an offer lapsing, which is the whole reason
      // this name was added to the shared vocabulary.
      eventType: SessionEventType.OFFER_EXPIRED,
    });

    if (expired.length === 0) return { expired: 0, freed: 0 };

    const freed = await this.free(expired);
    await this.announce(expired);

    this.logger.info(
      { event: 'offer.sweep', expired_count: expired.length, freed_count: freed },
      'returned expired offers to the queue',
    );

    return { expired: expired.length, freed };
  }

  /**
   * Return each agent whose offer lapsed to the available pool.
   *
   * Best-effort and individually guarded, exactly as the claim's `BUSY` write
   * is. PostgreSQL has already committed the sessions back to the queue; a
   * Redis failure here must not undo that or stop the remaining agents being
   * freed. An agent whose presence had already expired is not an error — they
   * are not at their desk, which is the state we wanted anyway.
   */
  /**
   * Tell each agent that the offer they were holding has gone.
   *
   * The sweeper already decided; this reports it. An agent whose portal is open
   * on the offer screen would otherwise wait out its own countdown and then ask
   * — which works, and is two seconds slower than being told.
   */
  private async announce(expired: readonly ExpiredOfferRow[]): Promise<void> {
    for (const row of expired) {
      if (row.agentId === null) continue;
      await this.notify.sessionOfferExpired(row.tenantId, row.agentId, row.id);
    }
  }

  private async free(expired: readonly ExpiredOfferRow[]): Promise<number> {
    const agents = new Set(
      expired.map((row) => row.agentId).filter((id): id is string => id !== null),
    );

    let freed = 0;
    for (const agentId of agents) {
      try {
        if (await this.presence.markAvailable(agentId)) freed += 1;
      } catch (error) {
        this.logger.error(
          { event: 'offer.sweep.presence_failed', agent_id: agentId, err: error },
          'offer returned to the queue but the agent presence could not be freed',
        );
      }
    }
    return freed;
  }

  /** The timer's callback. A failed pass is logged, never thrown into the loop. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error({ event: 'offer.sweep.failed', err: error }, 'offer sweep failed');
    } finally {
      this.running = false;
    }
  }
}
