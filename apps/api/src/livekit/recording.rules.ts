/**
 * The decisions recording makes that need no I/O (T28).
 *
 * Same split as `call-events.rules.ts`: the key a recording lands under and
 * whether one should be started at all are worth testing exhaustively without
 * an egress container, and the service reads as named decisions rather than
 * string building.
 */

import { SessionStatus } from '@vcip/shared';

/**
 * Where the recording lands in the temporary bucket.
 *
 * `{session_id}.mp4`, and deliberately not LiveKit's `{room_name}-{time}`
 * template the Day-0 spike used. Three reasons:
 *
 *   - **T38 has to find it.** A key derived from the session id needs no
 *     lookup and no listing; a timestamped one would have to be discovered.
 *   - **One session records once.** R17 is room-composite: one file per
 *     session. A time component would silently permit two.
 *   - **The audit package names it.** `exports.video_key` will carry this
 *     string, and a key that cannot be recomputed from the session id is a key
 *     that has to be trusted from wherever it was stored.
 *
 * The prefix keeps the temporary bucket navigable and mirrors the `wm/` and
 * `audit/` prefixes the contract's egress payload already uses.
 */
export function recordingKeyFor(sessionId: string): string {
  return `raw/${sessionId}.mp4`;
}

/**
 * The layout LiveKit composes with.
 *
 * `grid` puts both participants side by side at equal size, which is what R17's
 * "both participants, one file — better evidence" asks for. `speaker` would
 * shrink whoever is not talking, and an identity document held up in silence is
 * exactly the frame that must not be the small one.
 *
 * No custom template. The Day-0 spike used one to prove a specific layout was
 * possible, and it needed the egress container to reach a page served from the
 * host — a dependency this product should not carry into production for a
 * layout LiveKit already provides.
 */
export const RECORDING_LAYOUT = 'grid';

/**
 * May a recording be started for a session in this status?
 *
 * `IN_CALL` only. Before that there is no room to record — LiveKit refuses
 * room-composite egress on a room nobody has joined, which is why the plan's
 * "recording start on accept" is not literally implementable and design §21.2's
 * "when the actual call begins" is what happens instead. After it, the
 * verification is over and a recording would capture an empty room.
 */
export function mayRecord(status: SessionStatus): boolean {
  return status === SessionStatus.IN_CALL;
}

/**
 * How many stalled recordings one retry pass takes.
 *
 * Bounded like the other sweepers', so a pass costs the batch rather than
 * however many starts failed while the egress container was down.
 */
export const RECORDING_RETRY_BATCH = 20;

/** Milliseconds between retry passes. */
export const RECORDING_RETRY_INTERVAL_MS = 10_000;
