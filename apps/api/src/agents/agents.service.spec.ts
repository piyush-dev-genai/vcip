import { ErrorCode } from '@vcip/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_ACTOR_CLAIM } from '../common/auth/agent-jwt.guard.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { hashPassword } from '../common/auth/password.js';
import { verifyJwt } from '../common/auth/tokens.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { AgentsService } from './agents.service.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A = '00000000-0000-4000-8000-000000000001';

/** Never a real credential. */
const PASSWORD = 'FAKE-PASSWORD-FOR-TESTS-0123456789';
const WRONG_PASSWORD = 'FAKE-WRONG-PASSWORD-9876543210';

const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-tests-0123456789',
  agentJwtSecret: 'FAKE-agent-secret-for-tests-9876543210ab',
  internalToken: 'FAKE-internal-token-for-tests-abcdefghij',
  wsTokenSecret: 'FAKE-ws-secret-for-tests-abcdefghijklmnop',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
  wsTokenTtlSeconds: 300,
};

/**
 * Two tenants sharing an email, which is the case the schema permits and the
 * login flow has to get right: `users_tenant_email_unique` is on
 * `(tenant_id, email)`, so `shared@demo.local` is a different person at
 * `demo-bank` and at `other-bank`.
 */
let rows: AgentCredentialRow[] = [];

class FakeAgentRepository implements AgentRepository {
  findAgentByEmail(tenantSlug: string, email: string): Promise<AgentCredentialRow | null> {
    const slugToTenant: Record<string, string> = {
      'demo-bank': TENANT_A,
      'other-bank': TENANT_B,
    };
    const tenantId = slugToTenant[tenantSlug];
    if (tenantId === undefined) return Promise.resolve(null);
    return Promise.resolve(
      rows.find((row) => row.tenantId === tenantId && row.email === email) ?? null,
    );
  }

  findProfile(): Promise<AgentProfileRow | null> {
    return Promise.resolve(null);
  }
}

const service = new AgentsService(new FakeAgentRepository(), TEST_AUTH_CONFIG);

const login = (over: Partial<Record<'tenant_slug' | 'email' | 'password', string>> = {}) =>
  service.login({
    tenant_slug: 'demo-bank',
    email: 'agent.one@demo.local',
    password: PASSWORD,
    ...over,
  });

/** Every rejection must be this, exactly. */
const expectSameRejection = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    status: 401,
    response: { code: ErrorCode.UNAUTHENTICATED, message: 'Invalid credentials.' },
  });
};

beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);
  rows = [
    {
      userId: AGENT_A,
      tenantId: TENANT_A,
      email: 'agent.one@demo.local',
      role: 'AGENT',
      status: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      passwordHash: hash,
    },
    {
      userId: 'disabled-user',
      tenantId: TENANT_A,
      email: 'agent.gone@demo.local',
      role: 'AGENT',
      status: 'DISABLED',
      tenantStatus: 'ACTIVE',
      passwordHash: hash,
    },
    {
      userId: 'admin-user',
      tenantId: TENANT_A,
      email: 'admin@demo.local',
      role: 'TENANT_ADMIN',
      status: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      passwordHash: hash,
    },
    {
      userId: 'no-password-user',
      tenantId: TENANT_A,
      email: 'nopassword@demo.local',
      role: 'AGENT',
      status: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      // `users.password_hash` is nullable, and T08 left it null before T16.
      passwordHash: null,
    },
    {
      userId: 'suspended-tenant-user',
      tenantId: TENANT_B,
      email: 'agent.one@other.local',
      role: 'AGENT',
      status: 'ACTIVE',
      tenantStatus: 'SUSPENDED',
      passwordHash: hash,
    },
    // The same address in both tenants, with different passwords.
    {
      userId: 'shared-a',
      tenantId: TENANT_A,
      email: 'shared@demo.local',
      role: 'AGENT',
      status: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      passwordHash: hash,
    },
    {
      userId: 'shared-b',
      tenantId: TENANT_B,
      email: 'shared@demo.local',
      role: 'AGENT',
      status: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      passwordHash: await hashPassword(WRONG_PASSWORD),
    },
  ];
});

