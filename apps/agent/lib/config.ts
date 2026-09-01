/**
 * Browser-visible configuration for the agent portal.
 *
 * Two values are public, and both are addresses: where the Control API lives
 * and where the LiveKit SFU lives. The agent app holds no server-side secret at
 * all — unlike the customer app, it has no D14 bootstrap route, because an
 * agent authenticates as themselves with a password they type. There is nothing
 * here for a `NEXT_PUBLIC_` prefix to leak.
 *
 * The SFU address is public because a browser cannot connect to a server whose
 * address it does not know, and because the address authorises nothing: the
 * media token does (T24), it is minted per session and per role, and T24 issues
 * an agent one only for a session that agent is assigned to.
 * `LIVEKIT_API_SECRET` — the value that would authorise — is server-only and is
 * named nowhere in this app.
 *
 * Read through a function rather than a module-level constant because Next
 * inlines `process.env.NEXT_PUBLIC_*` at build time, and a constant evaluated
 * at import would also be evaluated during a test run where nothing is set.
 */

/** Local development default: the Control API's `API_PORT`. */
const DEFAULT_API_BASE_URL = 'http://localhost:3001';

/** A trailing slash makes `${base}/v1/...` produce a double slash. */
const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export function apiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured === undefined || configured.trim().length === 0) return DEFAULT_API_BASE_URL;
  return trimTrailingSlash(configured.trim());
}

/** Local development default: the `livekit` service in `infra/docker-compose.yml`. */
const DEFAULT_LIVEKIT_URL = 'ws://localhost:7880';

/**
 * Where the browser opens its media connection.
 *
 * Per D24 the deployment differs by environment and not by code: this is
 * `ws://localhost:7880` against the local Docker Compose stack and a `wss://`
 * LiveKit Cloud URL for the demo, with no conditional path between them.
 *
 * Deliberately not returned by the Control API. Contract §13 defines the
 * media-token response as exactly `room_name`, `token` and `expires_at`, and
 * the SFU address is deployment configuration rather than part of a credential.
 */
export function livekitUrl(): string {
  const configured = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (configured === undefined || configured.trim().length === 0) return DEFAULT_LIVEKIT_URL;
  return trimTrailingSlash(configured.trim());
}

/**
 * How often the portal beats while it intends to hold a presence.
 *
 * Five seconds against the server's 15-second TTL
 * (`apps/api/src/agents/presence.keys.ts`): three consecutive failures are
 * needed before an agent who is actually there is dropped, which absorbs a
 * transient network blip without pretending an agent is present when they are
 * not. One beat per TTL would drop an agent on a single lost packet; one per
 * second would be three times the Redis traffic for no added safety.
 */
export const HEARTBEAT_INTERVAL_MS = 5000;
