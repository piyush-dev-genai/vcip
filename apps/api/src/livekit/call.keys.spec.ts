import { describe, expect, it } from 'vitest';
import {
  CALL_ROLES,
  CUSTOMER_GRACE_SECONDS,
  DEADLINES_KEY,
  deadlineAt,
  deadlineMember,
  isCallRole,
  parseDeadlineMember,
  participantsKey,
  seenEventKey,
  sessionIdFromRoom,
} from './call.keys.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

describe('sessionIdFromRoom', () => {
  it('reverses the room name R2 assigns at creation', () => {
    expect(sessionIdFromRoom(`vcip_${SESSION}`)).toBe(SESSION);
  });

  it('lower-cases, so a room name cannot produce two session ids', () => {
    expect(sessionIdFromRoom(`vcip_${SESSION.toUpperCase()}`)).toBe(SESSION);
  });

  /**
   * `auto_create` is on in `infra/livekit.yaml` for the Day-0 spikes, so rooms
   * genuinely exist in this deployment that this product did not name. A loose
   * parse would have the webhook acting on one of them.
   */
  it('refuses anything that is not exactly vcip_{uuid}', () => {
    for (const name of [
      'spike-room',
      'vcip_',
      'vcip_not-a-uuid',
      `vcip_${SESSION}extra`,
      `prefix_vcip_${SESSION}`,
      SESSION,
      '',
    ]) {
      expect(sessionIdFromRoom(name)).toBeNull();
    }
  });
});

describe('roles', () => {
  it('knows the two identities T24 mints', () => {
    expect([...CALL_ROLES].sort()).toEqual(['agent', 'customer']);
    expect(isCallRole('customer')).toBe(true);
    expect(isCallRole('agent')).toBe(true);
  });

  it('rejects anything else, including case variants', () => {
    for (const value of ['analyzer', 'Agent', 'CUSTOMER', '', 'egress']) {
      expect(isCallRole(value)).toBe(false);
    }
  });
});

describe('deadline members', () => {
  it('round-trips a session and a role', () => {
    for (const role of CALL_ROLES) {
      expect(parseDeadlineMember(deadlineMember(SESSION, role))).toEqual({
        sessionId: SESSION,
        role,
      });
    }
  });

  /**
   * The role is in the member because the two deadlines end the session
   * differently — customer to `DROPPED_IN_CALL`, agent to `ABORTED` (R4, D18).
   */
  it('keeps the two roles distinguishable', () => {
    expect(deadlineMember(SESSION, 'customer')).not.toBe(deadlineMember(SESSION, 'agent'));
  });

  it('returns null for anything unreadable, so the sweeper can discard it', () => {
    for (const member of ['', ':', SESSION, `${SESSION}:analyzer`, 'nonsense:agent', ':agent']) {
      expect(parseDeadlineMember(member)).toBeNull();
    }
  });
});

describe('keys', () => {
  it('namespaces the participant set by session', () => {
    expect(participantsKey(SESSION)).toBe(`call:${SESSION}:participants`);
  });

  it('uses one sorted set for every deadline', () => {
    expect(DEADLINES_KEY).toBe('call:deadlines');
  });

  it('namespaces a seen delivery by its LiveKit event id', () => {
    expect(seenEventKey('EV_abc')).toBe('call:seen:EV_abc');
  });
});

describe('deadlineAt', () => {
  it('adds the window to the departure', () => {
    const departed = new Date('2026-09-01T12:00:00.000Z');
    expect(deadlineAt(departed, 20)).toBe(Date.parse('2026-09-01T12:00:20.000Z'));
  });

  it('does not mutate the instant it was given', () => {
    const departed = new Date('2026-09-01T12:00:00.000Z');
    deadlineAt(departed, 60);
    expect(departed.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });
});

describe('the customer grace window', () => {
  /**
   * Twenty seconds, matching `departure_timeout` in `infra/livekit.yaml` so the
   * room outlives the window that decides whether to end the session.
   */
  it('is twenty seconds', () => {
    expect(CUSTOMER_GRACE_SECONDS).toBe(20);
  });

  it('is long enough for a page reload to complete', () => {
    // The whole reason it exists: a reload and a closed tab arrive identically.
    expect(CUSTOMER_GRACE_SECONDS).toBeGreaterThanOrEqual(10);
  });
});
