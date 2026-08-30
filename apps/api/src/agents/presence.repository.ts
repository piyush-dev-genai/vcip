/**
 * The Redis side of agent presence.
 *
 * Four operations, and the interesting one is `touch`.
 *
 * A heartbeat must refresh an existing presence and must never create one.
 * Two things depend on that, and both are silent corruptions if it is written
 * the obvious way as `HSET` followed by `EXPIRE`:
 *
 *   1. **An agent who chose UNAVAILABLE stays unavailable.** Going unavailable
 *      deletes the key. If a heartbeat still in flight — or a UI that has not
 *      torn its timer down yet — recreated it, the agent would silently rejoin
 *      the pool of people the queue may hand a customer to.
 *   2. **A BUSY agent stays BUSY.** `BUSY` is written by the server on claim
 *      (R5, T18). A heartbeat that wrote `status` would erase it, and an agent
 *      already in a call would look eligible for another.
 *
 * So `touch` is a Lua script: existence check, `last_seen`, `EXPIRE`, and a
 * read of the status the key already had, executed as one indivisible step. It
 * writes `last_seen` and the expiry and nothing else. Splitting it into
 * `EXISTS` then `HSET` would leave a window in which the key expires between
 * the two and the `HSET` resurrects it with no status at all.
 *
 * Nothing in this file knows what an agent is or when one may be available.
 * That judgement needs PostgreSQL and belongs to `PresenceService` — the same
 * split as `QueueRepository` and `QueueService` in T15.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AgentPresence } from '@vcip/shared';
import { isAgentPresence } from '@vcip/shared';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../common/redis/redis.tokens.js';
import {
  parseLanguages,
  presenceKey,
  PRESENCE_TTL_SECONDS,
  serialiseLanguages,
} from './presence.keys.js';

/** A presence as it is written. Every field is derived, never client-supplied. */
export interface PresenceEntry {
  /** From the verified JWT, never from a request body. */
  readonly agentId: string;
  /** From the verified JWT, never from a request body (I8). */
  readonly tenantId: string;
  readonly status: AgentPresence;
  /** From `agent_profiles.languages`, never from the request. */
  readonly languages: readonly string[];
  readonly lastSeen: Date;
}

/** A presence as it is read back. */
export interface PresenceRecord {
  readonly status: AgentPresence;
  readonly languages: readonly string[];
  readonly lastSeen: string;
  readonly tenantId: string;
}

/** What a heartbeat found. `null` when there was no presence to refresh. */
export interface TouchResult {
  readonly status: AgentPresence;
  readonly lastSeen: string;
}

export interface PresenceRepository {
  /** Create or replace a presence, and arm the TTL. */
  set(entry: PresenceEntry): Promise<void>;

  /**
   * Refresh an existing presence's `last_seen` and TTL, atomically.
   *
   * Returns the status the presence already had, or `null` when there was no
   * presence — which is the honest answer for an agent who is unavailable or
   * whose key expired. It never creates one and never changes the status.
   */
  touch(agentId: string, lastSeen: Date): Promise<TouchResult | null>;

  /** Read a presence, or null when it is absent or expired. */
  read(agentId: string): Promise<PresenceRecord | null>;

  /** Delete a presence. Idempotent: deleting an absent key is a no-op. */
  remove(agentId: string): Promise<void>;

  /**
   * Change the status of an existing presence, keeping its other fields.
   *
   * The primitive T18/T19 will drive for `BUSY`. Returns false when there was
   * no presence to change; it does not invent one, because an agent with no
   * presence is not live and inventing one here would paper over that.
   */
  setStatus(agentId: string, status: AgentPresence): Promise<boolean>;

  /** Seconds remaining, for verification. Negative values follow Redis's TTL. */
  ttl(agentId: string): Promise<number>;
}

export const PRESENCE_REPOSITORY = Symbol('PRESENCE_REPOSITORY');

export const InjectPresenceRepository = (): ParameterDecorator => Inject(PRESENCE_REPOSITORY);

/**
 * Refresh without resurrecting.
 *
 * Returns nil when the key is absent, so the caller can tell "refreshed" from
 * "there was nothing to refresh" without a second round trip that could race.
 */
const TOUCH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
redis.call('HSET', KEYS[1], 'last_seen', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('HGET', KEYS[1], 'status')
`;

/** Change status only where a presence already exists, keeping the TTL armed. */
const SET_STATUS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

@Injectable()
export class RedisPresenceRepository implements PresenceRepository {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async set(entry: PresenceEntry): Promise<void> {
    const key = presenceKey(entry.agentId);
    // A pipeline, not a transaction: the two commands are independent and a
    // partially applied write here would be a hash with no expiry, which the
    // next availability call replaces anyway. `HSET` overwrites the fields it
    // names, so a repeated AVAILABLE is naturally idempotent.
    await this.redis
      .multi()
      .hset(key, {
        status: entry.status,
        languages: serialiseLanguages(entry.languages),
        last_seen: entry.lastSeen.toISOString(),
        tenant_id: entry.tenantId,
      })
      .expire(key, PRESENCE_TTL_SECONDS)
      .exec();
  }

  async touch(agentId: string, lastSeen: Date): Promise<TouchResult | null> {
    const iso = lastSeen.toISOString();
    const status: unknown = await this.redis.eval(
      TOUCH_SCRIPT,
      1,
      presenceKey(agentId),
      iso,
      String(PRESENCE_TTL_SECONDS),
    );
    // A key written by an older build, or corrupted, could carry a status this
    // system does not recognise. Treated as absent rather than propagated: an
    // unknown presence value must never reach the queue as if it were a real
    // one.
    if (typeof status !== 'string' || !isAgentPresence(status)) return null;
    return { status, lastSeen: iso };
  }

  async read(agentId: string): Promise<PresenceRecord | null> {
    const hash = await this.redis.hgetall(presenceKey(agentId));
    // ioredis returns `{}` for a missing key, not null.
    if (hash === null || Object.keys(hash).length === 0) return null;

    const status = hash['status'];
    if (status === undefined || !isAgentPresence(status)) return null;

    return {
      status,
      languages: parseLanguages(hash['languages']),
      lastSeen: hash['last_seen'] ?? '',
      tenantId: hash['tenant_id'] ?? '',
    };
  }

  async remove(agentId: string): Promise<void> {
    await this.redis.del(presenceKey(agentId));
  }

  async setStatus(agentId: string, status: AgentPresence): Promise<boolean> {
    const changed: unknown = await this.redis.eval(
      SET_STATUS_SCRIPT,
      1,
      presenceKey(agentId),
      status,
      String(PRESENCE_TTL_SECONDS),
    );
    return changed === 1;
  }

  async ttl(agentId: string): Promise<number> {
    return this.redis.ttl(presenceKey(agentId));
  }
}
