/**
 * The agent surface through a real Nest application, over real HTTP.
 *
 * Everything between the socket and the datastore is the production code: the
 * controller, T09's `AgentJwtGuard` and `TenantGuard`, T10's error filter, the
 * validation pipes, `AgentsService`, and `PresenceService`. Only the two I/O
 * ports are substituted — the agent repository and the presence repository —
 * because a test that cannot run without PostgreSQL and Redis is a test that
 * stops being run. The genuine Redis semantics are proved separately by
 * `scripts/verify-presence.ts` against a real server.
 *
 * The substitute presence store keeps the properties the assertions depend on:
 * a TTL that expires against an injected clock, and a `touch` that refreshes
 * without creating.
 */

import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AgentPresence, ErrorCode } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ACTOR_CLAIM, AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { ApiKeyGuard } from '../common/auth/api-key.guard.js';
import type { ApiKeyRecord, ApiKeyStore } from '../common/auth/api-key.store.js';
import { API_KEY_STORE, hashApiKey } from '../common/auth/api-key.store.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { CUSTOMER_ACTOR_CLAIM } from '../common/auth/customer-token.guard.js';
import { hashPassword } from '../common/auth/password.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { INTERNAL_TOKEN_HEADER } from '../common/auth/auth-context.js';
import { signJwt } from '../common/auth/tokens.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { AGENT_REPOSITORY } from './agent.repository.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { presenceKey, PRESENCE_FIELDS, PRESENCE_TTL_SECONDS } from './presence.keys.js';
import type { PresenceEntry, PresenceRepository, TouchResult } from './presence.repository.js';
import { PRESENCE_REPOSITORY } from './presence.repository.js';
import { PresenceService } from './presence.service.js';

// ------------------------------------------------------------------ fakes

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A1 = '00000000-0000-4000-8000-0000000000a1';
const AGENT_A2 = '00000000-0000-4000-8000-0000000000a2';
const AGENT_B1 = '00000000-0000-4000-8000-0000000000b1';

