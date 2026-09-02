/**
 * The Redis side of the AI HUD (T31).
 *
 * Two operations, and no judgement: whether a HUD is worth writing, and who is
 * allowed to see it, belong to `AiResultService`. The same split as
 * `PresenceRepository`/`PresenceService` and `QueueRepository`/`QueueService`.
 *
 * The HUD is Redis and only Redis (D2). It is real-time state that a flush may
 * take away, and losing it costs the agent a panel and T35 a summary — never a
 * verdict, a billing row, or a transition. Nothing here writes PostgreSQL.
 */

import { Injectable, Inject } from '@nestjs/common';
import type { AiHudPayload } from '@vcip/shared';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../common/redis/redis.tokens.js';
import { fromHudFields, hudKey, HUD_TTL_SECONDS, toHudFields } from './ai.keys.js';

export interface AiHudRepository {
  /** Replace one session's HUD and refresh its expiry. */
  save(sessionId: string, payload: AiHudPayload): Promise<void>;

  /** The current HUD, or `null` if there is none. */
  read(sessionId: string): Promise<AiHudPayload | null>;
}

export const AI_HUD_REPOSITORY = Symbol('AI_HUD_REPOSITORY');

export const InjectAiHudRepository = (): ParameterDecorator => Inject(AI_HUD_REPOSITORY);

@Injectable()
export class RedisAiHudRepository implements AiHudRepository {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Write every field and re-arm the expiry, in one round trip.
   *
   * `HSET` with the full field map rather than a per-field update: a result is
   * a complete snapshot of all three checks, and a partial write is how a HUD
   * ends up half one result and half the next. The `EXPIRE` shares the
   * pipeline so a HUD can never be written without one — a key with no TTL
   * would outlive its session and quietly become the one piece of Redis that
   * grows forever.
   *
   * Not a transaction: two commands against one key, where the worst
   * interleaving is a HUD that briefly holds its previous TTL.
   */
  async save(sessionId: string, payload: AiHudPayload): Promise<void> {
    const key = hudKey(sessionId);

    await this.redis.pipeline().hset(key, toHudFields(payload)).expire(key, HUD_TTL_SECONDS).exec();
  }

  async read(sessionId: string): Promise<AiHudPayload | null> {
    // `HGETALL` answers with an empty object for a key that does not exist,
    // which `fromHudFields` reads as "no HUD" — the same answer a flushed
    // Redis gives, which is the point of it being the same code path.
    const fields = await this.redis.hgetall(hudKey(sessionId));
    return fromHudFields(sessionId, fields);
  }
}
