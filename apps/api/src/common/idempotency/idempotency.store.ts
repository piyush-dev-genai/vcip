/**
 * The Redis half of D13's idempotency layer.
 *
 * Records live under the documented key shape, `idem:{actor}:{endpoint}:{key}`,
 * and completed responses hold a 24-hour TTL. The key is only ever constructed,
 * never parsed back, so an actor or endpoint containing a colon is harmless.
 *
 * Redis is a convenience layer (D2). If a record is missing because Redis was
 * flushed or restarted, the request executes again — acceptable per D13,
 * because the invariants that actually matter are protected in PostgreSQL:
 * `billing_entries.session_id` as a primary key, and the single-winner
 * conditional updates behind claim, accept, and verdict. This store is never
 * the only thing standing between a retry and a duplicate business outcome.
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.tokens.js';

/** D13: exactly 24 hours for a completed response. */
export const RECORD_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long an in-flight claim survives without completing.
 *
 * Deliberately short. A process killed mid-handler must not leave a key that
 * blocks the same request for the next 24 hours; the claim simply expires and
 * the caller may retry. `docs/06-database-schema.md` §39 puts session locks at
 * 10-30 seconds, and this is the same class of lock.
 */
export const CLAIM_TTL_SECONDS = 30;

export type RecordState = 'pending' | 'completed';

export interface PendingRecord {
  readonly state: 'pending';
  /** Fingerprint of the request that claimed the key. */
  readonly fingerprint: string;
  readonly claimedAt: number;
}

export interface CompletedRecord {
  readonly state: 'completed';
  readonly fingerprint: string;
  readonly status: number;
  /** The original response body, serialized. */
  readonly body: unknown;
  readonly completedAt: number;
}

export type IdempotencyRecord = PendingRecord | CompletedRecord;

/**
 * Fingerprint of the request this key was used for.
 *
 * A SHA-256 of the method, path, and body — never the body itself. Two things
 * follow from hashing rather than storing: a replay with a different payload is
 * detectable, and a request body containing customer data never lands in Redis
 * or in a log line. The digest is not reversible, so it discloses nothing.
 */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
  const canonical = JSON.stringify({ method, path, body: canonicalise(body) });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Order-independent serialisation, so `{a:1,b:2}` and `{b:2,a:1}` are the same
 * request. Without this, a client that serialises its JSON differently between
 * retries would get a spurious conflict.
 */
function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonicalise(v)]));
}

/** Build the documented key. Never parsed; only ever constructed. */
export function idempotencyKey(actor: string, endpoint: string, key: string): string {
  return `idem:${actor}:${endpoint}:${key}`;
}

export type ClaimOutcome =
  { readonly kind: 'claimed' } | { readonly kind: 'existing'; readonly record: IdempotencyRecord };

/**
 * Thrown when Redis cannot answer.
 *
 * The interceptor turns this into a 503 rather than proceeding. Executing a
 * protected mutation while unable to record that it happened is exactly the
 * duplicate this layer exists to prevent, so the request fails closed.
 */
export class IdempotencyUnavailableError extends Error {
  constructor(cause: unknown) {
    super('idempotency store unavailable');
    this.name = 'IdempotencyUnavailableError';
    this.cause = cause;
  }
}

@Injectable()
export class IdempotencyStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Atomically claim the key, or report what is already there.
   *
   * `SET NX PX` in one round trip. This is the whole concurrency story: two
   * identical requests arriving together both attempt the claim, exactly one
   * gets `OK`, and the loser is told to wait. A GET-then-SET would let both
   * observe an empty key and both enter the handler.
   */
  async claim(key: string, fingerprint: string): Promise<ClaimOutcome> {
    const pending: PendingRecord = { state: 'pending', fingerprint, claimedAt: Date.now() };

    let result: string | null;
    try {
      result = await this.redis.set(key, JSON.stringify(pending), 'EX', CLAIM_TTL_SECONDS, 'NX');
    } catch (error) {
      throw new IdempotencyUnavailableError(error);
    }

    if (result === 'OK') return { kind: 'claimed' };

    const existing = await this.read(key);
    // The record expired between the failed SET and this read. Treat it as a
    // claim failure the caller can retry rather than inventing a record.
    if (existing === null) return { kind: 'existing', record: pending };
    return { kind: 'existing', record: existing };
  }

  async read(key: string): Promise<IdempotencyRecord | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      throw new IdempotencyUnavailableError(error);
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as IdempotencyRecord;
    } catch {
      // A corrupt record is treated as absent rather than crashing the request.
      return null;
    }
  }

  /**
   * Replace the in-flight claim with the completed response, and extend the TTL
   * to the documented 24 hours.
   */
  async complete(key: string, record: CompletedRecord): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS);
    } catch (error) {
      throw new IdempotencyUnavailableError(error);
    }
  }

  /**
   * Drop the claim after a failed handler.
   *
   * A failure must not be cached: the caller retries with the same key and the
   * request runs again. Only a completed response is remembered.
   */
  async release(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      // The claim expires on its own within CLAIM_TTL_SECONDS. A failed delete
      // delays a retry briefly; it never blocks one for the 24-hour window.
    }
  }

  /** Remaining TTL in seconds, or a negative ioredis sentinel. */
  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      throw new IdempotencyUnavailableError(error);
    }
  }
}