/** Never a real credential. 32+ characters where `auth.config.ts` demands it. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-tests-0123456789',
  agentJwtSecret: 'FAKE-agent-secret-for-tests-9876543210ab',
  internalToken: 'FAKE-internal-token-for-tests-abcdefghij',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
};

const PASSWORD = 'FAKE-PASSWORD-FOR-TESTS-0123456789';
const API_KEY_A = 'vcip_tenanta_FAKEKEYSECRETAAAAAAAAAAAAAAAAAAAA';

let credentials: AgentCredentialRow[] = [];

const PROFILES: AgentProfileRow[] = [
  { userId: AGENT_A1, tenantId: TENANT_A, languages: ['en', 'hi'], maxConcurrent: 1 },
  { userId: AGENT_A2, tenantId: TENANT_A, languages: ['ta'], maxConcurrent: 2 },
  { userId: AGENT_B1, tenantId: TENANT_B, languages: ['en'], maxConcurrent: 1 },
];

const SLUG_TO_TENANT: Readonly<Record<string, string>> = {
  'demo-bank': TENANT_A,
  'other-bank': TENANT_B,
};

class FakeAgentRepository implements AgentRepository {
  findAgentByEmail(tenantSlug: string, email: string): Promise<AgentCredentialRow | null> {
    const tenantId = SLUG_TO_TENANT[tenantSlug];
    if (tenantId === undefined) return Promise.resolve(null);
    return Promise.resolve(
      credentials.find((row) => row.tenantId === tenantId && row.email === email) ?? null,
    );
  }

  findProfile(userId: string, tenantId: string): Promise<AgentProfileRow | null> {
    return Promise.resolve(
      PROFILES.find((p) => p.userId === userId && p.tenantId === tenantId) ?? null,
    );
  }
}

let clockMs = Date.parse('2026-08-31T09:00:00.000Z');

class FakePresenceRepository implements PresenceRepository {
  readonly keys = new Map<string, { fields: Map<string, string>; expiresAtMs: number }>();

  private live(agentId: string) {
    const key = presenceKey(agentId);
    const entry = this.keys.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= clockMs) {
      this.keys.delete(key);
      return undefined;
    }
    return entry;
  }

  set(entry: PresenceEntry): Promise<void> {
    this.keys.set(presenceKey(entry.agentId), {
      fields: new Map([
        ['status', entry.status],
        ['languages', JSON.stringify(entry.languages)],
        ['last_seen', entry.lastSeen.toISOString()],
        ['tenant_id', entry.tenantId],
      ]),
      expiresAtMs: clockMs + PRESENCE_TTL_SECONDS * 1000,
    });
    return Promise.resolve();
  }

  touch(agentId: string, lastSeen: Date): Promise<TouchResult | null> {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(null);
    const iso = lastSeen.toISOString();
    entry.fields.set('last_seen', iso);
    entry.expiresAtMs = clockMs + PRESENCE_TTL_SECONDS * 1000;
    return Promise.resolve({
      status: (entry.fields.get('status') ?? '') as AgentPresence,
      lastSeen: iso,
    });
  }

  read(agentId: string) {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(null);
    return Promise.resolve({
      status: (entry.fields.get('status') ?? '') as AgentPresence,
      languages: JSON.parse(entry.fields.get('languages') ?? '[]') as string[],
      lastSeen: entry.fields.get('last_seen') ?? '',
      tenantId: entry.fields.get('tenant_id') ?? '',
    });
  }

  remove(agentId: string): Promise<void> {
    this.keys.delete(presenceKey(agentId));
    return Promise.resolve();
  }

  setStatus(agentId: string, status: AgentPresence): Promise<boolean> {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(false);
    entry.fields.set('status', status);
    return Promise.resolve(true);
  }

  ttl(agentId: string): Promise<number> {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(-2);
    return Promise.resolve(Math.ceil((entry.expiresAtMs - clockMs) / 1000));
  }
}

class FakeApiKeyStore implements ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    if (prefix !== 'vcip_tenanta') return Promise.resolve(null);
    return Promise.resolve({
      id: 'key-a',
      tenantId: TENANT_A,
      keyHash: hashApiKey(API_KEY_A),
      scopes: ['sessions:write'],
      expiresAt: null,
      revokedAt: null,
    });
  }
}

// ------------------------------------------------------------- application

const presenceStore = new FakePresenceRepository();

@Module({
  imports: [LoggingModule],
  controllers: [AgentsController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    { provide: API_KEY_STORE, useClass: FakeApiKeyStore },
    ApiKeyGuard,
    AgentJwtGuard,
    TenantScope,
    TenantGuard,
    { provide: AGENT_REPOSITORY, useClass: FakeAgentRepository },
    { provide: PRESENCE_REPOSITORY, useValue: presenceStore },
    AgentsService,
    {
      provide: PresenceService,
      useFactory: (presence: PresenceRepository, agents: AgentRepository, logger) =>
        new PresenceService(presence, agents, logger, () => new Date(clockMs)),
      inject: [PRESENCE_REPOSITORY, AGENT_REPOSITORY, LOGGER],
    },
  ],
})
class TestAgentsModule {}

// -------------------------------------------------------------- fixtures

const customerToken = (tenantId: string, sessionId: string): string =>
  signJwt(
    { act: CUSTOMER_ACTOR_CLAIM, tid: tenantId, sid: sessionId },
    { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds: 7200 },
  );

describe('agent identity and presence over HTTP', () => {
  let app: INestApplication;
  let logged = '';

  const post = (path: string) => request(app.getHttpServer()).post(`/v1/agent${path}`);

  const loginAs = async (
    email = 'agent.one@demo.local',
    slug = 'demo-bank',
    password = PASSWORD,
  ): Promise<string> => {
    const response = await post('/login').send({ tenant_slug: slug, email, password });
    expect(response.status).toBe(200);
    return response.body.data.access_token as string;
  };

  const bearer = (path: string, token: string) =>
    post(path).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const hash = await hashPassword(PASSWORD);
    credentials = [
      {
        userId: AGENT_A1,
        tenantId: TENANT_A,
        email: 'agent.one@demo.local',
        role: 'AGENT',
        status: 'ACTIVE',
        tenantStatus: 'ACTIVE',
        passwordHash: hash,
      },
      {
        userId: AGENT_A2,
        tenantId: TENANT_A,
        email: 'agent.two@demo.local',
        role: 'AGENT',
        status: 'ACTIVE',
        tenantStatus: 'ACTIVE',
        passwordHash: hash,
      },
      {
        userId: AGENT_B1,
        tenantId: TENANT_B,
        email: 'agent.one@other.local',
        role: 'AGENT',
        status: 'ACTIVE',
        tenantStatus: 'ACTIVE',
        passwordHash: hash,
      },
      {
        userId: 'disabled-a',
        tenantId: TENANT_A,
        email: 'agent.gone@demo.local',
        role: 'AGENT',
        status: 'DISABLED',
        tenantStatus: 'ACTIVE',
        passwordHash: hash,
      },
      {
        userId: 'admin-a',
        tenantId: TENANT_A,
        email: 'admin@demo.local',
        role: 'TENANT_ADMIN',
        status: 'ACTIVE',
        tenantStatus: 'ACTIVE',
        passwordHash: hash,
      },
    ];
  });

  beforeEach(async () => {
    clockMs = Date.parse('2026-08-31T09:00:00.000Z');
    presenceStore.keys.clear();
    logged = '';

    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logged += String(chunk);
        callback();
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [TestAgentsModule] })
      .overrideProvider(LOGGER)
      .useValue(createLogger({ level: 'debug', destination: stream }))
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiErrorFilter(createLogger({ level: 'debug', destination: stream })));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------- login

  describe('POST /v1/agent/login', () => {
    it('returns a token in the documented envelope', async () => {
      const response = await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'agent.one@demo.local',
        password: PASSWORD,
      });

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toEqual(['data']);
      expect(response.body.data.token_type).toBe('Bearer');
      expect(typeof response.body.data.access_token).toBe('string');
      expect(Date.parse(response.body.data.expires_at)).toBeGreaterThan(Date.now());
    });

    it('accepts an email in any case', async () => {
      const response = await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'Agent.One@Demo.Local',
        password: PASSWORD,
      });
      expect(response.status).toBe(200);
    });

    it('returns no password hash and no user record', async () => {
      const response = await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'agent.one@demo.local',
        password: PASSWORD,
      });
      const body = JSON.stringify(response.body);
      expect(body).not.toContain('scrypt');
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain('password');
      expect(Object.keys(response.body.data).sort()).toEqual([
        'access_token',
        'expires_at',
        'token_type',
      ]);
    });

    it('rejects a wrong password in the documented error envelope', async () => {
      const response = await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'agent.one@demo.local',
        password: 'FAKE-WRONG-PASSWORD-0000',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
      expect(typeof response.body.error.request_id).toBe('string');
    });

    it('answers identically for an unknown email, unknown tenant, and disabled user', async () => {
      const bodies = await Promise.all(
        [
          { tenant_slug: 'demo-bank', email: 'nobody@demo.local', password: PASSWORD },
          { tenant_slug: 'no-such-bank', email: 'agent.one@demo.local', password: PASSWORD },
          { tenant_slug: 'demo-bank', email: 'agent.gone@demo.local', password: PASSWORD },
          { tenant_slug: 'demo-bank', email: 'admin@demo.local', password: PASSWORD },
          {
            tenant_slug: 'demo-bank',
            email: 'agent.one@demo.local',
            password: 'FAKE-WRONG-PASSWORD-0000',
          },
        ].map(async (body) => {
          const response = await post('/login').send(body);
          expect(response.status).toBe(401);
          // The request id differs per request by design; the rest must not.
          return JSON.stringify({
            code: response.body.error.code,
            message: response.body.error.message,
          });
        }),
      );

      expect(new Set(bodies).size).toBe(1);
    });

    it('rejects a malformed body without echoing it', async () => {
      const response = await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'not-an-email',
        password: PASSWORD,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    });

    it('rejects a body naming a tenant id or a role', async () => {
      for (const extra of [{ tenant_id: TENANT_B }, { role: 'TENANT_ADMIN' }, { uid: AGENT_B1 }]) {
        const response = await post('/login').send({
          tenant_slug: 'demo-bank',
          email: 'agent.one@demo.local',
          password: PASSWORD,
          ...extra,
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('does not make the agent available', async () => {
      // §17: the approved flow is login, then an explicit availability call.
      await loginAs();
      expect(presenceStore.keys.size).toBe(0);
    });

    it('logs no credential', async () => {
      await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'agent.one@demo.local',
        password: PASSWORD,
      });
      await post('/login').send({
        tenant_slug: 'demo-bank',
        email: 'agent.one@demo.local',
        password: 'FAKE-WRONG-PASSWORD-0000',
      });

      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('FAKE-WRONG-PASSWORD-0000');
      expect(logged).not.toContain('scrypt');
      expect(logged).not.toContain(TEST_AUTH_CONFIG.agentJwtSecret);
    });
  });

  // ------------------------------------------------------ authorization

  describe('who may reach the agent routes', () => {
    it('accepts a token minted by login', async () => {
      const token = await loginAs();
      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });
      expect(response.status).toBe(200);
    });

    it('rejects a customer token', async () => {
      const response = await post('/availability')
        .set('Authorization', `Bearer ${customerToken(TENANT_A, 'session-1')}`)
        .send({ status: 'AVAILABLE' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('rejects an enterprise API key', async () => {
      const response = await post('/availability')
        .set('Authorization', `Bearer ${API_KEY_A}`)
        .send({ status: 'AVAILABLE' });
      expect(response.status).toBe(401);
    });

    it('rejects the internal token', async () => {
      const response = await post('/availability')
        .set(INTERNAL_TOKEN_HEADER, TEST_AUTH_CONFIG.internalToken)
        .send({ status: 'AVAILABLE' });
      expect(response.status).toBe(401);
    });

    it('rejects a missing, malformed, or expired token', async () => {
      const expired = signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: TENANT_A, uid: AGENT_A1, role: 'AGENT' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: -60 },
      );
      for (const header of [undefined, 'Bearer not.a.token', `Bearer ${expired}`]) {
        const call = post('/heartbeat');
        if (header !== undefined) call.set('Authorization', header);
        expect((await call.send({})).status).toBe(401);
      }
    });

    it('rejects a token signed with the customer secret', async () => {
      // Purpose binding: distinct secrets plus the `act` claim.
      const forged = signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: TENANT_A, uid: AGENT_A1, role: 'AGENT' },
        { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds: 3600 },
      );
      const response = await bearer('/availability', forged).send({ status: 'AVAILABLE' });
      expect(response.status).toBe(401);
    });

    it('rejects a body asserting a different tenant', async () => {
      // TenantGuard runs before the pipe, so this is a 403 rather than the 400
      // the strict schema would otherwise give.
      const token = await loginAs();
      const response = await bearer('/availability', token).send({
        status: 'AVAILABLE',
        tenant_id: TENANT_B,
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('rejects a body naming its own tenant too', async () => {
      // Matching the credential gets past TenantGuard and is then refused by
      // the schema: the field has no place in the request either way.
      const token = await loginAs();
      const response = await bearer('/availability', token).send({
        status: 'AVAILABLE',
        tenant_id: TENANT_A,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // ------------------------------------------------------ availability

  describe('POST /v1/agent/availability', () => {
    it('creates a presence for AVAILABLE', async () => {
      const token = await loginAs();
      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });

      expect(response.body).toEqual({ data: { agent_id: AGENT_A1, status: 'AVAILABLE' } });
      expect(await presenceStore.read(AGENT_A1)).toEqual({
        status: 'AVAILABLE',
        languages: ['en', 'hi'],
        lastSeen: '2026-08-31T09:00:00.000Z',
        tenantId: TENANT_A,
      });
    });

    it('stores exactly the approved fields', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });

      const stored = presenceStore.keys.get(presenceKey(AGENT_A1));
      expect([...(stored?.fields.keys() ?? [])].sort()).toEqual([...PRESENCE_FIELDS].sort());
      const serialised = JSON.stringify([...(stored?.fields.entries() ?? [])]);
      expect(serialised).not.toContain('demo.local');
      expect(serialised).not.toContain('scrypt');
      expect(serialised).not.toContain(PASSWORD);
    });

    it('removes the presence for UNAVAILABLE', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      const response = await bearer('/availability', token).send({ status: 'UNAVAILABLE' });

      expect(response.body).toEqual({ data: { agent_id: AGENT_A1, status: 'UNAVAILABLE' } });
      expect(await presenceStore.read(AGENT_A1)).toBeNull();
    });

    it('rejects BUSY', async () => {
      const token = await loginAs();
      const response = await bearer('/availability', token).send({ status: 'BUSY' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(presenceStore.keys.size).toBe(0);
    });

    it('rejects a client-chosen agent id, language list, or last_seen', async () => {
      const token = await loginAs();
      for (const extra of [
        { agent_id: AGENT_A2 },
        { user_id: AGENT_A2 },
        { languages: ['fr'] },
        { last_seen: '2020-01-01T00:00:00.000Z' },
        { max_concurrent: 99 },
      ]) {
        const response = await bearer('/availability', token).send({
          status: 'AVAILABLE',
          ...extra,
        });
        expect(response.status).toBe(400);
      }
      expect(presenceStore.keys.size).toBe(0);
    });

    it('repeats safely in both directions', async () => {
      const token = await loginAs();
      for (const status of ['AVAILABLE', 'AVAILABLE', 'AVAILABLE'] as const) {
        expect((await bearer('/availability', token).send({ status })).status).toBe(200);
      }
      expect(presenceStore.keys.size).toBe(1);

      for (const status of ['UNAVAILABLE', 'UNAVAILABLE'] as const) {
        expect((await bearer('/availability', token).send({ status })).status).toBe(200);
      }
      expect(presenceStore.keys.size).toBe(0);
    });

    it('refuses a tenant admin', async () => {
      // The admin cannot log in at all, so mint the token directly: this
      // asserts the second gate rather than relying on the first.
      const adminToken = signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: TENANT_A, uid: 'admin-a', role: 'TENANT_ADMIN' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
      );
      const response = await bearer('/availability', adminToken).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(403);
      expect(presenceStore.keys.size).toBe(0);
    });
  });

  // --------------------------------------------------------- heartbeat

  describe('POST /v1/agent/heartbeat', () => {
    it('refreshes last_seen and the TTL', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });

      clockMs += 10_000;
      expect(await presenceStore.ttl(AGENT_A1)).toBe(5);

      const response = await bearer('/heartbeat', token).send({});

      expect(response.body).toEqual({
        data: {
          agent_id: AGENT_A1,
          status: 'AVAILABLE',
          last_seen: '2026-08-31T09:00:10.000Z',
        },
      });
      expect(await presenceStore.ttl(AGENT_A1)).toBe(PRESENCE_TTL_SECONDS);
    });

    it('exposes no TTL to the client', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      const response = await bearer('/heartbeat', token).send({});

      expect(Object.keys(response.body.data).sort()).toEqual(['agent_id', 'last_seen', 'status']);
    });

    it('reports an expired presence as not live and creates nothing', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });

      clockMs += (PRESENCE_TTL_SECONDS + 1) * 1000;
      const response = await bearer('/heartbeat', token).send({});

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        agent_id: AGENT_A1,
        status: 'UNAVAILABLE',
        last_seen: null,
      });
      expect(presenceStore.keys.size).toBe(0);
    });

    it('does not resurrect an agent who went unavailable', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      await bearer('/availability', token).send({ status: 'UNAVAILABLE' });

      await bearer('/heartbeat', token).send({});
      await bearer('/heartbeat', token).send({});

      expect(presenceStore.keys.size).toBe(0);
    });

    it('rejects any field in the body', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });

      for (const body of [
        { status: 'BUSY' },
        { status: 'AVAILABLE' },
        { agent_id: AGENT_A2 },
        { languages: ['fr'] },
      ]) {
        expect((await bearer('/heartbeat', token).send(body)).status).toBe(400);
      }
      // ...and the presence is untouched by the rejected calls.
      expect((await presenceStore.read(AGENT_A1))?.languages).toEqual(['en', 'hi']);
    });

    it('cannot be used to clear BUSY', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      await presenceStore.setStatus(AGENT_A1, AgentPresence.BUSY);

      const response = await bearer('/heartbeat', token).send({});

      expect(response.body.data.status).toBe('BUSY');
      expect((await presenceStore.read(AGENT_A1))?.status).toBe('BUSY');
    });
  });

  // ---------------------------------------------------------- isolation

  describe('one agent cannot reach another', () => {
    it('keeps two agents of one tenant separate', async () => {
      const one = await loginAs('agent.one@demo.local');
      const two = await loginAs('agent.two@demo.local');

      await bearer('/availability', one).send({ status: 'AVAILABLE' });
      await bearer('/availability', two).send({ status: 'AVAILABLE' });

      expect((await presenceStore.read(AGENT_A1))?.languages).toEqual(['en', 'hi']);
      expect((await presenceStore.read(AGENT_A2))?.languages).toEqual(['ta']);

      // One goes away; the other is untouched.
      await bearer('/availability', one).send({ status: 'UNAVAILABLE' });
      expect(await presenceStore.read(AGENT_A1)).toBeNull();
      expect(await presenceStore.read(AGENT_A2)).not.toBeNull();
    });

    it('keeps two tenants separate', async () => {
      const a = await loginAs('agent.one@demo.local', 'demo-bank');
      const b = await loginAs('agent.one@other.local', 'other-bank');

      await bearer('/availability', a).send({ status: 'AVAILABLE' });
      await bearer('/availability', b).send({ status: 'AVAILABLE' });

      expect((await presenceStore.read(AGENT_A1))?.tenantId).toBe(TENANT_A);
      expect((await presenceStore.read(AGENT_B1))?.tenantId).toBe(TENANT_B);
    });

    it('refuses a token whose tenant does not own the user', async () => {
      // A forged or stale token naming tenant B for an agent of tenant A. The
      // profile lookup is scoped by both, so it finds nothing (I8).
      const crossed = signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: TENANT_B, uid: AGENT_A1, role: 'AGENT' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
      );
      const response = await bearer('/availability', crossed).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(403);
      expect(presenceStore.keys.size).toBe(0);
    });

    it('logs no token and no email across the whole flow', async () => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      await bearer('/heartbeat', token).send({});
      await bearer('/availability', token).send({ status: 'UNAVAILABLE' });

      expect(logged).not.toContain(token);
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain(API_KEY_A);
      // The safe fields are present, so this is not passing by logging nothing.
      expect(logged).toContain('agent.availability.set');
      expect(logged).toContain(AGENT_A1);
      expect(logged).toContain(TENANT_A);
    });
  });
});
