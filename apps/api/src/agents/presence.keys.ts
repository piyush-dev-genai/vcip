/**
 * The presence layer's addressing and shape rules, as pure functions.
 *
 * Isolated from anything that touches Redis, for the same reason
 * `queue.keys.ts` is: these are the decisions worth reading in one place, and
 * they are testable without a server.
 *
 * **The key is `agent:presence:{agent_id}`** — `03-system-design.md` §9.3. Note
 * what it is *not*: unlike `queue:{tenant_id}:{language}`, the tenant is not in
 * the key. That is the documented name and this task keeps it, but it means the
 * key alone does not prove ownership, which is why `tenant_id` is a field of
 * the hash (see `PRESENCE_FIELDS`) and why the agent id always comes from a
 * verified JWT rather than from a request.
 *
 * **The TTL is 15 seconds** — `03-system-design.md` §9.3. Redis expiry is the
 * liveness mechanism (D2): if the key is gone, the agent is not present. There
 * is no PostgreSQL column mirroring this and no sweeper maintaining one.
 *
 * **The hash holds four fields and no more.** Presence is a projection for the
 * queue to filter on, not a copy of the user record. In particular
 * `max_concurrent` is absent: R5 enforces it at claim time from PostgreSQL,
 * where it is configuration, and a copy in Redis would be a second answer to a
 * question that already has one.
 */

/** `agent:presence:{agent_id}` (§9.3). */
export function presenceKey(agentId: string): string {
  return `agent:presence:${agentId}`;
}

/**
 * How long a presence survives without a heartbeat.
 *
 * Fifteen seconds, from `03-system-design.md` §9.3. The agent app heartbeats
 * every five (see `apps/agent/lib/heartbeat.ts`), so three consecutive failures
 * are needed before an active agent is considered gone.
 */
export const PRESENCE_TTL_SECONDS = 15;

/**
 * Every field the presence hash may contain.
 *
 * Exported so a test can assert the stored hash has exactly these keys. A
 * presence that quietly grew an email address or a password hash would be a
 * data-minimisation failure that no behavioural test would notice.
 */
export const PRESENCE_FIELDS = Object.freeze([
  'status',
  'languages',
  'last_seen',
  'tenant_id',
] as const);

export type PresenceField = (typeof PRESENCE_FIELDS)[number];

/**
 * Languages are stored as a JSON array in a single hash field.
 *
 * A Redis hash holds strings, and the alternative — a comma-joined list —
 * silently breaks on a tag containing a comma. JSON round-trips exactly, and
 * `parseLanguages` refuses anything that is not an array of strings rather than
 * letting a corrupt value reach the queue matcher as a half-parsed shape.
 */
export function serialiseLanguages(languages: readonly string[]): string {
  return JSON.stringify(languages);
}

export function parseLanguages(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === 'string');
}
