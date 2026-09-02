/**
 * The call lifecycle's Redis state, behind a port (T26).
 *
 * Two things live here and nothing else: which roles are currently in a room,
 * and when a departed participant stops being given the benefit of the doubt.
 * Both are transient real-time state (D2). Neither decides anything — every
 * transition they lead to is a guarded UPDATE against PostgreSQL, which is
 * authoritative (D1).
 *
 * A port, so the lifecycle service can be tested without a Redis and so the
 * key layout stays in `call.keys.ts` rather than being spelled out at each call
 * site.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../common/redis/redis.tokens.js';
import type { CallDeadline, CallRole } from './call.keys.js';
import {
  DEADLINES_KEY,
  PARTICIPANTS_TTL_SECONDS,
  SEEN_EVENT_TTL_SECONDS,
  deadlineMember,
  participantsKey,
  seenEventKey,
} from './call.keys.js';

/** One deadline that has fallen due. */
export interface DueDeadline {
  readonly member: string;
  readonly dueAtMs: number;
}

export interface CallRepository {
  /**
   * Remember an event id, and say whether it is new.
   *
   * `SET NX` — false means this id has been delivered before. Best-effort
   * suppression of LiveKit's retries, not a correctness guarantee: every action
   * downstream is independently idempotent.
   */
  markSeen(eventId: string): Promise<boolean>;

  /** Record that a role is in the room. Returns the roles present after it. */
  addParticipant(sessionId: string, role: CallRole): Promise<readonly string[]>;

  /** Record that a role has left. Returns the roles still present. */
  removeParticipant(sessionId: string, role: CallRole): Promise<readonly string[]>;

  /** Forget a room entirely. */
  clearParticipants(sessionId: string): Promise<void>;

  /** Arm a deadline. Re-arming an existing one moves it. */
  armDeadline(sessionId: string, reason: CallDeadline, dueAtMs: number): Promise<void>;

  /**
   * Disarm a deadline, reporting whether one was actually armed.
   *
   * The return value is what distinguishes a first join from a reconnection:
   * true means this participant had been away and a deadline was counting down,
   * which is precisely when `AGENT_RECONNECTED` belongs in the log.
   */
  disarmDeadline(sessionId: string, reason: CallDeadline): Promise<boolean>;

  /** Disarm every deadline for a session, whatever the role. */
  disarmAll(sessionId: string): Promise<void>;

  /** Deadlines due at or before `nowMs`, soonest first, bounded by `limit`. */
  dueDeadlines(nowMs: number, limit: number): Promise<readonly DueDeadline[]>;
}

export const CALL_REPOSITORY = Symbol('CALL_REPOSITORY');

export const InjectCallRepository = (): ParameterDecorator => Inject(CALL_REPOSITORY);

@Injectable()
export class RedisCallRepository implements CallRepository {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async markSeen(eventId: string): Promise<boolean> {
    const stored = await this.redis.set(
      seenEventKey(eventId),
      '1',
      'EX',
      SEEN_EVENT_TTL_SECONDS,
      'NX',
    );
    return stored === 'OK';
  }

  async addParticipant(sessionId: string, role: CallRole): Promise<readonly string[]> {
    const key = participantsKey(sessionId);
    await this.redis.sadd(key, role);
    // Refreshed on every join so a long call cannot outlive its own key.
    await this.redis.expire(key, PARTICIPANTS_TTL_SECONDS);
    return this.redis.smembers(key);
  }

  async removeParticipant(sessionId: string, role: CallRole): Promise<readonly string[]> {
    const key = participantsKey(sessionId);
    await this.redis.srem(key, role);
    return this.redis.smembers(key);
  }

  async clearParticipants(sessionId: string): Promise<void> {
    await this.redis.del(participantsKey(sessionId));
  }

  async armDeadline(sessionId: string, reason: CallDeadline, dueAtMs: number): Promise<void> {
    // ZADD on an existing member updates its score, so a participant who leaves
    // twice gets one deadline measured from the second departure.
    await this.redis.zadd(DEADLINES_KEY, dueAtMs, deadlineMember(sessionId, reason));
  }

  async disarmDeadline(sessionId: string, reason: CallDeadline): Promise<boolean> {
    const removed = await this.redis.zrem(DEADLINES_KEY, deadlineMember(sessionId, reason));
    return removed > 0;
  }

  async disarmAll(sessionId: string): Promise<void> {
    // Every reason, not the two participant ones: a session that has ended has
    // no clock left running against it, including the call-start clock.
    const members = (['customer', 'agent', 'start'] as const).map((reason) =>
      deadlineMember(sessionId, reason),
    );
    await this.redis.zrem(DEADLINES_KEY, ...members);
  }

  async dueDeadlines(nowMs: number, limit: number): Promise<readonly DueDeadline[]> {
    if (limit <= 0) return [];
    // `ZRANGEBYSCORE ... WITHSCORES` returns a flat [member, score, ...] array.
    const flat = await this.redis.zrangebyscore(
      DEADLINES_KEY,
      0,
      nowMs,
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    );

    const due: DueDeadline[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      due.push({ member: flat[i] as string, dueAtMs: Number(flat[i + 1]) });
    }
    return due;
  }
}
