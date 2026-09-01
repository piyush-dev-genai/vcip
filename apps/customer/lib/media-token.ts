/**
 * When a media token is worth connecting with (T25).
 *
 * T24 mints these with a fifteen-minute lifetime, and R2 means one can be
 * issued while the session is still `QUEUED` — before there is an agent to talk
 * to. So the token a tab fetched when the customer joined the queue may well be
 * dead by the time an agent accepts, and the tab has to notice that *before*
 * opening a connection rather than after LiveKit refuses it.
 *
 * Nothing here decides whether a token is valid. The signature and the room
 * binding are the server's business, and `expires_at` is the server's own word
 * about lifetime, reported verbatim. This only answers "is it worth trying".
 */

/**
 * How much life a token must have left before it is used.
 *
 * Sixty seconds. Connecting is not instant — a token fetch, an ICE negotiation,
 * and a camera prompt can sit between deciding to join and actually joining —
 * and a token that expires mid-handshake fails in a way that looks like a
 * broken call rather than an expired credential. Refetching is a GET that
 * changes no state, so the margin costs nothing but a request.
 */
export const TOKEN_MIN_REMAINING_MS = 60_000;

/**
 * Is this token still worth connecting with?
 *
 * A missing or unparseable `expires_at` reads as unusable. That is the safe
 * direction: the remedy is fetching another token, which is cheap, whereas
 * trusting a timestamp nobody could parse means connecting with a credential
 * of unknown age.
 */
export function tokenUsable(
  expiresAt: string | null,
  nowMs: number,
  marginMs: number = TOKEN_MIN_REMAINING_MS,
): boolean {
  if (expiresAt === null) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - nowMs >= marginMs;
}

/** A media token as the Control API returns it (contract §13). */
export interface MediaToken {
  readonly room_name: string;
  readonly token: string;
  readonly expires_at: string;
}

/**
 * The token to use for a connection, or null when a fresh one is needed.
 *
 * Kept as a function rather than folded into the component so "reuse the token
 * we already have" is a rule with a name and a test, instead of a condition
 * inside an effect that nobody can exercise.
 */
export function reusableToken(
  held: MediaToken | null,
  nowMs: number,
  marginMs: number = TOKEN_MIN_REMAINING_MS,
): MediaToken | null {
  if (held === null) return null;
  return tokenUsable(held.expires_at, nowMs, marginMs) ? held : null;
}
