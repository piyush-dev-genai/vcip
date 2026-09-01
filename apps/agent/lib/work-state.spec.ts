/**
 * Where the agent lands, for every answer the server can give (T21).
 *
 * These are the portal's screen transitions, extracted from the component the
 * way `apps/customer/lib/screen.ts` is, so they can be tested exhaustively
 * under plain Node rather than sampled through a rendered tree.
 *
 * The property under test throughout is the same one: **the server's answer is
 * the state.** Every case here starts from a response and asserts where the
 * agent ends up. None of them starts from something the browser decided.
 */

import { SessionStatus } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import type { Work } from './work-state';
import {
  UNCONFIRMED,
  WorkScreen,
  afterAccept,
  afterClaim,
  afterRead,
  afterWorkRead,
  workScreen,
} from './work-state';

const SESSION = '11111111-2222-4333-8444-555555555555';
const EXPIRES = '2026-09-01T10:00:30.000Z';

const offered: Work = {
  sessionId: SESSION,
  status: SessionStatus.OFFERED,
  offerExpiresAt: EXPIRES,
  roomName: null,
};

describe('workScreen', () => {
  it('shows the queue when the agent holds nothing', () => {
    expect(workScreen(null)).toBe(WorkScreen.QUEUE);
  });

  it('shows the offer for a held offer', () => {
    expect(workScreen(offered)).toBe(WorkScreen.OFFER);
  });

  it('shows the call for an accepted session', () => {
    expect(workScreen({ ...offered, status: SessionStatus.IN_CALL })).toBe(WorkScreen.CALL);
  });

  it('shows "checking" for work recovered but not yet confirmed', () => {
    // The reload case. The portal knows an id and nothing else, and must not
    // render an offer or a call it has not been told about.
    expect(workScreen({ ...offered, status: UNCONFIRMED })).toBe(WorkScreen.CHECKING);
  });

  it('never shows an offer or a call for any other status', () => {
    for (const status of [
      SessionStatus.CREATED,
      SessionStatus.QUEUED,
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
      SessionStatus.PREFLIGHT_FAILED,
    ]) {
      expect(workScreen({ ...offered, status })).toBe(WorkScreen.CHECKING);
    }
  });
});

describe('afterClaim', () => {
  const result = {
    session_id: SESSION,
    status: SessionStatus.OFFERED,
    offered_to_agent_id: 'agent-1',
    offer_expires_at: EXPIRES,
  };

  it('puts the agent on the offer screen', () => {
    expect(workScreen(afterClaim(result))).toBe(WorkScreen.OFFER);
  });

  it('reports the server expiry verbatim', () => {
    // Not recomputed, not rounded, not re-based on the local clock.
    expect(afterClaim(result).offerExpiresAt).toBe(EXPIRES);
  });

  it('takes the status from the response rather than assuming OFFERED', () => {
    const surprising = { ...result, status: SessionStatus.IN_CALL };
    expect(afterClaim(surprising).status).toBe(SessionStatus.IN_CALL);
    expect(workScreen(afterClaim(surprising))).toBe(WorkScreen.CALL);
  });

  it('carries no room name, because a claim does not report one', () => {
    expect(afterClaim(result).roomName).toBeNull();
  });
});

describe('afterAccept', () => {
  const result = {
    session_id: SESSION,
    status: SessionStatus.IN_CALL,
    agent_id: 'agent-1',
    room_name: `vcip_${SESSION}`,
  };

  it('puts the agent on the call screen', () => {
    expect(workScreen(afterAccept(result))).toBe(WorkScreen.CALL);
  });

  it('keeps the room name the server returned', () => {
    expect(afterAccept(result).roomName).toBe(`vcip_${SESSION}`);
  });

  it('drops the offer window', () => {
    // A call cannot lapse, and a lingering expiry would count down against it.
    expect(afterAccept(result).offerExpiresAt).toBeNull();
  });

  it('survives a null room name without inventing one', () => {
    expect(afterAccept({ ...result, room_name: null }).roomName).toBeNull();
  });
});

