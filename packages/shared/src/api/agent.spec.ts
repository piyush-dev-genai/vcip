import { describe, expect, it } from 'vitest';
import { AGENT_SETTABLE_PRESENCES, AgentPresence } from '../enums.js';
import {
  AGENT_AVAILABILITY_VALUES,
  agentAvailabilitySchema,
  agentHeartbeatSchema,
  agentLoginSchema,
  agentAcceptSchema,
  agentClaimSchema,
} from './agent.js';

/**
 * The wire contract for T16.
 *
 * The tests that matter here are the negative ones. Each corresponds to a
 * mutation the implementation must not survive: an agent naming itself, an
 * agent naming its tenant on an authenticated route, an agent choosing its own
 * languages, an agent declaring itself BUSY.
 */

const VALID_LOGIN = {
  tenant_slug: 'demo-bank',
  email: 'agent.one@demo.local',
  password: 'FAKE-PASSWORD-FOR-TESTS',
};

describe('agentLoginSchema', () => {
  it('accepts a well-formed login', () => {
    expect(agentLoginSchema.parse(VALID_LOGIN)).toEqual(VALID_LOGIN);
  });

  it('normalises the email to lower case and trims it', () => {
    const parsed = agentLoginSchema.parse({ ...VALID_LOGIN, email: '  Agent.One@Demo.Local  ' });
    expect(parsed.email).toBe('agent.one@demo.local');
  });

  it('rejects a value that is not an email address', () => {
    for (const bad of ['agent.one', 'agent.one@local', '@demo.local', 'a b@demo.local']) {
      expect(agentLoginSchema.safeParse({ ...VALID_LOGIN, email: bad }).success).toBe(false);
    }
  });

  it('rejects a slug that is not a slug', () => {
    // A slug reaches a WHERE clause. It is parameterised there, but a shape
    // this narrow means nothing exotic ever gets that far.
    for (const bad of ['Demo-Bank', 'demo bank', '-demo', 'demo/bank', '']) {
      expect(agentLoginSchema.safeParse({ ...VALID_LOGIN, tenant_slug: bad }).success).toBe(false);
    }
  });

  it('bounds the password at both ends', () => {
    expect(agentLoginSchema.safeParse({ ...VALID_LOGIN, password: 'short' }).success).toBe(false);
    // Unbounded input into a KDF is free CPU for an attacker.
    expect(agentLoginSchema.safeParse({ ...VALID_LOGIN, password: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('rejects an unknown field', () => {
    expect(agentLoginSchema.safeParse({ ...VALID_LOGIN, tenant_id: 'x' }).success).toBe(false);
    expect(agentLoginSchema.safeParse({ ...VALID_LOGIN, role: 'TENANT_ADMIN' }).success).toBe(
      false,
    );
  });
});

describe('agentAvailabilitySchema', () => {
  it('accepts the two settable presences', () => {
    expect(agentAvailabilitySchema.parse({ status: 'AVAILABLE' })).toEqual({ status: 'AVAILABLE' });
    expect(agentAvailabilitySchema.parse({ status: 'UNAVAILABLE' })).toEqual({
      status: 'UNAVAILABLE',
    });
  });

  it('rejects BUSY', () => {
    // R5: BUSY is set on claim and cleared on session end. There is no client
    // path to it, and this is where that becomes structural.
    expect(agentAvailabilitySchema.safeParse({ status: AgentPresence.BUSY }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    for (const bad of ['available', 'ONLINE', '', null, 1]) {
      expect(agentAvailabilitySchema.safeParse({ status: bad }).success).toBe(false);
    }
  });

  it('rejects a client-supplied agent, tenant, or language list', () => {
    for (const extra of [
      { agent_id: '00000000-0000-4000-8000-000000000001' },
      { tenant_id: '00000000-0000-4000-8000-00000000000a' },
      { languages: ['en'] },
      { last_seen: '2026-08-31T00:00:00.000Z' },
      { max_concurrent: 99 },
    ]) {
      expect(agentAvailabilitySchema.safeParse({ status: 'AVAILABLE', ...extra }).success).toBe(
        false,
      );
    }
  });

  it('accepts exactly the presences the domain says are settable', () => {
    // The schema lists literals so zod can infer a narrow union; this keeps
    // that list and AGENT_SETTABLE_PRESENCES from drifting apart.
    expect([...AGENT_AVAILABILITY_VALUES].sort()).toEqual([...AGENT_SETTABLE_PRESENCES].sort());
  });
});

describe('agentHeartbeatSchema', () => {
  it('accepts an empty body', () => {
    expect(agentHeartbeatSchema.parse({})).toEqual({});
  });

  it('rejects every field', () => {
    for (const body of [
      { agent_id: '00000000-0000-4000-8000-000000000001' },
      { status: 'AVAILABLE' },
      { status: 'BUSY' },
      { languages: ['en'] },
      { last_seen: '2026-08-31T00:00:00.000Z' },
      { ttl: 3600 },
    ]) {
      expect(agentHeartbeatSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('agentClaimSchema', () => {
  it('accepts an empty body', () => {
    expect(agentClaimSchema.parse({})).toEqual({});
  });

  it('rejects every field a caller might try to assert', () => {
    for (const body of [
      // The agent and the tenant come from the JWT.
      { agent_id: '00000000-0000-4000-8000-000000000001' },
      { offered_to_agent_id: '00000000-0000-4000-8000-000000000001' },
      { tenant_id: '00000000-0000-4000-8000-00000000000a' },
      // The session comes from the path.
      { session_id: '00000000-0000-4000-8000-00000000e001' },
      // The offer window is tenant configuration, not a request field.
      { offer_expires_at: '2099-01-01T00:00:00.000Z' },
      { offer_timeout_seconds: 86400 },
      // Nor may a claim assert its own outcome.
      { status: 'OFFERED' },
      { language: 'en' },
      { priority: 99 },
      { force: true },
    ]) {
      expect(agentClaimSchema.safeParse(body).success).toBe(false);
    }
  });

  it('is the same shape as the heartbeat: no fields at all', () => {
    // Both are empty strictObjects, and both are that way on purpose. If one
    // ever grows a field, this is the test that says so out loud.
    expect(Object.keys(agentClaimSchema.shape)).toEqual([]);
  });
});

describe('agentAcceptSchema', () => {
  it('accepts an empty body', () => {
    expect(agentAcceptSchema.parse({})).toEqual({});
  });

  it('rejects every field a caller might try to assert', () => {
    for (const body of [
      // Decided at claim time and recorded in PostgreSQL.
      { agent_id: '00000000-0000-4000-8000-000000000001' },
      { tenant_id: '00000000-0000-4000-8000-00000000000a' },
      { session_id: '00000000-0000-4000-8000-00000000e001' },
      // Server-owned: the accept instant and the room are not the client's.
      { connected_at: '2099-01-01T00:00:00.000Z' },
      { room_name: 'vcip_somewhere_else' },
      { status: 'IN_CALL' },
      // Nor may a caller wave away the expiry that refused them.
      { offer_expires_at: '2099-01-01T00:00:00.000Z' },
      { force: true },
    ]) {
      expect(agentAcceptSchema.safeParse(body).success).toBe(false);
    }
  });

  it('is the same shape as the claim: the path and the token say everything', () => {
    expect(Object.keys(agentAcceptSchema.shape)).toEqual([]);
  });
});
