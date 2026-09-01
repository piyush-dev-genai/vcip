/**
 * What this agent is currently working, across a page reload (T21).
 *
 * Two things live here, and both exist because a browser can be refreshed
 * halfway through a verification.
 *
 * **The session being worked.** A claimed or accepted session has left
 * `GET /v1/agent/queue` — it is no longer `QUEUED` — and the contract has no
 * "what am I working on" endpoint. So a reload with nothing remembered leaves
 * the agent with no route back to work they are still holding: mid-offer the
 * sweeper reclaims it in a tenant timeout, but mid-call nothing does, and the
 * session would sit `IN_CALL` with their capacity consumed. Remembering the id
 * is what makes `GET /v1/sessions/{id}` a recovery path.
 *
 * **The idempotency keys.** A claim and an accept each need one, and a *retry*
 * of the same intent has to present the *same* key or it is a fresh operation.
 * Since keys are bound to the resource they were first used on, one key per
 * (intent, session) is also the only shape that cannot collide: reusing one
 * across two sessions is a 409 by design.
 *
 * `sessionStorage`, for the reason `token.ts` gives — the tab is the session,
 * and a portal left open on a shared machine must not hand the next person
 * anything. The storage surface is injected so every rule here is testable
 * under plain Node and `window` never leaks into a module Next may render on
 * the server.
 *
 * Nothing here is authoritative. It is a note to self about which id to ask
 * about; the server's answer to that question is the state (D1).
 */

import type { StorageLike } from './token';

export interface WorkHost {
  /** `window.sessionStorage`, or null when storage is unavailable. */
  readonly storage: StorageLike | null;
  /** Key generation, injected so tests are deterministic. */
  readonly newKey: () => string;
}

const SESSION_KEY = 'vcip.agent.work';
const IDEMPOTENCY_PREFIX = 'vcip.agent.idem.';

/** The intents that need an idempotency key. Closed, so no caller invents one. */
export type WorkIntent = 'claim' | 'accept';

/**
 * The remembered session.
 *
 * `offerExpiresAt` is kept because `GET /v1/sessions/{id}` does not report it —
 * it returns the status but not the offer window — so without it a recovered
 * offer could be shown but not counted down. It is a server-issued value being
 * carried across a reload, not a locally computed one.
 *
 * `roomName` likewise: it is on the session row from creation, and keeping it
 * saves the recovered call screen from looking emptier than the live one.
 */
export interface RememberedWork {
  readonly sessionId: string;
  readonly offerExpiresAt: string | null;
  readonly roomName: string | null;
}

/** Never throws. A storage that rejects writes must not break the portal. */
const safely = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const isUuidish = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

export function rememberWork(host: WorkHost, work: RememberedWork): void {
  if (host.storage === null) return;
  safely(() => host.storage?.setItem(SESSION_KEY, JSON.stringify(work)), undefined);
}

/**
 * The remembered session, or null.
 *
 * The id is shape-checked before it is returned. Anything else in storage — a
 * stale format, a hand-edited value, another app's key — reads as "nothing
 * remembered", because the alternative is putting an arbitrary string into a
 * request path.
 */
export function recallWork(host: WorkHost): RememberedWork | null {
  if (host.storage === null) return null;
  const raw = safely(() => host.storage?.getItem(SESSION_KEY) ?? null, null);
  if (raw === null) return null;

  const parsed = safely<unknown>(() => JSON.parse(raw), null);
  if (parsed === null || typeof parsed !== 'object') return null;

  const value = parsed as Partial<RememberedWork>;
  if (!isUuidish(value.sessionId)) return null;

  return {
    sessionId: value.sessionId,
    offerExpiresAt: typeof value.offerExpiresAt === 'string' ? value.offerExpiresAt : null,
    roomName: typeof value.roomName === 'string' ? value.roomName : null,
  };
}

/** Forget the session and every key that belonged to it. */
export function forgetWork(host: WorkHost, sessionId?: string): void {
  if (host.storage === null) return;
  safely(() => host.storage?.removeItem(SESSION_KEY), undefined);
  if (sessionId === undefined) return;
  for (const intent of ['claim', 'accept'] as const) {
    safely(() => host.storage?.removeItem(idempotencyKeyName(intent, sessionId)), undefined);
  }
}

const idempotencyKeyName = (intent: WorkIntent, sessionId: string): string =>
  `${IDEMPOTENCY_PREFIX}${intent}.${sessionId}`;

/**
 * The idempotency key for one intent on one session, generated once.
 *
 * The first call mints and stores it; every later call returns the same string,
 * which is exactly what makes a retry a retry. A fresh key on the second press
 * would be a second operation — and against a session already claimed, it would
 * be answered by the server's "you already hold this" path rather than a replay,
 * which is correct but slower and less honest about what the button did.
 *
 * Falls back to a fresh key when storage is unavailable. That loses replay
 * protection for that one request and keeps the portal working; the server's
 * conditional updates are what actually prevent a duplicate outcome.
 */
export function idempotencyKeyFor(host: WorkHost, intent: WorkIntent, sessionId: string): string {
  const name = idempotencyKeyName(intent, sessionId);
  if (host.storage === null) return host.newKey();

  const existing = safely(() => host.storage?.getItem(name) ?? null, null);
  if (existing !== null && existing.length > 0) return existing;

  const minted = host.newKey();
  safely(() => host.storage?.setItem(name, minted), undefined);
  return minted;
}

/** The live browser host. Null storage anywhere `window` is absent. */
export function browserWorkHost(): WorkHost {
  const newKey = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (typeof window === 'undefined') return { storage: null, newKey };
  return { storage: safely(() => window.sessionStorage, null), newKey };
}
