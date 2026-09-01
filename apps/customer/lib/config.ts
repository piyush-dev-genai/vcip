/**
 * Browser-visible configuration.
 *
 * Two values are public, and both are addresses: where the Control API lives,
 * and where the LiveKit SFU lives. Everything else the customer app needs — the
 * enterprise API key above all — stays on the server (D14), and `NEXT_PUBLIC_`
 * is the boundary that makes the difference visible in the variable's own name.
 *
 * The SFU address is public because a browser cannot connect to a server whose
 * address it does not know, and because the address is not what authorises
 * anything: the media token is (T24), it is minted per session and per role,
 * and it is fetched at call time over an authenticated request. Knowing where
 * LiveKit runs admits nobody to a room. `LIVEKIT_API_SECRET` — the value that
 * would — is server-only and is named nowhere in this app.
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
 * `ws://localhost:7880` against the local Docker Compose stack and a
 * `wss://` LiveKit Cloud URL for the demo, with no conditional path between
 * them.
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

/** The consent text version submitted with an accept or a reject. */
export const CONSENT_VERSION = 'v1';
