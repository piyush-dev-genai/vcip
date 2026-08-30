/**
 * The Redis side of the queue.
 *
 * Two operations, and deliberately no more: add a member at a score, and read a
 * member's rank. Everything the MVP queue does is built from those.
 *
 * **No `remove`.** T15 has no code path that needs one — Redis is only written
 * after the database has committed, so a failed `ZADD` leaves nothing behind to
 * clean up. Removal arrives with its first real caller in T18's claim. An
 * exported method with no caller is a method nobody has ever run.
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
}

export const QUEUE_REPOSITORY = Symbol('QUEUE_REPOSITORY');

export const InjectQueueRepository = (): ParameterDecorator => Inject(QUEUE_REPOSITORY);

@Injectable()
export class RedisQueueRepository implements QueueRepository {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async add(entry: QueueEntry): Promise<void> {
    await this.redis.zadd(queueKey(entry.tenantId, entry.language), entry.score, entry.sessionId);
  }

  async rank(member: QueueMember): Promise<number | null> {
    // ZRANK orders by score ascending, so rank 0 is the oldest `queued_at` —
    // FIFO, which is what D4's pull-claim queue needs. Equal scores fall back
    // to lexical order of the member, which is deterministic; see
    // `queue.service.ts` for why that is acceptable here.
    return this.redis.zrank(queueKey(member.tenantId, member.language), member.sessionId);
  }
}
