/**
 * The queue projection.
 *
 * Redis holds a *view* of which sessions are waiting; PostgreSQL holds the fact
 * (D1/D2). Every method here reads its authority from a `SessionRow` that came
 * from PostgreSQL and refuses to act on Redis membership alone. That asymmetry
 * is the entire design, and it is what lets the two disagree safely.
 *
 * They will disagree. A process can commit `CREATED -> QUEUED` and then die
 * before `ZADD`, or Redis can be briefly unreachable. The system's answer is
 * not to prevent the gap — nothing short of a distributed transaction could —
 * but to make it *self-healing and harmless*:
 *
 *   - **Harmless**, because a missing member yields `queue_position: null`,
 *     never a wrong number, and never a change to business state.
 *   - **Self-healing**, in two layers. A bounded retry covers the ordinary
 *     transient failure inside the request that caused it. Lazy reconciliation
 *     covers everything the retry cannot: whenever a queued session's position
 *     is asked for and the member is absent, it is re-added at its stored
 *     `queued_at`. That is what survives a crash, and it needs no outbox table,
 *     no worker, and no second source of truth.
 *
 * Reconciliation is gated on PostgreSQL status being exactly `QUEUED`. Nothing
 * else may be inserted: an `OFFERED` session was deliberately removed by a
 * claim (T18), and re-adding it would hand the same customer to a second agent.
 * The gate is a positive check on one status, not a list of exclusions, so a
 * status added later cannot leak through by omission.
 *
 * Nothing here throws for a Redis failure. A queue projection that can fail a
 * committed business operation is not a projection.
 */

import { Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { SessionStatus } from '@vcip/shared';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { SessionRow } from '../sessions/session.repository.js';
import { positionFromRank, queueKey, scoreFor } from './queue.keys.js';
import type { QueueRepository } from './queue.repository.js';
import { InjectQueueRepository } from './queue.repository.js';

/**
 * How hard to try before giving up and leaving it to reconciliation.
 *
 * Three attempts over ~200 ms. Bounded because this runs inside a request that
 * has already committed: the customer is waiting, and the durable outcome is
 * already correct. Failing fast and healing later beats holding the response.
 */
const RETRY_DELAYS_MS: readonly number[] = Object.freeze([0, 50, 150]);

const sleep = (ms: number): Promise<void> =>
  ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A session's queue placement, as far as Redis can currently say.
 *
 * `null` means "we cannot tell right now", never "not queued" and never
 * "position zero". The caller renders it as such; `sessions.status` remains the
 * only statement about whether the session is queued.
 */
export type QueuePosition = number | null;

@Injectable()
export class QueueService {
  constructor(
    @InjectQueueRepository() private readonly queue: QueueRepository,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /**
   * Place a freshly queued session into Redis.
   *
   * Called **after** the PostgreSQL transaction commits — never inside it. A
   * `ZADD` inside a transaction would be a write that cannot be rolled back
   * attached to one that can.
   *
   * Returns the position when Redis answered, or `null` when it did not. It
   * never throws: the session is already durably `QUEUED`, and no Redis outcome
   * can make that untrue.
   */
  async enqueue(session: SessionRow): Promise<QueuePosition> {
    if (session.queuedAt === null) {
      // A caller asking to enqueue a session with no `queued_at` is a bug: the
      // score would have to be invented, which is the one thing the ordering
      // guarantee forbids.
      this.logger.error(
        {
          event: 'queue.enqueue.no_queued_at',
          session_id: session.id,
          tenant_id: session.tenantId,
        },
        'refusing to enqueue a session with no queued_at',
      );
      return null;
    }

    const member = {
      tenantId: session.tenantId,
      language: session.language,
      sessionId: session.id,
    };
    const score = scoreFor(session.queuedAt);

    for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
      await sleep(delay);
      try {
        // Same member, same score, every attempt — so a retry after a partial
        // failure cannot duplicate the member or move the customer.
        await this.queue.add({ ...member, score });
        return positionFromRank(await this.queue.rank(member));
      } catch (error) {
        this.logger.warn(
          {
            event: 'queue.enqueue.failed',
            session_id: session.id,
            tenant_id: session.tenantId,
            queue_key: queueKey(session.tenantId, session.language),
            attempt: attempt + 1,
            attempts: RETRY_DELAYS_MS.length,
            error_name: error instanceof Error ? error.name : 'unknown',
          },
          'redis enqueue failed',
        );
      }
    }

    // Out of attempts. The session stays `QUEUED`; the next position lookup
    // reconciles it.
    this.logger.error(
      {
        event: 'queue.enqueue.deferred',
        session_id: session.id,
        tenant_id: session.tenantId,
        queue_key: queueKey(session.tenantId, session.language),
      },
      'session is queued in postgresql but not yet in redis; deferring to reconciliation',
    );
    return null;
  }

  /**
   * The session's current position, reconciling a missing member on the way.
   *
   * This is the read path *and* the repair path, which is deliberate: the
   * moment anyone cares where a session sits is exactly the moment it is worth
   * making sure it is there. No scheduler, no outbox, no background worker.
   *
   * A session that is not `QUEUED` has no position and is never inserted.
   */
  async positionFor(session: SessionRow): Promise<QueuePosition> {
    if (!this.isQueued(session)) return null;

    const member = {
      tenantId: session.tenantId,
      language: session.language,
      sessionId: session.id,
    };

    try {
      const rank = await this.queue.rank(member);
      if (rank !== null) return positionFromRank(rank);
    } catch (error) {
      this.logAdapterFailure('queue.position.failed', session, error);
      return null;
    }

    return this.reconcile(session);
  }

  /**
   * Re-create missing Redis membership for a session PostgreSQL says is queued.
   *
   * Safe to run repeatedly: `ZADD` at the same score is a no-op, so a session
   * that is already present is unaffected and one that is absent is restored to
   * the position it always had.
   *
   * The status gate is the important line. It reads the row PostgreSQL
   * returned — not Redis, not a cached value, not the caller's belief — and
   * inserts only for `QUEUED`.
   */
  async reconcile(session: SessionRow): Promise<QueuePosition> {
    if (!this.isQueued(session)) {
      this.logger.debug(
        {
          event: 'queue.reconcile.skipped',
          session_id: session.id,
          tenant_id: session.tenantId,
          status: session.status,
        },
        'not reconciling a session that is not queued',
      );
      return null;
    }

    /* c8 ignore next 2 -- isQueued already proves queuedAt is set */
    if (session.queuedAt === null) return null;

    const member = {
      tenantId: session.tenantId,
      language: session.language,
      sessionId: session.id,
    };

    try {
      // The stored `queued_at`, however long ago it was. A session reconciled
      // ten minutes late keeps the position it earned ten minutes ago.
      await this.queue.add({ ...member, score: scoreFor(session.queuedAt) });
      const position = positionFromRank(await this.queue.rank(member));
      this.logger.info(
        {
          event: 'queue.reconciled',
          session_id: session.id,
          tenant_id: session.tenantId,
          queue_key: queueKey(session.tenantId, session.language),
        },
        'restored missing queue membership',
      );
      return position;
    } catch (error) {
      this.logAdapterFailure('queue.reconcile.failed', session, error);
      return null;
    }
  }

  /** Whether Redis currently holds this session. Never a business assertion. */
  async contains(session: SessionRow): Promise<boolean> {
    try {
      const rank = await this.queue.rank({
        tenantId: session.tenantId,
        language: session.language,
        sessionId: session.id,
      });
      return rank !== null;
    } catch (error) {
      this.logAdapterFailure('queue.contains.failed', session, error);
      return false;
    }
  }

  /**
   * `QUEUED` and nothing else.
   *
   * A positive test on one status rather than a list of statuses to exclude:
   * when T18 and T35 add more, a new status is excluded by default instead of
   * silently permitted.
   */
  private isQueued(session: SessionRow): boolean {
    return session.status === SessionStatus.QUEUED && session.queuedAt !== null;
  }

  /**
   * Log a Redis failure.
   *
   * Identifiers and an error *name* only. No Redis payload, no connection
   * string, no credential, no customer data — `03-system-design.md` §40 names
   * every one of those as something logs must not contain, and an error's
   * message can carry a host and port.
   */
  private logAdapterFailure(event: string, session: SessionRow, error: unknown): void {
    this.logger.warn(
      {
        event,
        session_id: session.id,
        tenant_id: session.tenantId,
        queue_key: queueKey(session.tenantId, session.language),
        error_name: error instanceof Error ? error.name : 'unknown',
      },
      'redis queue operation failed',
    );
  }
}
