import { SessionStatus, SESSION_STATUSES } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import type { SessionView } from './session';
import { STATUS_POLL_INTERVAL_MS, agentHasAccepted, shouldPoll } from './waiting';

const session = (status: SessionStatus, over: Partial<SessionView> = {}): SessionView => ({
  session_id: '11111111-1111-4111-8111-111111111111',
  status,
  language: 'en',
  room_name: 'vcip_11111111-1111-4111-8111-111111111111',
  consent_ok: true,
  preflight_ok: true,
  geo_ok: true,
  queue_position: null,
  agent_connected: false,
  queued_at: null,
  connected_at: null,
  ended_at: null,
  verdict: null,
  export_status: 'NOT_STARTED',
  ...over,
});

const POLLED: readonly SessionStatus[] = [
  SessionStatus.QUEUED,
  SessionStatus.OFFERED,
  SessionStatus.IN_CALL,
];

describe('shouldPoll', () => {
  it('polls the three states the server can leave on its own', () => {
    for (const status of POLLED) {
      expect(shouldPoll(session(status))).toBe(true);
    }
  });

  /**
   * Nothing moves a `CREATED` session but the customer, so polling their own
   * inaction is pure noise.
   */
  it('does not poll CREATED', () => {
    expect(shouldPoll(session(SessionStatus.CREATED))).toBe(false);
  });

  it('does not poll any terminal status', () => {
    for (const status of SESSION_STATUSES.filter((s) => !POLLED.includes(s))) {
      expect(shouldPoll(session(status))).toBe(false);
    }
  });

  it('does not poll before the first read has landed', () => {
    expect(shouldPoll(null)).toBe(false);
  });

  it('stops as soon as a call ends', () => {
    expect(shouldPoll(session(SessionStatus.IN_CALL))).toBe(true);
    expect(shouldPoll(session(SessionStatus.APPROVED))).toBe(false);
    expect(shouldPoll(session(SessionStatus.DROPPED_IN_CALL))).toBe(false);
  });
});

describe('agentHasAccepted', () => {
  it('is true exactly when the session is IN_CALL', () => {
    expect(agentHasAccepted(session(SessionStatus.IN_CALL))).toBe(true);
    for (const status of SESSION_STATUSES.filter((s) => s !== SessionStatus.IN_CALL)) {
      expect(agentHasAccepted(session(status))).toBe(false);
    }
  });

  /**
   * The two fields answer different questions. `status` is the business fact
   * that an agent accepted (T19); `agent_connected` is derived from LiveKit's
   * webhook (T26) and says whether they are attached right now. Joining on the
   * second would have both parties waiting for the other to arrive.
   */
  it('reads the status, not agent_connected', () => {
    expect(agentHasAccepted(session(SessionStatus.IN_CALL, { agent_connected: false }))).toBe(true);
    expect(agentHasAccepted(session(SessionStatus.QUEUED, { agent_connected: true }))).toBe(false);
  });
});

describe('the interval', () => {
  it('is fast enough to feel immediate and slow enough to be a fallback', () => {
    expect(STATUS_POLL_INTERVAL_MS).toBe(3000);
  });
});
