/**
 * The offer countdown (T21).
 *
 * Everything here is a **hint**. The server decides when an offer has lapsed —
 * the accept's `WHERE offer_expires_at > :now` and the sweeper's `<= :now` are
 * the only two opinions that matter, and they are evaluated against the
 * database's clock, not the browser's.
 *
 * That is why nothing in this file returns "the offer is dead". It returns how
 * many seconds are left *to display*, and whether the countdown has run out —
 * which the portal treats as a cue to go and ask, never as an answer. A tab
 * whose clock is two minutes fast would otherwise decide, entirely on its own,
 * that work it is still holding is gone.
 */

/**
 * How often the portal re-reads a session it is holding.
 *
 * Faster than the queue's 5s: the default offer window is 30 seconds, so a
 * two-second read keeps the countdown honest without making the window itself
 * the thing being tested.
 */
export const OFFER_POLL_INTERVAL_MS = 2000;

/**
 * Seconds left on an offer, for display.
 *
 * Never negative and never null: a lapsed offer reads as `0`, which is what a
 * countdown should show while the portal goes and asks what actually happened.
 */
export function remainingSeconds(offerExpiresAt: string | null, nowMs: number): number {
  if (offerExpiresAt === null) return 0;
  const expiresAt = Date.parse(offerExpiresAt);
  // An unparseable timestamp is not a reason to guess. Zero sends the portal
  // to the server, which is where the answer lives anyway.
  if (Number.isNaN(expiresAt)) return 0;
  return Math.max(0, Math.ceil((expiresAt - nowMs) / 1000));
}

/**
 * Has the displayed countdown run out?
 *
 * Deliberately *not* named `hasExpired`. It answers a question about this
 * browser's clock and this rendered number, and the portal's only legitimate
 * response is to refresh from the server.
 */
export function countdownFinished(offerExpiresAt: string | null, nowMs: number): boolean {
  return remainingSeconds(offerExpiresAt, nowMs) === 0;
}

/** `0:07`. Seconds only would read oddly for a longer tenant timeout. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
