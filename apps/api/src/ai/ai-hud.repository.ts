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
import type { AiHudPayload, DocumentCheckStatus, DocumentType } from '@vcip/shared';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../common/redis/redis.tokens.js';
import {
  fromHudFields,
  hudKey,
  HUD_TTL_SECONDS,
  toDocumentFields,
  toHudFields,
} from './ai.keys.js';

/**
 * The HUD has two writers, and both must publish what the *hash* holds.
 *
 * The sampled result owns liveness, face match and OCR; the agent-triggered
 * document check owns the three document fields. Neither knows the other's
 * values, so a writer that published its own payload would blank the other's —
 * a document status wiped by the next sampled result two seconds later, or a
 * liveness score wiped by a button press.
 *
 * So a write returns the merged state, read back in the same round trip, and
 * the caller publishes that. "What was stored" and "what was published" are
 * then the same thing by construction rather than by two code paths agreeing.
 */
export interface AiHudRepository {
  /**
   * Replace the three continuous fields, refresh the expiry, and report the
   * whole HUD as it now stands.
   */
  save(sessionId: string, payload: AiHudPayload): Promise<AiHudPayload>;

  /**
   * Record one agent-triggered document check, leaving the rest of the HUD.
   *
   * A partial write, and the one place that is correct. `save` replaces every
   * field because a sampled result is a complete snapshot of the three
   * continuous checks; a document check is a fourth, independent fact with its
   * own trigger and its own lifetime, so writing it must not disturb the three
   * and being overwritten by them would lose it.
   */
  saveDocument(
    sessionId: string,
    documentType: DocumentType,
    status: DocumentCheckStatus,
    checkedAt: string,
  ): Promise<AiHudPayload | null>;

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
  async save(sessionId: string, payload: AiHudPayload): Promise<AiHudPayload> {
    const key = hudKey(sessionId);

    const results = await this.redis
      .pipeline()
      .hset(key, toHudFields(payload))
      .expire(key, HUD_TTL_SECONDS)
      .hgetall(key)
      .exec();

    // The read-back shares the pipeline, so this is still one round trip. If it
    // cannot be used, the payload just written is the honest fallback: it is
    // certainly current for the three fields this call owns, and at worst the
    // agent's document panel misses one update and gets the next.
    return merged(sessionId, results, 2) ?? payload;
  }

  /**
   * Three fields and the same expiry, in one round trip.
   *
   * `HSET` on a subset, which is exactly what a hash is for: the continuous
   * writer and this one touch disjoint fields of one key and neither has to
   * read the other's. Doing this with a JSON blob would need a read, a merge
   * and a write, and two of those racing would lose one of the results.
   *
   * The expiry is re-armed here too. A document check is often the last thing
   * to happen on a quiet call, and a HUD whose TTL only moved on sampled
   * results would expire earlier than the check the agent is looking at.
   */
  async saveDocument(
    sessionId: string,
    documentType: DocumentType,
    status: DocumentCheckStatus,
    checkedAt: string,
  ): Promise<AiHudPayload | null> {
    const key = hudKey(sessionId);

    const results = await this.redis
      .pipeline()
      .hset(key, toDocumentFields(documentType, status, checkedAt))
      .expire(key, HUD_TTL_SECONDS)
      .hgetall(key)
      .exec();

    // Null rather than a fabricated fallback, unlike `save`. There is nothing
    // honest to invent here: a document check alone is not a HUD — it has no
    // liveness status — so a caller that cannot read the merged state has
    // nothing to publish, and says so.
    return merged(sessionId, results, 2);
  }

  async read(sessionId: string): Promise<AiHudPayload | null> {
    // `HGETALL` answers with an empty object for a key that does not exist,
    // which `fromHudFields` reads as "no HUD" — the same answer a flushed
    // Redis gives, which is the point of it being the same code path.
    const fields = await this.redis.hgetall(hudKey(sessionId));
    return fromHudFields(sessionId, fields);
  }
}

/**
 * The HUD as the pipeline's read-back saw it.
 *
 * `exec()` answers `[error, value]` per command, or `null` if the whole
 * pipeline was discarded. Every one of those has to read as "no merged state"
 * rather than throwing: this runs on the AI result path, where nothing is
 * allowed to fail the caller's request.
 */
function merged(
  sessionId: string,
  results: [Error | null, unknown][] | null,
  index: number,
): AiHudPayload | null {
  const entry = results?.[index];
  if (entry === undefined || entry[0] !== null) return null;

  const fields = entry[1];
  if (fields === null || typeof fields !== 'object') return null;

  return fromHudFields(sessionId, fields as Record<string, string>);
}