describe('afterRead', () => {
  it('keeps the agent on the offer while the server still says OFFERED', () => {
    const next = afterRead(offered, { status: SessionStatus.OFFERED, room_name: null });
    expect(workScreen(next)).toBe(WorkScreen.OFFER);
  });

  it('carries the known offer window across a poll', () => {
    // The read cannot report it, and blanking it would clear a live countdown
    // every two seconds.
    const next = afterRead(offered, { status: SessionStatus.OFFERED, room_name: null });
    expect(next?.offerExpiresAt).toBe(EXPIRES);
  });

  it('moves to the call when the server says IN_CALL', () => {
    // Covers the accept landing, and the reload-during-a-call recovery: the
    // portal knew only an id and the read placed it.
    const recovering: Work = { ...offered, status: UNCONFIRMED, offerExpiresAt: null };
    const next = afterRead(recovering, {
      status: SessionStatus.IN_CALL,
      room_name: `vcip_${SESSION}`,
    });
    expect(workScreen(next)).toBe(WorkScreen.CALL);
    expect(next?.roomName).toBe(`vcip_${SESSION}`);
  });

  it('recovers an offer from an unconfirmed id', () => {
    const recovering: Work = { ...offered, status: UNCONFIRMED };
    const next = afterRead(recovering, { status: SessionStatus.OFFERED, room_name: null });
    expect(workScreen(next)).toBe(WorkScreen.OFFER);
    // The window remembered from the claim is what makes the countdown work
    // after a reload.
    expect(next?.offerExpiresAt).toBe(EXPIRES);
  });

  it('returns the agent to the queue when the sweeper took the offer back', () => {
    // The expired-offer case, and the answer comes from the server, not from a
    // timer: the read says QUEUED, so the portal stops holding it.
    expect(afterRead(offered, { status: SessionStatus.QUEUED, room_name: null })).toBeNull();
  });

  it('returns the agent to the queue for any ended session', () => {
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(afterRead(offered, { status, room_name: null })).toBeNull();
    }
  });

  it('returns the agent to the queue for a status it does not recognise', () => {
    // Rather than rendering a screen built for a different state.
    expect(afterRead(offered, { status: 'SOMETHING_NEW', room_name: null })).toBeNull();
  });

  it('never changes which session is held', () => {
    const next = afterRead(offered, { status: SessionStatus.IN_CALL, room_name: null });
    expect(next?.sessionId).toBe(SESSION);
  });

  it('drops the offer window once the session is in a call', () => {
    const next = afterRead(offered, { status: SessionStatus.IN_CALL, room_name: null });
    expect(next?.offerExpiresAt).toBeNull();
  });
});

describe('afterWorkRead', () => {
  it('takes the server answer verbatim, already confirmed', () => {
    const work = afterWorkRead({
      session_id: 'session-1',
      status: 'IN_CALL',
      room_name: 'vcip_session-1',
      offer_expires_at: null,
    });
    expect(work).toEqual({
      sessionId: 'session-1',
      status: 'IN_CALL',
      offerExpiresAt: null,
      roomName: 'vcip_session-1',
    });
  });

  /**
   * The difference from a recovered storage entry: that arrives UNCONFIRMED and
   * sends the portal to the checking screen. This is the server's own word, so
   * it routes straight to the call.
   */
  it('lands the portal on a real screen, not on checking', () => {
    const work = afterWorkRead({
      session_id: 'session-1',
      status: 'IN_CALL',
      room_name: null,
      offer_expires_at: null,
    });
    expect(work.status).not.toBe(UNCONFIRMED);
    expect(workScreen(work)).toBe(WorkScreen.CALL);
  });

  it('routes a held offer to the offer screen, with its window', () => {
    const work = afterWorkRead({
      session_id: 'session-1',
      status: 'OFFERED',
      room_name: null,
      offer_expires_at: '2026-09-01T12:00:30.000Z',
    });
    expect(workScreen(work)).toBe(WorkScreen.OFFER);
    expect(work.offerExpiresAt).toBe('2026-09-01T12:00:30.000Z');
  });
});
