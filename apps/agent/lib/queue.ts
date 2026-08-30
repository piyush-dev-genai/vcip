/**
 * How the portal presents the queue.
 *
 * Presentation only. Nothing here decides what an agent may see, sorts the
 * list, or derives a wait — the Control API owns all three, and a browser that
 * recomputed any of them would be inventing a second answer that drifts from
 * the server's. `GET /v1/agent/queue` already returns the sessions in FIFO
 * order with `wait_seconds` from the server clock; this turns those into
 * strings.
 *
 * Kept out of the component so it is testable under plain Node, the same split
 * as `presence.ts` and `token.ts`.
 */

import type { QueuedSession } from './api';

/**
 * How often the portal re-reads the queue.
 *
 * Five seconds, matching the heartbeat, so an agent watching the list sees a
 * new customer within about the time it takes them to read the row. It is a
 * plain read with no write behind it, so the only cost of the cadence is one
 * request; making it faster would not make a claim any sooner, because claiming
 * is not in this task.
 */
export const QUEUE_REFRESH_INTERVAL_MS = 5000;

/**
 * A waiting time, in the shortest honest form.
 *
 * Seconds under a minute, then minutes, then hours and minutes. Rounded down
 * throughout: a session that has waited 119 seconds is "1m", not "2m", because
 * overstating a wait is the direction that makes an agent think they are later
 * than they are.
 *
 * A negative value cannot arrive from the API — it clamps at zero — but is
 * treated as zero here rather than rendered, because a "-3s" on screen would be
 * a worse failure than a wrong-but-plausible "0s".
 */
export function formatWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';

  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;

  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * A short, stable label for a session.
 *
 * The API returns a UUID and nothing else identifying — no name, no reference,
 * no contact details — so the only thing to show is the id. The first segment
 * is enough to tell two rows apart on screen and short enough not to dominate
 * the row; the full value stays available as a title attribute.
 */
export function shortId(sessionId: string): string {
  const [head] = sessionId.split('-');
  return head === undefined || head.length === 0 ? sessionId : head;
}

/**
 * How long an agent has been waiting for the queue to say anything.
 *
 * `null` until the first successful read, so the panel can distinguish "empty
 * queue" from "we have not managed to ask yet" — two states that look identical
 * if both render as an empty list.
 */
export function isStale(lastReadAtMs: number | null, nowMs: number, toleranceMs: number): boolean {
  if (lastReadAtMs === null) return true;
  return nowMs - lastReadAtMs > toleranceMs;
}

/**
 * Whether two queue reads describe the same list.
 *
 * `wait_seconds` changes on every read by construction, so comparing whole
 * objects would always report a change. Membership and order are what actually
 * changed or did not.
 */
export function sameOrder(
  before: readonly QueuedSession[],
  after: readonly QueuedSession[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((session, index) => session.session_id === after[index]?.session_id);
}
