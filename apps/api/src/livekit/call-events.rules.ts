/**
 * What a LiveKit webhook event means, as pure functions (T26).
 *
 * Same split as `agent-claim.rules.ts`: everything here is a function of values
 * already delivered, so the whole classification can be tested exhaustively
 * without a signing key, a Redis, a database, or a Nest container — and the
 * service reads as a sequence of named decisions rather than a switch inside a
 * switch.
 *
 * Nothing here decides a session's status. It decides what *kind* of thing
 * happened; whether the session may move is PostgreSQL's, checked by a guarded
 * UPDATE the service issues afterwards (D1).
 */

import type { CallRole } from './call.keys.js';
import { isCallRole, sessionIdFromRoom } from './call.keys.js';

/**
 * The events this product acts on.
 *
 * LiveKit sends more than these — `track_published`, `room_started`, the
 * `egress_*` family. They are not ignored by accident: tracks are not a
 * lifecycle fact this system records, a room starting says nothing a
 * participant joining does not, and egress belongs to T28.
 */
export const HANDLED_EVENTS = Object.freeze([
  'participant_joined',
  'participant_left',
  'room_finished',
] as const);

/**
 * A webhook event, narrowed to what this module reads.
 *
 * Declared structurally rather than taking the SDK's class, so the rules do not
 * depend on `@livekit/protocol` and a test can build one from an object
 * literal.
 */
export interface CallWebhookEvent {
  readonly event: string;
  readonly id: string;
  readonly roomName: string | null;
  readonly participantIdentity: string | null;
  /** LiveKit's `DisconnectReason`, or null when the event carries none. */
  readonly disconnectReason: number | null;
}

/**
 * `DisconnectReason.DUPLICATE_IDENTITY`.
 *
 * The value matters more than it looks. One session is one room and T24 mints
 * the identity from the role, so when a participant reconnects, LiveKit evicts
 * the previous connection with this reason and sends a `participant_left` for
 * it. That departure is not a departure — the person is arriving, not leaving —
 * and acting on it would arm a deadline against someone who is already back.
 */
export const DUPLICATE_IDENTITY = 2;

/**
 * What the service should do about an event.
 *
 * A discriminated union rather than a set of booleans, because the four
 * outcomes are genuinely different operations and the caller must handle each.
 */
export type CallAction =
  /** Nothing this product records. Not an error. */
  | { readonly kind: 'IGNORE'; readonly reason: string }
  /** A participant is in the room. */
  | { readonly kind: 'JOINED'; readonly sessionId: string; readonly role: CallRole }
  /** A participant has gone, and is not merely reconnecting. */
  | { readonly kind: 'LEFT'; readonly sessionId: string; readonly role: CallRole }
  /** The room closed. Any armed deadline for it is moot. */
  | { readonly kind: 'ROOM_CLOSED'; readonly sessionId: string };

const ignore = (reason: string): CallAction => ({ kind: 'IGNORE', reason });

/**
 * Classify one event.
 *
 * Total, and deliberately forgiving: an event this product does not model, a
 * room whose name is not a session's, and an identity that is not one of the
 * two roles are all `IGNORE` rather than failures. A webhook receiver that
 * threw on those would make LiveKit retry an event nothing will ever accept,
 * and the Day-0 spikes create rooms in this very deployment that fit none of
 * the patterns.
 */
export function classify(event: CallWebhookEvent): CallAction {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.event)) {
    return ignore(`unhandled event ${event.event}`);
  }

  if (event.roomName === null) return ignore('event carries no room');

  const sessionId = sessionIdFromRoom(event.roomName);
  // Not one of ours. `auto_create` is on, so rooms genuinely exist here that
  // this product did not name.
  if (sessionId === null) return ignore('room is not a session room');

  if (event.event === 'room_finished') return { kind: 'ROOM_CLOSED', sessionId };

  const identity = event.participantIdentity;
  if (identity === null) return ignore('participant event carries no identity');
  // T30's analyzer will be a third identity with no lifecycle meaning here.
  if (!isCallRole(identity)) return ignore(`identity ${identity} is not a call role`);

  if (event.event === 'participant_joined') {
    return { kind: 'JOINED', sessionId, role: identity };
  }

  // A duplicate-identity eviction is the *old* connection being replaced by a
  // new one that has already arrived. Treating it as a departure would arm a
  // deadline against a participant who is in the room.
  if (event.disconnectReason === DUPLICATE_IDENTITY) {
    return ignore('duplicate identity: the participant reconnected');
  }

  return { kind: 'LEFT', sessionId, role: identity };
}

/**
 * Is the call under way?
 *
 * **Both** participants have to be in the room. An agent alone is an agent
 * waiting; a customer alone is a customer waiting. `CALL_STARTED` is the fact
 * that a verification actually began, it is what `talk_ms` is measured from,
 * and it is what the evidence package will claim — so it must not be recorded
 * for a room only one party ever reached.
 */
export function bothPresent(roles: readonly string[]): boolean {
  return roles.includes('customer') && roles.includes('agent');
}
