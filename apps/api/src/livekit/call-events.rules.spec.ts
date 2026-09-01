import { describe, expect, it } from 'vitest';
import type { CallWebhookEvent } from './call-events.rules.js';
import { DUPLICATE_IDENTITY, bothPresent, classify } from './call-events.rules.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ROOM = `vcip_${SESSION}`;

const event = (over: Partial<CallWebhookEvent> = {}): CallWebhookEvent => ({
  event: 'participant_joined',
  id: 'EV_test',
  roomName: ROOM,
  participantIdentity: 'customer',
  disconnectReason: null,
  ...over,
});

describe('joining', () => {
  it('resolves the session from the room name', () => {
    expect(classify(event())).toEqual({ kind: 'JOINED', sessionId: SESSION, role: 'customer' });
  });

  it('reads the agent too', () => {
    expect(classify(event({ participantIdentity: 'agent' }))).toEqual({
      kind: 'JOINED',
      sessionId: SESSION,
      role: 'agent',
    });
  });
});

describe('leaving', () => {
  it('is a departure', () => {
    expect(classify(event({ event: 'participant_left' }))).toEqual({
      kind: 'LEFT',
      sessionId: SESSION,
      role: 'customer',
    });
  });

  /**
   * The case that would otherwise arm a window against someone who is already
   * back. One session is one room and T24 mints the identity from the role, so
   * a reconnection evicts the previous connection and LiveKit reports the
   * eviction as a departure.
   */
  it('ignores a duplicate-identity eviction, which is a reconnection', () => {
    const action = classify(
      event({ event: 'participant_left', disconnectReason: DUPLICATE_IDENTITY }),
    );
    expect(action.kind).toBe('IGNORE');
  });

  it('treats a client-initiated departure as a real one', () => {
    // 1 is CLIENT_INITIATED: a closed tab and a page reload look identical
    // here, which is exactly why a grace window exists downstream.
    expect(classify(event({ event: 'participant_left', disconnectReason: 1 })).kind).toBe('LEFT');
  });
});

describe('rooms this product did not name', () => {
  it('ignores a room that is not vcip_{uuid}', () => {
    for (const roomName of ['spike-room', 'vcip_', 'vcip_not-a-uuid', 'other_' + SESSION]) {
      expect(classify(event({ roomName })).kind).toBe('IGNORE');
    }
  });

  it('ignores an event with no room at all', () => {
    expect(classify(event({ roomName: null })).kind).toBe('IGNORE');
  });
});

describe('participants this product has no tile for', () => {
  it('ignores an unknown identity', () => {
    // T30's analyzer will be exactly this.
    expect(classify(event({ participantIdentity: 'analyzer' })).kind).toBe('IGNORE');
  });

  it('ignores a participant event with no identity', () => {
    expect(classify(event({ participantIdentity: null })).kind).toBe('IGNORE');
  });
});

describe('events this product does not model', () => {
  it.each(['track_published', 'track_unpublished', 'room_started', 'egress_started', 'nonsense'])(
    'ignores %s',
    (name) => {
      expect(classify(event({ event: name })).kind).toBe('IGNORE');
    },
  );

  it('handles room_finished, which needs no participant', () => {
    expect(classify(event({ event: 'room_finished', participantIdentity: null }))).toEqual({
      kind: 'ROOM_CLOSED',
      sessionId: SESSION,
    });
  });

  /**
   * Total and forgiving on purpose: LiveKit retries a non-2xx, so an event
   * nothing will ever accept must not be reported as a failure.
   */
  it('never throws, whatever it is given', () => {
    const shapes: CallWebhookEvent[] = [
      event({ event: '' }),
      event({ roomName: '' }),
      event({ participantIdentity: '' }),
      event({ event: 'participant_left', participantIdentity: null }),
    ];
    for (const shape of shapes) expect(() => classify(shape)).not.toThrow();
  });
});

describe('bothPresent', () => {
  /**
   * The rule the whole task turns on: a verification begins when both parties
   * can see each other, not when either one arrives. `talk_ms` is measured from
   * it and the evidence package will claim it.
   */
  it('is true only with both roles in the room', () => {
    expect(bothPresent(['customer', 'agent'])).toBe(true);
    expect(bothPresent(['agent', 'customer'])).toBe(true);
  });

  it('is false for either one alone', () => {
    expect(bothPresent(['agent'])).toBe(false);
    expect(bothPresent(['customer'])).toBe(false);
    expect(bothPresent([])).toBe(false);
  });

  it('is not satisfied by a third participant standing in for the other', () => {
    expect(bothPresent(['agent', 'analyzer'])).toBe(false);
    expect(bothPresent(['customer', 'analyzer'])).toBe(false);
  });
});
