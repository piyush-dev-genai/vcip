import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AgentJwtGuard } from './agent-jwt.guard.js';
import { ApiKeyGuard } from './api-key.guard.js';
import type { ApiKeyRecord, ApiKeyStore } from './api-key.store.js';
import { hashApiKey, parseApiKeyPrefix } from './api-key.store.js';
import type { AuthConfig } from './auth.config.js';
import { redactable } from './auth.config.js';
import type { Actor, AuthenticatedRequest } from './auth-context.js';
import { CustomerTokenGuard } from './customer-token.guard.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantScope } from './tenant-scope.js';
import { nowSeconds, signJwt } from './tokens.js';

// ------------------------------------------------------------------ fixtures

const CUSTOMER_SECRET = 'customer-secret-'.repeat(3);
const AGENT_SECRET = 'agent-secret-'.repeat(4);
const INTERNAL_TOKEN = 'internal-token-'.repeat(3);

const CONFIG: AuthConfig = redactable({
  customerTokenSecret: CUSTOMER_SECRET,
  agentJwtSecret: AGENT_SECRET,
  internalToken: INTERNAL_TOKEN,
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 43200,
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SESSION_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface RequestShape {
  headers?: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  actor?: Actor;
}

/** A minimal ExecutionContext carrying one request. */
const contextFor = (
  request: RequestShape,
): { context: ExecutionContext; request: RequestShape } => {
  const req = { headers: {}, ...request } as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: <T>() => req as T }),
  } as unknown as ExecutionContext;
  return { context, request: req as RequestShape };
};

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// -------------------------------------------------------------- ApiKey guard

const DEMO_KEY = 'vcip_demo_ZGVtb0tleVNlY3JldFZhbHVlMTIzNA';

const keyRecord = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id: 'key-1',
  tenantId: TENANT_A,
  keyHash: hashApiKey(DEMO_KEY),
  scopes: ['sessions:write', 'sessions:read'],
  expiresAt: null,
  revokedAt: null,
  ...overrides,
});

const storeOf = (record: ApiKeyRecord | null): ApiKeyStore => ({
  findByPrefix: (prefix) =>
    Promise.resolve(record !== null && prefix === 'vcip_demo' ? record : null),
});

describe('parseApiKeyPrefix', () => {
  it('takes the first two segments as the prefix', () => {
    expect(parseApiKeyPrefix('vcip_demo_abc123')).toBe('vcip_demo');
    expect(parseApiKeyPrefix('vcip_acme_xyz_more')).toBe('vcip_acme');
  });

  it.each([
    ['no separator', 'vcipdemo'],
    ['one separator', 'vcip_demo'],
    ['empty secret', 'vcip_demo_'],
    ['leading separator', '_demo_abc'],
  ])('returns null for %s', (_label, key) => {
    expect(parseApiKeyPrefix(key)).toBeNull();
  });
});

