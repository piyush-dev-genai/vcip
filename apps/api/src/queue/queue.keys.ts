/**
 * The queue's addressing rules, as pure functions.
 *
 * Three decisions live here, and all three are load-bearing enough to be worth
 * isolating from anything that touches Redis:
 *
 * **The key is `queue:{tenant_id}:{language}`** — R13, and the same string in
 * `03-system-design.md` §9.2 and `06-database-schema.md` §33.1. The tenant id
 * is the first segment and is never optional: it is what makes every read and
 * write tenant-scoped by construction rather than by remembering to filter
 * (invariant I8). A key builder that could omit it would make cross-tenant
 * leakage a one-line mistake.
 *
 * **The score is `queued_at` in milliseconds** — the value PostgreSQL already
 * stored, never a fresh clock reading. That equality is the whole ordering
 * guarantee: a retry or a reconciliation minutes later must land the session
 * exactly where it belonged, not at the back of the queue.
 *
 * **Position is `rank + 1`** — Redis ranks from zero, humans count from one.
 *
 * Pure, so all of it is testable without a Redis server and so the rules are
 * readable in one place.
 */

/**
 * Language is lower-cased before it enters a key.
 *
 * `en` and `EN` are the same queue. The alternative — treating case as
 * significant — would silently split one queue in two and strand whichever
 * customers arrived with the other spelling. Enqueue and lookup both go
 * through this function, so they cannot disagree.
 *
 * A colon would break the key's structure. `createSessionSchema` already
 * rejects one (a language tag is letters, digits, and hyphens), so this is a
 * statement of the assumption rather than a second validator.
 */
export function normaliseLanguage(language: string): string {
  return language.trim().toLowerCase();
}

/** `queue:{tenant_id}:{language}` (R13). */
export function queueKey(tenantId: string, language: string): string {
  return `queue:${tenantId}:${normaliseLanguage(language)}`;
}

/**
 * The ZSET score for a queued session.
 *
 * Milliseconds since the epoch, from `sessions.queued_at`. Redis scores are
 * IEEE-754 doubles; an epoch millisecond is about 1.8e12 and integers up to
 * 2^53 are exact, so nothing is lost.
 */
export function scoreFor(queuedAt: Date): number {
  return queuedAt.getTime();
}

/**
 * Turn a Redis rank into a customer-facing position.
 *
 * `null` in, `null` out: a session with no membership has no position, and
 * saying so is the point. Inventing `0` or `1` here would tell a customer they
 * are first in a queue they are not in.
 */
export function positionFromRank(rank: number | null): number | null {
  return rank === null ? null : rank + 1;
}
