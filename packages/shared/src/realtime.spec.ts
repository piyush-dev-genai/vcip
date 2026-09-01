import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENTS,
  AgentEvent,
  CUSTOMER_EVENTS,
  CustomerEvent,
  REALTIME_EVENTS,
  RealtimeAudience,
  isAgentEvent,
  isCustomerEvent,
  mayReceive,
  realtimeMessage,
} from './realtime.js';
import { SESSION_EVENT_TYPES } from './events.js';

/**
 * R3's list, transcribed from `docs/00-decisions.md` and compared against the
 * enum rather than derived from it. A test that read the names out of the code
 * would agree with whatever the code said.
 */
const R3_CUSTOMER = [
  'queue.position',
  'session.offered',
  'session.assigned',
  'agent.joined',
  'session.updated',
  'session.completed',
];

const R3_AGENT = [
  'queue.new_session',
  'session.claimed_elsewhere',
  'session.offer_expired',
  'ai.updated',
  'session.updated',
  'session.cancelled',
];

describe('the canonical vocabulary is R3', () => {
  it('has exactly R3’s customer events', () => {
    expect([...CUSTOMER_EVENTS].sort()).toEqual([...R3_CUSTOMER].sort());
  });

  it('has exactly R3’s agent events', () => {
    expect([...AGENT_EVENTS].sort()).toEqual([...R3_AGENT].sort());
  });

  /**
   * `03-system-design.md` §10.2 lists `agent.assigned`, `call.started` and
   * `call.ended`, and the older half of contract §19 omits several names. R3
   * supersedes both, and inventing a name outside it is what this asserts
   * against.
   */
  it('carries none of the stale names the older docs use', () => {
    for (const stale of ['agent.assigned', 'call.started', 'call.ended', 'session.created']) {
      expect(REALTIME_EVENTS).not.toContain(stale);
    }
  });

  it('names twelve events across the two audiences', () => {
    expect(REALTIME_EVENTS).toHaveLength(12);
  });
});

describe('the two audiences', () => {
  it('share exactly one name, and it means the same thing', () => {
    const shared = CUSTOMER_EVENTS.filter((e) => (AGENT_EVENTS as readonly string[]).includes(e));
    expect(shared).toEqual(['session.updated']);
  });

  it('lets a customer receive only customer events', () => {
    for (const event of CUSTOMER_EVENTS) {
      expect(mayReceive(RealtimeAudience.CUSTOMER, event)).toBe(true);
    }
    for (const event of AGENT_EVENTS.filter((e) => e !== 'session.updated')) {
      expect(mayReceive(RealtimeAudience.CUSTOMER, event)).toBe(false);
    }
  });

  it('lets an agent receive only agent events', () => {
    for (const event of AGENT_EVENTS) {
      expect(mayReceive(RealtimeAudience.AGENT, event)).toBe(true);
    }
    for (const event of CUSTOMER_EVENTS.filter((e) => e !== 'session.updated')) {
      expect(mayReceive(RealtimeAudience.AGENT, event)).toBe(false);
    }
  });

  it('refuses a name from neither list', () => {
    for (const event of ['', 'nonsense', 'CALL_STARTED', 'agent.assigned']) {
      expect(mayReceive(RealtimeAudience.CUSTOMER, event)).toBe(false);
      expect(mayReceive(RealtimeAudience.AGENT, event)).toBe(false);
    }
  });
});

describe('separate from the audit vocabulary', () => {
  /**
   * `SessionEventType` is what is written to `session_events` inside the
   * transaction that made it happen, and is kept forever. These are
   * best-effort notifications. Overlapping names would let one change for the
   * other's reasons.
   */
  it('shares no name with SessionEventType', () => {
    for (const name of REALTIME_EVENTS) {
      expect(SESSION_EVENT_TYPES as readonly string[]).not.toContain(name);
    }
  });

  it('uses a different spelling convention, so the two cannot be confused', () => {
    // Dotted and lower-case here; SCREAMING_SNAKE there.
    for (const name of REALTIME_EVENTS) expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    for (const name of SESSION_EVENT_TYPES) expect(name).toMatch(/^[A-Z_]+$/);
  });
});

describe('guards', () => {
  it('recognise their own audience’s names', () => {
    expect(isCustomerEvent(CustomerEvent.AGENT_JOINED)).toBe(true);
    expect(isAgentEvent(AgentEvent.QUEUE_NEW_SESSION)).toBe(true);
  });

  it('reject non-strings', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(isCustomerEvent(value)).toBe(false);
      expect(isAgentEvent(value)).toBe(false);
    }
  });
});

describe('the envelope', () => {
  it('is `{ event, data }`, as contract §19 shows it', () => {
    expect(realtimeMessage(CustomerEvent.QUEUE_POSITION, { session_id: 's', position: 2 })).toEqual(
      {
        event: 'queue.position',
        data: { session_id: 's', position: 2 },
      },
    );
  });
});