describe('ApiKeyGuard', () => {
  const guard = (record: ApiKeyRecord | null): ApiKeyGuard => new ApiKeyGuard(storeOf(record));

  it('accepts a valid key and establishes the tenant context', async () => {
    const { context, request } = contextFor({ headers: bearer(DEMO_KEY) });
    await expect(guard(keyRecord()).canActivate(context)).resolves.toBe(true);
    expect(request.actor).toEqual({
      kind: 'enterprise',
      tenantId: TENANT_A,
      apiKeyId: 'key-1',
      scopes: ['sessions:write', 'sessions:read'],
    });
  });

  it('propagates scopes for downstream authorization', async () => {
    const { context, request } = contextFor({ headers: bearer(DEMO_KEY) });
    await guard(keyRecord({ scopes: ['sessions:write'] })).canActivate(context);
    expect(request.actor?.kind).toBe('enterprise');
    if (request.actor?.kind === 'enterprise') {
      expect(request.actor.scopes).toEqual(['sessions:write']);
    }
  });

  it('freezes the scope list so a handler cannot grant itself one', async () => {
    const { context, request } = contextFor({ headers: bearer(DEMO_KEY) });
    await guard(keyRecord()).canActivate(context);
    if (request.actor?.kind === 'enterprise') {
      expect(Object.isFrozen(request.actor.scopes)).toBe(true);
    }
  });

  it('rejects a missing Authorization header', async () => {
    const { context } = contextFor({ headers: {} });
    await expect(guard(keyRecord()).canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it.each([
    ['no scheme', DEMO_KEY],
    ['wrong scheme', `Basic ${DEMO_KEY}`],
    ['lowercase scheme', `bearer ${DEMO_KEY}`],
    ['empty credential', 'Bearer '],
  ])('rejects a malformed bearer header: %s', async (_label, header) => {
    const { context } = contextFor({ headers: { authorization: header } });
    await expect(guard(keyRecord()).canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a revoked key', async () => {
    const { context, request } = contextFor({ headers: bearer(DEMO_KEY) });
    await expect(
      guard(keyRecord({ revokedAt: new Date('2020-01-01') })).canActivate(context),
    ).rejects.toThrow(UnauthorizedException);
    expect(request.actor).toBeUndefined();
  });

  it('rejects an expired key', async () => {
    const { context } = contextFor({ headers: bearer(DEMO_KEY) });
    await expect(
      guard(keyRecord({ expiresAt: new Date(Date.now() - 1000) })).canActivate(context),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a key expiring in the future', async () => {
    const { context } = contextFor({ headers: bearer(DEMO_KEY) });
    await expect(
      guard(keyRecord({ expiresAt: new Date(Date.now() + 60_000) })).canActivate(context),
    ).resolves.toBe(true);
  });

  it('rejects an unknown key prefix', async () => {
    const { context } = contextFor({ headers: bearer('vcip_other_abc123') });
    await expect(guard(keyRecord()).canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a key whose secret does not match the stored hash', async () => {
    const { context } = contextFor({ headers: bearer('vcip_demo_WRONGSECRETVALUE') });
    await expect(guard(keyRecord()).canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('gives the same message for unknown, revoked, expired, and wrong-secret', async () => {
    const messages = new Set<string>();
    const cases: Array<[ApiKeyRecord | null, string]> = [
      [null, DEMO_KEY],
      [keyRecord({ revokedAt: new Date('2020-01-01') }), DEMO_KEY],
      [keyRecord({ expiresAt: new Date('2020-01-01') }), DEMO_KEY],
      [keyRecord(), 'vcip_demo_WRONG'],
      [keyRecord({ tenantId: TENANT_B }), 'vcip_demo_WRONG'],
    ];

    for (const [record, key] of cases) {
      const { context } = contextFor({ headers: bearer(key) });
      try {
        await guard(record).canActivate(context);
      } catch (error) {
        const response = (error as UnauthorizedException).getResponse() as { message: string };
        messages.add(response.message);
      }
    }
    // One message for every failure: a caller cannot tell an unknown key from
    // another tenant's revoked one.
    expect(messages.size).toBe(1);
  });

  it('never puts the plaintext key on the request or in the error', async () => {
    const { context, request } = contextFor({ headers: bearer('vcip_demo_WRONGSECRET') });
    try {
      await guard(keyRecord()).canActivate(context);
    } catch (error) {
      const text = JSON.stringify((error as UnauthorizedException).getResponse());
      expect(text).not.toContain('WRONGSECRET');
    }
    expect(JSON.stringify(request.actor ?? {})).not.toContain('WRONGSECRET');

    const ok = contextFor({ headers: bearer(DEMO_KEY) });
    await guard(keyRecord()).canActivate(ok.context);
    // The authenticated actor carries the key's id, never the key.
    expect(JSON.stringify(ok.request.actor)).not.toContain(DEMO_KEY);
    expect(JSON.stringify(ok.request.actor)).not.toContain(hashApiKey(DEMO_KEY));
  });
});

// ------------------------------------------------------- CustomerToken guard

const customerToken = (
  claims: Record<string, unknown> = {},
  overrides: { secret?: string; ttlSeconds?: number; issuedAt?: number } = {},
): string =>
  signJwt(
    { act: 'customer', tid: TENANT_A, sid: SESSION_1, ...claims },
    {
      secret: overrides.secret ?? CUSTOMER_SECRET,
      ttlSeconds: overrides.ttlSeconds ?? 7200,
      ...(overrides.issuedAt === undefined ? {} : { issuedAt: overrides.issuedAt }),
    },
  );

describe('CustomerTokenGuard', () => {
  const guard = new CustomerTokenGuard(CONFIG);

  it('accepts a valid token and establishes tenant and session context', () => {
    const { context, request } = contextFor({ headers: bearer(customerToken()) });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.actor).toEqual({ kind: 'customer', tenantId: TENANT_A, sessionId: SESSION_1 });
  });

  it('rejects an expired token', () => {
    const token = customerToken({}, { ttlSeconds: 60, issuedAt: nowSeconds() - 3600 });
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = customerToken({}, { secret: 'x'.repeat(48) });
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the AGENT secret', () => {
    // Separate secrets mean a stolen agent secret cannot mint customer tokens.
    const token = customerToken({}, { secret: AGENT_SECRET });
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an agent token presented to a customer route', () => {
    const token = signJwt(
      { act: 'agent', tid: TENANT_A, uid: 'u1', role: 'AGENT' },
      { secret: CUSTOMER_SECRET, ttlSeconds: 60 },
    );
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each([
    ['tenant', { tid: undefined }],
    ['session', { sid: undefined }],
  ])('rejects a token missing the %s claim', (_label, claims) => {
    const token = signJwt(
      { act: 'customer', tid: TENANT_A, sid: SESSION_1, ...claims },
      { secret: CUSTOMER_SECRET, ttlSeconds: 60 },
    );
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an empty tenant or session claim', () => {
    for (const claims of [{ tid: '' }, { sid: '' }]) {
      const { context } = contextFor({ headers: bearer(customerToken(claims)) });
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    }
  });

  it('accepts a token used against its own session', () => {
    const { context } = contextFor({
      headers: bearer(customerToken()),
      params: { id: SESSION_1 },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a token used against a different session', () => {
    const { context, request } = contextFor({
      headers: bearer(customerToken()),
      params: { id: SESSION_2 },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(request.actor).toBeUndefined();
  });

  it.each(['sessionId', 'session_id', 'id'])('checks the %s route parameter', (param) => {
    const { context } = contextFor({
      headers: bearer(customerToken()),
      params: { [param]: SESSION_2 },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a missing header', () => {
    const { context } = contextFor({ headers: {} });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});

// ---------------------------------------------------------- AgentJwt guard

const agentToken = (
  claims: Record<string, unknown> = {},
  overrides: { secret?: string; ttlSeconds?: number; issuedAt?: number } = {},
): string =>
  signJwt(
    { act: 'agent', uid: 'user-1', tid: TENANT_A, role: 'AGENT', ...claims },
    {
      secret: overrides.secret ?? AGENT_SECRET,
      ttlSeconds: overrides.ttlSeconds ?? 3600,
      ...(overrides.issuedAt === undefined ? {} : { issuedAt: overrides.issuedAt }),
    },
  );

describe('AgentJwtGuard', () => {
  const guard = new AgentJwtGuard(CONFIG);

  it('accepts a valid AGENT token', () => {
    const { context, request } = contextFor({ headers: bearer(agentToken()) });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.actor).toEqual({
      kind: 'agent',
      tenantId: TENANT_A,
      userId: 'user-1',
      role: 'AGENT',
    });
  });

  it('accepts a valid TENANT_ADMIN token', () => {
    const { context, request } = contextFor({
      headers: bearer(agentToken({ role: 'TENANT_ADMIN' })),
    });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.actor?.kind === 'agent' && request.actor.role).toBe('TENANT_ADMIN');
  });

  it('rejects an expired token', () => {
    const token = agentToken({}, { ttlSeconds: 60, issuedAt: nowSeconds() - 7200 });
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an invalid signature', () => {
    const token = agentToken({}, { secret: 'z'.repeat(48) });
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the CUSTOMER secret', () => {
    const token = agentToken({}, { secret: CUSTOMER_SECRET });
    const { context } = contextFor({ headers: bearer(token) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each([
    ['user_id', { uid: undefined }],
    ['tenant_id', { tid: undefined }],
    ['role', { role: undefined }],
  ])('rejects a token missing %s', (_label, claims) => {
    const { context } = contextFor({ headers: bearer(agentToken(claims)) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('never silently accepts a token without tenant identity', () => {
    for (const tid of [undefined, '', null, 42, {}]) {
      const { context, request } = contextFor({ headers: bearer(agentToken({ tid })) });
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
      expect(request.actor).toBeUndefined();
    }
  });

  it.each(['ADMIN', 'agent', 'SUPERUSER', '', 'CUSTOMER'])(
    'rejects the invalid role %s',
    (role) => {
      const { context } = contextFor({ headers: bearer(agentToken({ role })) });
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    },
  );

  it('rejects a missing header', () => {
    const { context } = contextFor({ headers: {} });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});

// ------------------------------------------------------- InternalToken guard

describe('InternalTokenGuard', () => {
  const guard = new InternalTokenGuard(CONFIG);

  it('accepts the configured token and establishes an internal actor', () => {
    const { context, request } = contextFor({ headers: { 'x-internal-token': INTERNAL_TOKEN } });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.actor).toEqual({ kind: 'internal', service: 'internal' });
  });

  it('rejects an invalid token', () => {
    const { context } = contextFor({ headers: { 'x-internal-token': 'nope' } });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a token of the right length but wrong content', () => {
    const { context } = contextFor({
      headers: { 'x-internal-token': 'x'.repeat(INTERNAL_TOKEN.length) },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a prefix of the correct token', () => {
    const { context } = contextFor({
      headers: { 'x-internal-token': INTERNAL_TOKEN.slice(0, -1) },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a missing token', () => {
    const { context } = contextFor({ headers: {} });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an empty token', () => {
    const { context } = contextFor({ headers: { 'x-internal-token': '' } });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a repeated header rather than picking one', () => {
    const { context } = contextFor({
      headers: { 'x-internal-token': [INTERNAL_TOKEN, 'other'] },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('does not accept a bearer Authorization header instead', () => {
    const { context } = contextFor({ headers: bearer(INTERNAL_TOKEN) });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('never exposes the secret in the rejection', () => {
    const { context } = contextFor({ headers: { 'x-internal-token': 'wrong' } });
    try {
      guard.canActivate(context);
    } catch (error) {
      const exception = error as UnauthorizedException;
      const text = JSON.stringify(exception.getResponse()) + (exception.stack ?? '');
      expect(text).not.toContain(INTERNAL_TOKEN);
    }
  });

  it('gives an internal actor no tenant', () => {
    const { context, request } = contextFor({ headers: { 'x-internal-token': INTERNAL_TOKEN } });
    guard.canActivate(context);
    expect(request.actor).not.toHaveProperty('tenantId');
  });
});

// ------------------------------------------------------------- Tenant guard

describe('TenantScope', () => {
  const scope = new TenantScope();

  const enterprise: Actor = {
    kind: 'enterprise',
    tenantId: TENANT_A,
    apiKeyId: 'k1',
    scopes: [],
  };
  const agent: Actor = { kind: 'agent', tenantId: TENANT_A, userId: 'u1', role: 'AGENT' };
  const customer: Actor = { kind: 'customer', tenantId: TENANT_A, sessionId: SESSION_1 };
  const internal: Actor = { kind: 'internal', service: 'internal' };

  it.each([
    ['enterprise', enterprise],
    ['agent', agent],
    ['customer', customer],
  ])('resolves the tenant of an authenticated %s actor', (_label, actor) => {
    expect(scope.requireTenant(actor)).toBe(TENANT_A);
  });

  it('refuses an internal actor on a tenant-scoped route', () => {
    expect(() => scope.requireTenant(internal)).toThrow(ForbiddenException);
  });

  it('refuses an unauthenticated request', () => {
    expect(() => scope.requireTenant(undefined)).toThrow(ForbiddenException);
  });

  it('allows same-tenant resource access', () => {
    const resource = { tenantId: TENANT_A, id: 's1' };
    expect(scope.assertOwnership(agent, resource)).toBe(resource);
  });

  it('refuses cross-tenant resource access', () => {
    expect(() => scope.assertOwnership(agent, { tenantId: TENANT_B })).toThrow(NotFoundException);
  });

  it('reports a cross-tenant row exactly as it reports a missing one', () => {
    const responses: string[] = [];
    for (const resource of [null, { tenantId: TENANT_B }]) {
      try {
        scope.assertOwnership(agent, resource);
      } catch (error) {
        responses.push(JSON.stringify((error as NotFoundException).getResponse()));
      }
    }
    // Identical, so an id cannot be probed for existence in another tenant.
    expect(responses[0]).toBe(responses[1]);
    expect(new Set(responses).size).toBe(1);
  });

  it('binds a customer to its own session even within the right tenant', () => {
    expect(() => scope.assertSessionAccess(customer, SESSION_1)).not.toThrow();
    expect(() => scope.assertSessionAccess(customer, SESSION_2)).toThrow(NotFoundException);
  });

  it('does not session-bind an agent, who may open any session in the tenant', () => {
    expect(() => scope.assertSessionAccess(agent, SESSION_2)).not.toThrow();
  });

  it('answers ownership questions without throwing', () => {
    expect(scope.owns(agent, TENANT_A)).toBe(true);
    expect(scope.owns(agent, TENANT_B)).toBe(false);
    expect(scope.owns(internal, TENANT_A)).toBe(false);
    expect(scope.owns(undefined, TENANT_A)).toBe(false);
  });
});

describe('TenantGuard', () => {
  const guard = new TenantGuard(new TenantScope());
  const agent: Actor = { kind: 'agent', tenantId: TENANT_A, userId: 'u1', role: 'AGENT' };

  it('allows an authenticated tenant actor', () => {
    const { context } = contextFor({ actor: agent });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a request with no authenticated actor', () => {
    const { context } = contextFor({});
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects an internal actor, which has no tenant', () => {
    const { context } = contextFor({ actor: { kind: 'internal', service: 'internal' } });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each([
    ['body', (id: string) => ({ body: { tenant_id: id } })],
    ['body camelCase', (id: string) => ({ body: { tenantId: id } })],
    ['query', (id: string) => ({ query: { tenant_id: id } })],
    ['params', (id: string) => ({ params: { tenant_id: id } })],
  ])('rejects a conflicting tenant_id supplied in the %s', (_label, build) => {
    const { context } = contextFor({ actor: agent, ...build(TENANT_B) });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('a request-supplied tenant_id cannot override the authenticated tenant', () => {
    // The authenticated tenant is A. The body claims B. The request does not
    // become a B request; it is refused.
    const { context, request } = contextFor({ actor: agent, body: { tenant_id: TENANT_B } });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(request.actor?.kind === 'agent' && request.actor.tenantId).toBe(TENANT_A);
  });

  it('tolerates a matching tenant_id, which is redundant but not hostile', () => {
    const { context } = contextFor({ actor: agent, body: { tenant_id: TENANT_A } });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('ignores unrelated body fields', () => {
    const { context } = contextFor({
      actor: agent,
      body: { external_ref: 'ref-1', language: 'en' },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('handles a non-object body without crashing', () => {
    for (const body of [null, undefined, 'text', 42, []]) {
      const { context } = contextFor({ actor: agent, body });
      expect(guard.canActivate(context)).toBe(true);
    }
  });
});
