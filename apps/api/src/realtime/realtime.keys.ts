/**
 * How a notification finds its recipients, as pure functions (T27).
 *
 * Isolated from anything that touches Redis or a socket for the reason
 * `queue.keys.ts` is: routing is where a mistake becomes a tenant-isolation
 * failure, and it should be readable and exhaustively testable in one place.
 *
 * **The channel is the authorization.** A connection subscribes to the channels
 * its verified token entitles it to and to nothing else, so delivery to the
 * wrong customer is not prevented by a filter that someone could forget — it is
 * prevented because no socket is listening on that channel. Every key here
 * begins with an identifier that came from a signed token.
 */

/** Everything this module publishes shares one prefix, so `rt:*` is greppable. */
const PREFIX = 'rt';

/**
 * One customer's session: `rt:session:{session_id}`.
 *
 * A customer token is bound to exactly one session (R8), so this is the only
 * channel a customer connection ever holds.
 */
export function sessionChannel(sessionId: string): string {
  return `${PREFIX}:session:${sessionId}`;
}

/**
 * One agent: `rt:agent:{tenant_id}:{user_id}`.
 *
 * The tenant is in the key even though a user id is already unique. It costs
 * nothing and it means a channel name cannot be assembled that crosses tenants
 * even by accident (I8).
 */
export function agentChannel(tenantId: string, userId: string): string {
  return `${PREFIX}:agent:${tenantId}:${userId}`;
}

/**
 * Agents who can work one language: `rt:queue:{tenant_id}:{language}`.
 *
 * Queue notifications are targeted, not broadcast. An agent subscribes to one
 * of these per language in their profile, so `queue.new_session` reaches only
 * agents who could actually take the session — the same rule T17's queue view
 * applies when deciding what to show them.
 */
export function queueChannel(tenantId: string, language: string): string {
  return `${PREFIX}:queue:${tenantId}:${normaliseLanguage(language)}`;
}

/**
 * The same normalisation `queue.keys.ts` applies, restated for the same reason.
 *
 * `en` and `EN` are one language; `en` and `en-IN` are two. Trim and lower-case
 * only — no truncation to a base tag — because a tenant that staffs `en-IN`
 * separately from `en` means it, and collapsing them would route a session to
 * an agent who cannot serve it.
 *
 * Imported from the queue module rather than redefined? Deliberately not: that
 * module owns the Redis queue's addressing and this one owns the notification
 * transport's, and a dependency between them would exist only to share four
 * characters. The rule is asserted identical by test instead.
 */
export function normaliseLanguage(language: string): string {
  return language.trim().toLowerCase();
}

/**
 * The channels a connection is entitled to, from its verified scope.
 *
 * Total and closed: a customer gets exactly one channel, an agent gets their
 * own plus one per configured language. There is no path through this function
 * that produces a channel for another session, another user, or another tenant,
 * and there is no argument through which a client could ask for one.
 */
export interface CustomerScope {
  readonly audience: 'customer';
  readonly tenantId: string;
  readonly sessionId: string;
}

export interface AgentScope {
  readonly audience: 'agent';
  readonly tenantId: string;
  readonly userId: string;
  /** From `agent_profiles.languages`, read server-side at connect time. */
  readonly languages: readonly string[];
}

export type ConnectionScope = CustomerScope | AgentScope;

export function channelsFor(scope: ConnectionScope): readonly string[] {
  if (scope.audience === 'customer') {
    return [sessionChannel(scope.sessionId)];
  }

  const channels = [agentChannel(scope.tenantId, scope.userId)];
  // A Set because two profile entries that normalise the same — `en` and `EN` —
  // must not subscribe twice and deliver twice.
  const languages = new Set(scope.languages.map(normaliseLanguage).filter((l) => l.length > 0));
  for (const language of languages) channels.push(queueChannel(scope.tenantId, language));
  return channels;
}
