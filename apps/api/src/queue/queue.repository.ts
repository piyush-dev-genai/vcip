/**
 * The Redis side of the queue.
 *
 * Two operations, and deliberately no more: add a member at a score, and read a
 * member's rank. Everything the MVP queue does is built from those.
 *
 * **`prune` is the projection's repair.** T15 shipped without any removal, on
 * the reasoning that Redis is written only after the database commits and every
 * read confirms its candidates against PostgreSQL — so a member outliving its
 * status was harmless. It was not. Nothing removed a member when a session was
 * claimed, aborted, dropped or decided, so dead members accumulated forever,
 * and a bounded read at the head of the queue eventually returned nothing but
 * corpses: an agent staring at an empty queue with a customer waiting in it.
 * `prune` is what makes "confirm against PostgreSQL" repair the projection
 * instead of merely tolerating it.
 *
 * Port and adapter, as with `SessionRepository` (T12) and `SessionEventWriter`
 * (T13): the service depends on the interface, so the queue's rules are
 * testable without a Redis server, and every Redis command in the application
 * lives in one file.
 *
 * This layer holds no business state. It does not know what `QUEUED` means and
 * never decides whether a session belongs in a queue — that judgement needs
 * PostgreSQL, and it belongs to `QueueService`.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../common/redis/redis.tokens.js';
import { queueKey } from './queue.keys.js';

export interface QueueMember {
  /** From the authenticated credential, never from a request body (I8). */
  readonly tenantId: string;
  readonly language: string;
  readonly sessionId: string;
}

export interface QueueEntry extends QueueMember {
  /** `sessions.queued_at` in milliseconds. Never a fresh clock reading. */
  readonly score: number;
}

/**
 * One member of a queue, as a bounded read returns it.
 *
 * The score travels with the member because it is the ordering key, and a
 * multi-language agent's merged view has to sort across queues in application
 * code (R13). Re-deriving it from PostgreSQL would work only because T15
 * guarantees `score === queued_at`; carrying it makes the ordering visibly
 * Redis's, which is what it is.
 */
export interface QueueCandidate {
  readonly sessionId: string;
  /** `sessions.queued_at` in milliseconds. */
  readonly score: number;
}

export interface QueueRepository {
  /**
   * Add a session to its queue at an explicit score.
   *
   * `ZADD` with the same member and the same score is a no-op, which is what
   * makes both the bounded retry and the lazy reconciliation safe to repeat:
   * neither can duplicate a member or move one that is already correctly
   * placed.
   *
   * The score is a parameter rather than something this method derives, so
   * T20's requeue (`OFFERED -> QUEUED`, preserving the original position) needs
   * no new method — it passes the score it wants to preserve.
   */
  add(entry: QueueEntry): Promise<void>;

  /** Zero-based rank within the queue, or null when the session is absent. */
  rank(member: QueueMember): Promise<number | null>;

  /**
   * The oldest `limit` members of one queue, with their scores.
   *
   * Bounded at the call site and never unbounded: T17's agent view reads the
   * head of each of an agent's language queues, and a `ZRANGE 0 -1` on a
   * production queue would be a full scan on a request path.
   *
   * Membership is not eligibility. What comes back is what Redis currently
   * believes; T15 permits a member to outlive the status that put it there, so
   * every caller must confirm each id against PostgreSQL before treating it as
   * a queued session.
   */
  range(tenantId: string, language: string, limit: number): Promise<readonly QueueCandidate[]>;

  /**
   * Drop members PostgreSQL has already disowned.
   *
   * The projection's one repair. A member outliving its status was always
   * permitted — the read confirms every candidate against the database — but
   * "permitted" quietly became "forever": nothing removed a member when a
   * session was claimed, aborted, dropped or decided, so every completed
   * verification left one behind. With a bounded read at the head of the
   * queue, enough dead members ahead of a live one make it unreachable, and
   * the agent sees an empty queue while a customer waits.
   *
   * Called only with ids the caller has just proved are not queued in this
   * tenant. Safe to repeat and safe to race: `ZREM` on an absent member is a
   * no-op, and a member is only ever added after the row it names has
   * committed, so a candidate the database disowns is genuinely stale.
   *
   * Returns how many were actually removed, which is what distinguishes a
   * repair from a no-op for the caller and the log.
   */
  prune(tenantId: string, language: string, sessionIds: readonly string[]): Promise<number>;
}

export const QUEUE_REPOSITORY = Symbol('QUEUE_REPOSITORY');

export const InjectQueueRepository = (): ParameterDecorator => Inject(QUEUE_REPOSITORY);

@Injectable()
export class RedisQueueRepository implements QueueRepository {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async add(entry: QueueEntry): Promise<void> {
    await this.redis.zadd(queueKey(entry.tenantId, entry.language), entry.score, entry.sessionId);
  }

  async range(
    tenantId: string,
    language: string,
    limit: number,
  ): Promise<readonly QueueCandidate[]> {
    // A non-positive limit reads nothing rather than becoming `ZRANGE 0 -1`,
    // which is what a naive `limit - 1` would produce for a limit of zero.
    if (limit <= 0) return [];

    // Ascending by score, so index 0 is the oldest `queued_at` — FIFO. Equal
    // scores fall back to lexical member order, which is deterministic and is
    // the same tiebreak the merged view applies across queues.
    // `stop` is stringified because ioredis types it as `string | Buffer` on
    // the WITHSCORES overload, and a number silently selects a different one.
    const flat = await this.redis.zrange(
      queueKey(tenantId, language),
      0,
      String(limit - 1),
      'WITHSCORES',
    );

    const candidates: QueueCandidate[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const sessionId = flat[i];
      const score = Number(flat[i + 1]);
      /* c8 ignore next -- redis returns well-formed pairs; a guard, not a path */
      if (sessionId === undefined || !Number.isFinite(score)) continue;
      candidates.push({ sessionId, score });
    }
    return candidates;
  }

  async prune(tenantId: string, language: string, sessionIds: readonly string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;

    // One `ZREM` with every member rather than one per id: the caller has a
    // whole page of stale candidates, and this runs on a request path.
    return await this.redis.zrem(queueKey(tenantId, language), ...sessionIds);
  }

  async rank(member: QueueMember): Promise<number | null> {
    // ZRANK orders by score ascending, so rank 0 is the oldest `queued_at` —
    // FIFO, which is what D4's pull-claim queue needs. Equal scores fall back
    // to lexical order of the member, which is deterministic; see
    // `queue.service.ts` for why that is acceptable here.
    return this.redis.zrank(queueKey(member.tenantId, member.language), member.sessionId);
  }
}
