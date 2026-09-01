/**
 * Turning a WebSocket handshake into a verified scope (T27, D9).
 *
 * Pure apart from the JWT verification it delegates, so the rules below can be
 * tested exhaustively without a server, a socket, or a Redis.
 *
 * Two properties this file exists to guarantee:
 *
 * **Scope comes from the token and from nothing else.** The URL carries one
 * value — `token` — and every other query parameter is ignored. There is no
 * `session_id`, no `tenant_id`, no `user_id` a client could supply, so a
 * connection cannot ask to hear about somebody else's session by editing a URL.
 *
 * **The token is never returned, logged, or echoed.** `redactUrl` exists
 * because D9 puts a credential in a query parameter — the one place this
 * codebase otherwise refuses to put one — and query strings reach access logs,
 * proxies, and browser history. Every log line about a connection goes through
 * it.
 */

import { RealtimeAudience } from '@vcip/shared';
import { verifyJwt } from '../common/auth/tokens.js';
import type { AgentScope, CustomerScope } from './realtime.keys.js';
import { WS_ACTOR_CLAIM } from './ws-token.service.js';

/** Why a handshake was refused. The client is told nothing but the close code. */
export const HandshakeFailure = {
  MISSING_TOKEN: 'missing_token',
  INVALID_TOKEN: 'invalid_token',
  INVALID_SCOPE: 'invalid_scope',
} as const;

export type HandshakeFailure = (typeof HandshakeFailure)[keyof typeof HandshakeFailure];

/**
 * The scope a token proves, before the parts that are not in it are filled in.
 *
 * An agent scope without languages, because those are read from the profile at
 * connect time. Declared explicitly rather than as `Omit<ConnectionScope, ...>`:
 * `Omit` over a union collapses it into one object type with optional-looking
 * members, which is exactly the shape this needs to stay discriminated.
 */
export type VerifiedScope = CustomerScope | Omit<AgentScope, 'languages'>;

export type HandshakeResult =
  | { readonly ok: true; readonly scope: VerifiedScope }
  | { readonly ok: false; readonly reason: HandshakeFailure };

/**
 * WebSocket close code for a refused handshake.
 *
 * 4401 is in the private-use range (4000-4999) and is chosen to read like the
 * HTTP status it corresponds to. The client is told the code and nothing more:
 * "expired" and "forged" must be indistinguishable, exactly as the REST guards
 * treat them.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/**
 * Read the connection token out of a handshake URL.
 *
 * Takes the raw request URL, which for a WebSocket upgrade is path plus query.
 * Returns null rather than throwing for anything malformed — a handshake is not
 * a place to distinguish causes.
 */
export function tokenFromUrl(url: string | undefined): string | null {
  if (url === undefined || url.length === 0) return null;
  // A base is required because a request URL is path-relative. It is discarded.
  let parsed: URL;
  try {
    parsed = new URL(url, 'ws://placeholder.invalid');
  } catch {
    return null;
  }
  const token = parsed.searchParams.get('token');
  return token === null || token.length === 0 ? null : token;
}

/**
 * The same URL with the credential removed.
 *
 * `token=[redacted]` rather than a dropped parameter, so a log line still shows
 * that a token was present — which is worth knowing when diagnosing a refusal —
 * without showing what it was. Any other parameter is preserved as-is; there
 * are none today, and a future one that carried a secret would be a mistake
 * this function should not paper over.
 */
export function redactUrl(url: string | undefined): string {
  if (url === undefined || url.length === 0) return '';
  let parsed: URL;
  try {
    parsed = new URL(url, 'ws://placeholder.invalid');
  } catch {
    return '[unparseable]';
  }
  if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[redacted]');
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Verify a connection token and derive the scope it entitles the caller to.
 *
 * The `act` claim is checked against `ws`, so a customer session token or an
 * agent JWT presented here fails even before the distinct signing secret is
 * considered. Both checks are belt and braces on purpose: purpose confusion
 * between a long-lived session credential and a URL-borne one is the specific
 * risk D9 introduces.
 */
export function authenticate(url: string | undefined, secret: string): HandshakeResult {
  const token = tokenFromUrl(url);
  if (token === null) return { ok: false, reason: HandshakeFailure.MISSING_TOKEN };

  let claims;
  try {
    claims = verifyJwt(token, secret, WS_ACTOR_CLAIM);
  } catch {
    // Expired, forged, wrong secret, wrong purpose — one answer for all.
    return { ok: false, reason: HandshakeFailure.INVALID_TOKEN };
  }

  const tenantId = claims['tid'];
  const audience = claims['aud'];
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return { ok: false, reason: HandshakeFailure.INVALID_SCOPE };
  }

  if (audience === RealtimeAudience.CUSTOMER) {
    const sessionId = claims['sid'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, reason: HandshakeFailure.INVALID_SCOPE };
    }
    return { ok: true, scope: { audience: RealtimeAudience.CUSTOMER, tenantId, sessionId } };
  }

  if (audience === RealtimeAudience.AGENT) {
    const userId = claims['uid'];
    if (typeof userId !== 'string' || userId.length === 0) {
      return { ok: false, reason: HandshakeFailure.INVALID_SCOPE };
    }
    // Languages are not in the token: they are read from `agent_profiles` when
    // the connection is registered, so a profile change takes effect on the
    // next connection instead of being frozen into a credential.
    return { ok: true, scope: { audience: RealtimeAudience.AGENT, tenantId, userId } };
  }

  return { ok: false, reason: HandshakeFailure.INVALID_SCOPE };
}
