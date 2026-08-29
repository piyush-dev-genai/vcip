/**
 * Lookup port for tenant API keys, plus its Drizzle implementation.
 *
 * The guard depends on this narrow interface rather than on the database, so it
 * can be unit-tested without one — and so the only SQL involved in
 * authentication lives in one readable place.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tenantApiKeys } from '../../../db/schema.js';
import { DATABASE } from '../db/db.tokens.js';

/** What authentication needs to know about a key. Never the key itself. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
}

export const API_KEY_STORE = Symbol('API_KEY_STORE');

export const InjectApiKeyStore = (): ParameterDecorator => Inject(API_KEY_STORE);

/**
 * Split a presented key into its non-secret prefix and the whole credential.
 *
 * Keys are minted as `vcip_<name>_<secret>` (see `db/seed.ts`), so the prefix
 * is the first two underscore-separated segments — which is exactly what
 * `tenant_api_keys.key_prefix` stores and what its unique index covers.
 *
 * Returns null for anything not of that shape, so a malformed credential is
 * rejected before it reaches the database.
 */
export function parseApiKeyPrefix(presented: string): string | null {
  const segments = presented.split('_');
  if (segments.length < 3) return null;
  const [scheme, name] = segments as [string, string, ...string[]];
  if (scheme.length === 0 || name.length === 0) return null;
  // The remainder is the secret; it is never returned, only hashed by the caller.
  if (segments.slice(2).join('_').length === 0) return null;
  return `${scheme}_${name}`;
}

/** The stored representation of a key. Matches `db/seed.ts`. */
export function hashApiKey(presented: string): string {
  return createHash('sha256').update(presented, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of the presented key's hash against the stored one.
 *
 * Both are fixed-length hex digests, so a length mismatch means the stored
 * value is corrupt rather than that an attacker is probing — but it is still
 * handled without throwing.
 */
export function hashMatches(presentedHash: string, storedHash: string): boolean {
  const a = Buffer.from(presentedHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class DrizzleApiKeyStore implements ApiKeyStore {
  constructor(@Inject(DATABASE) private readonly db: PostgresJsDatabase) {}

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const [row] = await this.db
      .select({
        id: tenantApiKeys.id,
        tenantId: tenantApiKeys.tenantId,
        keyHash: tenantApiKeys.keyHash,
        scopes: tenantApiKeys.scopes,
        expiresAt: tenantApiKeys.expiresAt,
        revokedAt: tenantApiKeys.revokedAt,
      })
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.keyPrefix, prefix))
      .limit(1);

    return row ?? null;
  }
}
