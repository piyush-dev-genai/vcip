/**
 * The call lifecycle's addressing rules, as pure functions (T26).
 *
 * Isolated from anything that touches Redis for the reason `queue.keys.ts` is:
 * the decisions below are load-bearing, and they should be readable and
 * testable in one place without a server.
 *
 * **What Redis holds here, and why it is allowed to.** Two things: which roles
 * are currently in a room, and when a departed participant stops being given
 * the benefit of the doubt. Both are transient real-time state, which is
 * exactly what D2 reserves Redis for. Neither is authoritative for anything: a
 * session's status is PostgreSQL's (D1), and every transition this module
 * eventually causes goes through a guarded UPDATE that re-checks it.
 *
 * **Why the deadline is a ZSET and not a key with a TTL.** A key that expires
 * is a key that is gone, and a sweeper looking for expired deadlines would find
 * nothing — the very moment the deadline matters is the moment the evidence
 * disappears. The score *is* the deadline, the member outlives it, and the
 * sweeper asks for everything due. Same shape as T15's queue, for the same
 * reason: Redis is being used as an ordered index, not as a timer.
 */

/**
 * The two roles a participant can hold in a V-CIP room (design §11.2).
 *
 * Re-stated here rather than imported from the browser apps: this is the
 * server's own vocabulary, and T24 is what puts these strings into a token's
 * identity in the first place.
 */
export const CallRole = {
  CUSTOMER: 'customer',
  AGENT: 'agent',
} as const;

export type CallRole = (typeof CallRole)[keyof typeof CallRole];

export const CALL_ROLES: readonly CallRole[] = Object.freeze(Object.values(CallRole));

/** Is this identity one of the two roles the product knows? */
export function isCallRole(value: string): value is CallRole {
  return (CALL_ROLES as readonly string[]).includes(value);
}

/**
 * The room name a session's media uses (R2), reversed.
 *
 * A webhook names a room, not a session, so this is how a LiveKit event finds
 * the row it is about. It is deliberately strict: anything that is not exactly
 * `vcip_{uuid}` returns null rather than a guess. LiveKit's `auto_create` is on
 * for the Day-0 spikes, so rooms with unrelated names genuinely do exist, and a
 * loose parse would have this module acting on one of them.
 */
const ROOM_PREFIX = 'vcip_';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sessionIdFromRoom(roomName: string): string | null {
  if (!roomName.startsWith(ROOM_PREFIX)) return null;
  const candidate = roomName.slice(ROOM_PREFIX.length);
  return UUID.test(candidate) ? candidate.toLowerCase() : null;
}

/** Who is in the room right now: `call:{session_id}:participants`. */
export function participantsKey(sessionId: string): string {
  return `call:${sessionId}:participants`;
}

/**
 * How long the participant set outlives the call.
 *
 * Twelve hours. It is a cache of a fact LiveKit owns, so it only has to survive
 * the longest plausible verification; the expiry exists so an abandoned room
 * cannot leak a key forever. Nothing reads it after the session is terminal.
 */
export const PARTICIPANTS_TTL_SECONDS = 12 * 60 * 60;

/** Every armed deadline, scored by the instant it falls due. One ZSET. */
export const DEADLINES_KEY = 'call:deadlines';

/**
 * A deadline's member: `{session_id}:{role}`.
 *
 * The role is in the member, not in a second key, because the two deadlines
 * mean different things and end the session differently — a customer who does
 * not come back is `DROPPED_IN_CALL`, an agent who does not is `ABORTED` (R4,
 * D18). Encoding it here means the sweeper reads the outcome off the member
 * rather than inferring it from which key it came from.
 */
export function deadlineMember(sessionId: string, role: CallRole): string {
  return `${sessionId}:${role}`;
}

export interface ParsedDeadline {
  readonly sessionId: string;
  readonly role: CallRole;
}

/**
 * Read a member back.
 *
 * Null for anything malformed, which the sweeper drops rather than acts on. A
 * member it cannot parse is a member it cannot resolve to a session, and
 * guessing would mean terminating a call on the strength of a corrupt string.
 */
export function parseDeadlineMember(member: string): ParsedDeadline | null {
  const separator = member.lastIndexOf(':');
  if (separator <= 0) return null;
  const sessionId = member.slice(0, separator);
  const role = member.slice(separator + 1);
  if (!UUID.test(sessionId) || !isCallRole(role)) return null;
  return { sessionId: sessionId.toLowerCase(), role };
}

/** The instant a departure stops being forgiven. */
export function deadlineAt(departedAt: Date, graceSeconds: number): number {
  return departedAt.getTime() + graceSeconds * 1000;
}

/**
 * How long a customer has to come back before the session is dropped.
 *
 * Twenty seconds, matching `departure_timeout` in `infra/livekit.yaml` so the
 * room outlives the window that decides whether to end the session.
 *
 * A window is needed at all because a page reload is indistinguishable from a
 * closed tab at the instant the participant leaves: both arrive as
 * `participant_left` with `CLIENT_INITIATED`. T25's customer app rejoins
 * automatically on reload, so without this a refresh mid-verification would end
 * the session and charge the customer Rs 5 for it.
 *
 * Not tenant-configurable, unlike the agent's window: there is no column for it
 * (D18 provides only `agent_reconnect_timeout_seconds`), and inventing one to
 * make this symmetric would be adding schema for a number nobody has asked to
 * vary.
 */
export const CUSTOMER_GRACE_SECONDS = 20;

/** Seen webhook event ids, for replay suppression: `call:seen:{event_id}`. */
export function seenEventKey(eventId: string): string {
  return `call:seen:${eventId}`;
}

/**
 * How long a delivered event id is remembered.
 *
 * One hour, comfortably longer than LiveKit's own retry window. This is a
 * best-effort suppression, not the correctness guarantee: every action this
 * module takes is idempotent on its own — appending `CALL_STARTED` is guarded
 * by PostgreSQL, and ending a call is guarded on `status = 'IN_CALL'`. The key
 * exists to stop duplicate work and duplicate log lines, not to stop a second
 * charge.
 */
export const SEEN_EVENT_TTL_SECONDS = 60 * 60;
