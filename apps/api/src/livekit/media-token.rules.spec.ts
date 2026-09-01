import { SessionStatus, SESSION_STATUSES } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MEDIA_STATUSES,
  CUSTOMER_MEDIA_STATUSES,
  MediaRole,
  decideMediaToken,
  mediaTokenExpiresAt,
} from './media-token.rules.js';

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';

const customer = (status: SessionStatus) =>
  decideMediaToken({
    role: MediaRole.CUSTOMER,
    status,
    assignedAgentId: null,
    requestingAgentId: null,
  });

const agent = (
  status: SessionStatus,
  assignedAgentId: string | null,
  requestingAgentId: string | null = AGENT,
) =>
  decideMediaToken({
    role: MediaRole.AGENT,
    status,
    assignedAgentId,
    requestingAgentId,
  });

describe('decideMediaToken — customer', () => {
  it('allows QUEUED, because R2 names the room at creation', () => {
    expect(customer(SessionStatus.QUEUED)).toEqual({
      kind: 'ALLOWED',
      role: MediaRole.CUSTOMER,
    });
  });

  it('allows IN_CALL', () => {
    expect(customer(SessionStatus.IN_CALL)).toEqual({
      kind: 'ALLOWED',
      role: MediaRole.CUSTOMER,
    });
  });

  /**
   * The whole-enum sweep, not a list of interesting cases. A status added to
   * `@vcip/shared` later is refused here by default and has to be argued into
   * the allow-list, which is the direction a permission check should fail in.
   */
  it.each(SESSION_STATUSES.filter((status) => !CUSTOMER_MEDIA_STATUSES.includes(status)))(
    'refuses %s',
    (status) => {
      expect(customer(status)).toEqual({ kind: 'WRONG_STATE' });
    },
  );

  it('refuses CREATED, before consent and preflight have passed', () => {
    expect(customer(SessionStatus.CREATED)).toEqual({ kind: 'WRONG_STATE' });
  });

  it('refuses OFFERED — an offer is the agent’s window, not the customer’s call', () => {
    expect(customer(SessionStatus.OFFERED)).toEqual({ kind: 'WRONG_STATE' });
  });

  it('refuses every terminal status', () => {
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(customer(status)).toEqual({ kind: 'WRONG_STATE' });
    }
  });
});

describe('decideMediaToken — agent', () => {
  it('allows the assigned agent on an IN_CALL session', () => {
    expect(agent(SessionStatus.IN_CALL, AGENT)).toEqual({
      kind: 'ALLOWED',
      role: MediaRole.AGENT,
    });
  });

  it('refuses another agent’s IN_CALL session', () => {
    expect(agent(SessionStatus.IN_CALL, OTHER_AGENT)).toEqual({ kind: 'NOT_ASSIGNED' });
  });

  it('refuses an IN_CALL session with no assigned agent', () => {
    // T19 writes `status` and `agent_id` in one statement, so this row should
    // not exist. If it ever did, "nobody" must not read as "you".
    expect(agent(SessionStatus.IN_CALL, null)).toEqual({ kind: 'NOT_ASSIGNED' });
  });

  it('refuses a caller with no agent id, even on their own row', () => {
    expect(agent(SessionStatus.IN_CALL, null, null)).toEqual({ kind: 'NOT_ASSIGNED' });
  });

  it.each(SESSION_STATUSES.filter((status) => !AGENT_MEDIA_STATUSES.includes(status)))(
    'refuses %s even for the assigned agent',
    (status) => {
      expect(agent(status, AGENT)).toEqual({ kind: 'WRONG_STATE' });
    },
  );

  it('refuses OFFERED — holding an offer is not being on the call', () => {
    expect(agent(SessionStatus.OFFERED, AGENT)).toEqual({ kind: 'WRONG_STATE' });
  });

  /**
   * Status is checked before assignment, so an agent asking about a session
   * they have no relationship with learns only that the state is wrong. Being
   * told "assigned to someone else" would be a statement about a session that
   * is none of their business.
   */
  it('reports the state, not the assignment, when both are wrong', () => {
    expect(agent(SessionStatus.QUEUED, OTHER_AGENT)).toEqual({ kind: 'WRONG_STATE' });
  });
});

describe('the allow-lists', () => {
  it('permits the customer strictly more states than the agent', () => {
    for (const status of AGENT_MEDIA_STATUSES) {
      expect(CUSTOMER_MEDIA_STATUSES).toContain(status);
    }
    expect(CUSTOMER_MEDIA_STATUSES.length).toBeGreaterThan(AGENT_MEDIA_STATUSES.length);
  });

  it('is frozen, so no caller can widen the permission at runtime', () => {
    expect(Object.isFrozen(CUSTOMER_MEDIA_STATUSES)).toBe(true);
    expect(Object.isFrozen(AGENT_MEDIA_STATUSES)).toBe(true);
  });
});

describe('mediaTokenExpiresAt', () => {
  it('adds the TTL to the instant it was given', () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    expect(mediaTokenExpiresAt(now, 900).toISOString()).toBe('2026-09-01T10:15:00.000Z');
  });

  it('does not mutate the clock reading it was handed', () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    mediaTokenExpiresAt(now, 900);
    expect(now.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });
});