describe('AgentsService.login', () => {
  it('issues a token for valid credentials', async () => {
    const result = await login();
    expect(result.token_type).toBe('Bearer');
    expect(result.access_token.split('.')).toHaveLength(3);
  });

  it('mints the claims AgentJwtGuard reads', async () => {
    const { access_token } = await login();
    const claims = verifyJwt(access_token, TEST_AUTH_CONFIG.agentJwtSecret, AGENT_ACTOR_CLAIM);

    expect(claims['uid']).toBe(AGENT_A);
    expect(claims['tid']).toBe(TENANT_A);
    expect(claims['role']).toBe('AGENT');
    expect(claims['act']).toBe(AGENT_ACTOR_CLAIM);
    expect(typeof claims['exp']).toBe('number');
  });

  it('puts nothing sensitive in the token', async () => {
    const { access_token } = await login();
    const payload = Buffer.from(access_token.split('.')[1] ?? '', 'base64url').toString('utf8');

    expect(payload).not.toContain(PASSWORD);
    expect(payload).not.toContain('scrypt');
    expect(payload).not.toContain('agent.one@demo.local');
    // Exactly the five claims and nothing else.
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual([
      'act',
      'exp',
      'iat',
      'role',
      'tid',
      'uid',
    ]);
  });

  it('reports expires_at as an ISO timestamp matching the token expiry', async () => {
    const result = await login();
    const claims = verifyJwt(
      result.access_token,
      TEST_AUTH_CONFIG.agentJwtSecret,
      AGENT_ACTOR_CLAIM,
    );
    expect(result.expires_at).toBe(new Date(claims.exp * 1000).toISOString());
  });

  it('returns no password hash and no user record', async () => {
    const result = await login();
    expect(Object.keys(result).sort()).toEqual(['access_token', 'expires_at', 'token_type']);
    expect(JSON.stringify(result)).not.toContain('scrypt');
  });

  // -------------------------------------------------------- rejections

  it('rejects the wrong password', async () => {
    await expectSameRejection(login({ password: WRONG_PASSWORD }));
  });

  it('rejects an unknown email with the identical response', async () => {
    await expectSameRejection(login({ email: 'nobody@demo.local' }));
  });

  it('rejects an unknown tenant with the identical response', async () => {
    await expectSameRejection(login({ tenant_slug: 'no-such-bank' }));
  });

  it('rejects a disabled user', async () => {
    await expectSameRejection(login({ email: 'agent.gone@demo.local' }));
  });

  it('rejects a user of a non-active tenant', async () => {
    await expectSameRejection(login({ tenant_slug: 'other-bank', email: 'agent.one@other.local' }));
  });

  it('rejects a TENANT_ADMIN: T16 builds no admin surface (R9)', async () => {
    await expectSameRejection(login({ email: 'admin@demo.local' }));
  });

  it('rejects a user whose password hash is null', async () => {
    await expectSameRejection(login({ email: 'nopassword@demo.local' }));
  });

  it('never lets one tenant authenticate as another tenant’s user', async () => {
    // `shared@demo.local` exists in both tenants with different passwords.
    // Tenant A's password must not open tenant B's account, and the token
    // issued must carry the tenant from the *row*, not from the request.
    const a = await login({ email: 'shared@demo.local' });
    const claimsA = verifyJwt(a.access_token, TEST_AUTH_CONFIG.agentJwtSecret, AGENT_ACTOR_CLAIM);
    expect(claimsA['tid']).toBe(TENANT_A);
    expect(claimsA['uid']).toBe('shared-a');

    await expectSameRejection(login({ tenant_slug: 'other-bank', email: 'shared@demo.local' }));

    const b = await login({
      tenant_slug: 'other-bank',
      email: 'shared@demo.local',
      password: WRONG_PASSWORD,
    });
    const claimsB = verifyJwt(b.access_token, TEST_AUTH_CONFIG.agentJwtSecret, AGENT_ACTOR_CLAIM);
    expect(claimsB['tid']).toBe(TENANT_B);
    expect(claimsB['uid']).toBe('shared-b');
  });

  it('leaks nothing about which check failed', async () => {
    // Collected rather than asserted one at a time: the property is that the
    // set of distinct failure responses has exactly one member.
    const failures = await Promise.all(
      [
        login({ password: WRONG_PASSWORD }),
        login({ email: 'nobody@demo.local' }),
        login({ tenant_slug: 'no-such-bank' }),
        login({ email: 'agent.gone@demo.local' }),
        login({ email: 'admin@demo.local' }),
        login({ email: 'nopassword@demo.local' }),
        login({ tenant_slug: 'other-bank', email: 'agent.one@other.local' }),
      ].map((promise) =>
        promise.then(
          () => 'unexpected success',
          (error: unknown) => JSON.stringify((error as { response: unknown }).response),
        ),
      ),
    );

    expect(new Set(failures).size).toBe(1);
    expect(failures[0]).not.toContain('password');
    expect(failures[0]).not.toContain('tenant');
    expect(failures[0]).not.toContain('exist');
  });

  it('does the KDF even when no user was found', async () => {
    // The timing half of the same property. Asserted as a duration ratio
    // rather than an absolute, and generously: the point is that the unknown
    // path is not orders of magnitude faster, which is what a skipped scrypt
    // would look like.
    const time = async (promise: Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await promise.catch(() => undefined);
      return performance.now() - started;
    };

    const wrongPassword = await time(login({ password: WRONG_PASSWORD }));
    const unknownUser = await time(login({ email: 'nobody@demo.local' }));

    expect(unknownUser).toBeGreaterThan(wrongPassword / 10);
  });
});
