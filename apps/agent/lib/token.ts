/**
 * Agent token handling.
 *
 * The agent's JWT is not a link parameter the way the customer's is — it comes
 * back in a login response — so there is no fragment to read and no address bar
 * to clean. What remains is where it lives between page loads, and the rules
 * are the customer app's, for the same reasons:
 *
 *   - **`sessionStorage`, never `localStorage`.** The credential dies with the
 *     tab. An agent portal left open on a shared operations machine should not
 *     hand the next person a working session, and a token that survives until
 *     someone clears site data is exactly that. `security.spec.ts` reads the
 *     source to check no other module reaches for either.
 *   - **Never in a URL.** No query parameter, no fragment. A token in a URL is
 *     a token in a proxy log and a browser history entry.
 *   - **Nothing logs.** There is no debug branch that prints it, because the
 *     one that exists is the one that eventually runs in production.
 *
 * The browser surface is injected as a `TokenHost` rather than reached for
 * directly, which is what lets every rule above be tested under plain Node and
 * keeps `window` out of a module Next may evaluate while rendering on the
 * server.
 */

/** The `Storage` members used here. Deliberately not the whole interface. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TokenHost {
  /** `window.sessionStorage`, or null when storage is unavailable. */
  readonly storage: StorageLike | null;
}

/** One key, because an agent portal holds one agent's session. */
const STORAGE_KEY = 'vcip.agent.token';

/**
 * A stored credential, as the app carries it.
 *
 * `expiresAt` is kept beside the token so the portal can send the agent back to
 * the login screen before the API starts refusing them, rather than after. It
 * is not a security control — the server's `exp` is — it is a way to fail
 * legibly.
 */
export interface StoredToken {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Browser storage can throw rather than return null: Safari's private mode and
 * a blocked-cookies setting both do. A portal that white-screens because
 * storage is disabled is worse than one that simply asks the agent to log in
 * again, so every access is wrapped.
 */
function safely<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}

export function readToken(host: TokenHost): StoredToken | null {
  const storage = host.storage;
  if (storage === null) return null;

  const raw = safely(() => storage.getItem(STORAGE_KEY), null);
  if (raw === null || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { token, expiresAt } = parsed as Record<string, unknown>;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) return null;

  return { token, expiresAt };
}

export function writeToken(host: TokenHost, value: StoredToken): void {
  const storage = host.storage;
  if (storage === null) return;
  safely(() => storage.setItem(STORAGE_KEY, JSON.stringify(value)), undefined);
}

export function clearToken(host: TokenHost): void {
  const storage = host.storage;
  if (storage === null) return;
  safely(() => storage.removeItem(STORAGE_KEY), undefined);
}

/**
 * Has this token passed its expiry?
 *
 * A small skew is subtracted so the portal stops using a token slightly before
 * the server would reject it, rather than discovering the expiry as a failed
 * heartbeat. An unparseable timestamp counts as expired: the safe reading of "I
 * cannot tell when this dies" is "treat it as dead".
 */
const EXPIRY_SKEW_MS = 30_000;

export function isExpired(value: StoredToken, now: Date = new Date()): boolean {
  const expiresAt = Date.parse(value.expiresAt);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - EXPIRY_SKEW_MS <= now.getTime();
}

/** The live browser host. Returns a null storage anywhere `window` is absent. */
export function browserTokenHost(): TokenHost {
  if (typeof window === 'undefined') return { storage: null };
  return { storage: safely(() => window.sessionStorage, null) };
}
