/**
 * Customer session token handling.
 *
 * The token arrives in the URL **fragment**, never the query string:
 *
 *     /session/<session_id>#token=<customer_token>
 *
 * A fragment is not transmitted with the request. It never reaches the Next
 * server, never reaches a proxy, and never appears in an access log — which is
 * precisely what a query parameter cannot promise. The difference is the whole
 * reason for the shape.
 *
 * From there:
 *
 *   1. read it once,
 *   2. move it into `sessionStorage`, keyed by session,
 *   3. strip the fragment from the address bar with `history.replaceState`.
 *
 * `sessionStorage`, not `localStorage`: the token dies with the tab, which
 * matches a two-hour session-scoped credential (R8) far better than a store
 * that survives until someone clears it. `localStorage` appears nowhere in this
 * app, and `security.spec.ts` checks that by reading the source.
 *
 * Keyed by session id so a second verification opened in the same tab cannot
 * inherit the first one's credential.
 *
 * Nothing here logs. There is no debug branch that prints the token, because
 * the one that exists is the one that eventually runs in production.
 *
 * The browser surface is injected as a `TokenHost` rather than reached for
 * directly. That is what lets every rule above be tested under plain Node
 * without a DOM, and it keeps `window` out of a module that Next may evaluate
 * while rendering on the server.
 */

/** The `Storage` members used here. Deliberately not the whole interface. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TokenHost {
  /** `location.hash`, including the leading `#` when present. */
  readonly hash: string;
  /** `location.pathname` + `location.search` — the URL without its fragment. */
  readonly pathWithSearch: string;
  readonly storage: StorageLike;
  /** `history.replaceState(null, '', url)`. */
  replaceUrl(url: string): void;
}

const KEY_PREFIX = 'vcip.customer_token.';

/** Storage key for one session. */
export function storageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/**
 * Pull the token out of a fragment.
 *
 * The fragment is parsed as `URLSearchParams` so `#token=x&lang=en` works and
 * percent-encoding is undone. Returns null when there is no `token` key, which
 * is the ordinary case on every navigation after the first.
 */
export function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  const value = new URLSearchParams(raw).get('token');
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Consume a token from the URL, if one is there, and return the token to use.
 *
 * Order matters: store first, then strip. Stripping first would leave a window
 * in which a reload loses the credential entirely.
 *
 * When the fragment carries no token, the stored one is returned — this is what
 * makes a refresh work at all, since the fragment is gone after the first load.
 */
export function consumeToken(sessionId: string, host: TokenHost): string | null {
  const fromUrl = tokenFromHash(host.hash);

  if (fromUrl !== null) {
    host.storage.setItem(storageKey(sessionId), fromUrl);
    // Replace, not push: the fragment must not be reachable with Back.
    host.replaceUrl(host.pathWithSearch);
    return fromUrl;
  }

  return host.storage.getItem(storageKey(sessionId));
}

export function readToken(sessionId: string, host: TokenHost): string | null {
  return host.storage.getItem(storageKey(sessionId));
}

/** Forget the token. Called when the session reaches a terminal state. */
export function clearToken(sessionId: string, host: TokenHost): void {
  host.storage.removeItem(storageKey(sessionId));
}

/**
 * The real browser host.
 *
 * Built on demand, never at import: this module is imported by a component that
 * Next renders on the server first, where `window` does not exist.
 */
export function browserTokenHost(): TokenHost {
  return {
    get hash(): string {
      return window.location.hash;
    },
    get pathWithSearch(): string {
      return `${window.location.pathname}${window.location.search}`;
    },
    storage: window.sessionStorage,
    replaceUrl(url: string): void {
      window.history.replaceState(null, '', url);
    },
  };
}
