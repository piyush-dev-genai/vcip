import { RealtimeAudience } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { WS_TOKEN_TTL_SECONDS } from '../common/auth/auth.config.js';
import { ActorRole } from '../common/auth/auth-context.js';
import type { AgentActor, CustomerActor } from '../common/auth/auth-context.js';
import { verifyJwt } from '../common/auth/tokens.js';
import { WS_ACTOR_CLAIM, WsTokenService } from './ws-token.service.js';

const WS_SECRET = 'FAKE-ws-secret-for-tests-abcdefghijklmnop';
const CUSTOMER_SECRET = 'FAKE-customer-secret-for-tests-0123456789';
const AGENT_SECRET = 'FAKE-agent-secret-for-tests-9876543210ab';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const OTHER_TENANT = '00000000-0000-4000-8000-00000000000b';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';

const CONFIG: AuthConfig = {
  customerTokenSecret: CUSTOMER_SECRET,
  agentJwtSecret: AGENT_SECRET,
  internalToken: 'FAKE-internal-token-for-tests-abcdefghij',
  wsTokenSecret: WS_SECRET,
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
  wsTokenTtlSeconds: 300,
};

const NOW = new Date('2026-09-02T10:00:00.000Z');

const service = new WsTokenService(CONFIG);

const customer = (over: Partial<CustomerActor> = {}): CustomerActor => ({
  kind: 'customer',
  tenantId: TENANT,
  sessionId: SESSION,
  ...over,
});

const agent = (over: Partial<AgentActor> = {}): AgentActor => ({
  kind: 'agent',
  tenantId: TENANT,
  userId: AGENT,
  role: ActorRole.AGENT,
  ...over,
});

const claims = (token: string) => verifyJwt(token, WS_SECRET, WS_ACTOR_CLAIM);

describe('a customer connection token', () => {
  it('is scoped to the tenant and exactly one session (D9)', () => {
    const decoded = claims(service.forCustomer(customer()).token);
    expect(decoded['aud']).toBe(RealtimeAudience.CUSTOMER);
    expect(decoded['tid']).toBe(TENANT);
    expect(decoded['sid']).toBe(SESSION);
  });

  /**
   * Signed from the actor, not from the route parameter. The guard already
   * refuses a mismatch (R8), and taking the id from the credential means one
   * could not be smuggled through even if that guard were removed.
   */
  it('names the session from the credential', () => {
    const decoded = claims(service.forCustomer(customer({ sessionId: SESSION })).token);
    expect(decoded['sid']).toBe(SESSION);
  });

  it('carries no user id: a customer is not a user', () => {
    expect(claims(service.forCustomer(customer()).token)['uid']).toBeUndefined();
  });

  it('reports the audience so a client need not decode it', () => {
    expect(service.forCustomer(customer()).audience).toBe(RealtimeAudience.CUSTOMER);
  });
});

describe('an agent connection token', () => {
  it('is scoped to the tenant and the user (D9)', () => {
    const decoded = claims(service.forAgent(agent()).token);
    expect(decoded['aud']).toBe(RealtimeAudience.AGENT);
    expect(decoded['tid']).toBe(TENANT);
    expect(decoded['uid']).toBe(AGENT);
  });

  /**
   * The asymmetry D9 describes: an agent's connection outlives any one session,
   * so scoping it to a session would mean re-minting on every claim.
   */
  it('carries no session id', () => {
    expect(claims(service.forAgent(agent()).token)['sid']).toBeUndefined();
  });

  /**
   * Languages decide which queue channels the connection joins. They are read
   * from `agent_profiles` at connect time, so a profile change takes effect on
   * the next connection rather than waiting for a token to expire.
   */
  it('carries no languages', () => {
    const decoded = claims(service.forAgent(agent()).token) as Record<string, unknown>;
    expect(decoded['languages']).toBeUndefined();
    expect(decoded['lang']).toBeUndefined();
  });

  it('takes the tenant from the credential, never from anywhere else', () => {
    const decoded = claims(service.forAgent(agent({ tenantId: OTHER_TENANT })).token);
    expect(decoded['tid']).toBe(OTHER_TENANT);
  });
});

describe('purpose binding', () => {
  /**
   * The risk D9 introduces is a credential in a URL. Two locks: a distinct
   * `act` claim, and a distinct signing secret.
   */
  it('marks the token with its own actor claim', () => {
    expect(WS_ACTOR_CLAIM).toBe('ws');
    expect(() => verifyJwt(service.forAgent(agent()).token, WS_SECRET, 'agent')).toThrow();
    expect(() => verifyJwt(service.forCustomer(customer()).token, WS_SECRET, 'customer')).toThrow();
  });

  it('does not verify under the customer or agent secret', () => {
    const token = service.forCustomer(customer()).token;
    expect(() => verifyJwt(token, CUSTOMER_SECRET, WS_ACTOR_CLAIM)).toThrow();
    expect(() => verifyJwt(token, AGENT_SECRET, WS_ACTOR_CLAIM)).toThrow();
  });
});

describe('lifetime', () => {
  it('is five minutes', () => {
    expect(WS_TOKEN_TTL_SECONDS).toBe(300);
  });

  it('reports an expiry the client can refetch against', () => {
    expect(service.forCustomer(customer(), NOW).expires_at).toBe('2026-09-02T10:05:00.000Z');
  });

  it('bakes the same lifetime into the token itself', () => {
    const decoded = claims(service.forAgent(agent()).token) as unknown as {
      iat: number;
      exp: number;
    };
    expect(decoded.exp - decoded.iat).toBe(300);
  });

  /**
   * Not single-use: a dropped socket reconnecting is the common case, and a
   * one-shot token would make every network blip a REST round trip.
   */
  it('mints a token that can be used more than once', () => {
    const token = service.forCustomer(customer()).token;
    expect(() => claims(token)).not.toThrow();
    expect(() => claims(token)).not.toThrow();
  });
});

describe('what a token never carries', () => {
  it('holds only the claims the scope needs', () => {
    const decoded = claims(service.forCustomer(customer()).token) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['act', 'aud', 'exp', 'iat', 'sid', 'tid']);
  });

  it('holds nothing about the customer beyond identifiers', () => {
    const serialised = JSON.stringify(claims(service.forCustomer(customer()).token));
    for (const forbidden of ['email', 'name', 'password', 'language', 'latitude']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
