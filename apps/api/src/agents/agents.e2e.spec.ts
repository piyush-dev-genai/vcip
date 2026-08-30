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
import { AgentPresence, ErrorCode, SessionStatus } from '@vcip/shared';
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
import { queueKey } from '../queue/queue.keys.js';
import type {
  QueueCandidate,
  QueueEntry,
  QueueMember,
  QueueRepository,
} from '../queue/queue.repository.js';
import { QUEUE_REPOSITORY } from '../queue/queue.repository.js';
import type {
  CreateSessionInput,
  GuardedUpdate,
  QueuedSessionRow,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import { SESSION_REPOSITORY } from '../sessions/session.repository.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { AGENT_REPOSITORY } from './agent.repository.js';
import { AgentQueueService } from './agent-queue.service.js';
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

/**
 * A real ZSET, and deliberately no notion of session status.
 *
 * Redis does not know what `QUEUED` means, and neither does this. Anything
 * seeded here comes back from `range` — which is what makes the PostgreSQL
 * validation testable rather than assumed.
 */
class FakeQueueRepository implements QueueRepository {
  readonly sets = new Map<string, Map<string, number>>();
  readonly readKeys: string[] = [];

  clear(): void {
    this.sets.clear();
    this.readKeys.length = 0;
  }

  seed(tenantId: string, language: string, sessionId: string, score: number): void {
    const key = queueKey(tenantId, language);
    const set = this.sets.get(key) ?? new Map<string, number>();
    set.set(sessionId, score);
    this.sets.set(key, set);
  }

  add(entry: QueueEntry): Promise<void> {
    this.seed(entry.tenantId, entry.language, entry.sessionId, entry.score);
    return Promise.resolve();
  }

  rank(member: QueueMember): Promise<number | null> {
    const set = this.sets.get(queueKey(member.tenantId, member.language));
    if (set === undefined || !set.has(member.sessionId)) return Promise.resolve(null);
    return Promise.resolve(this.ordered(set).findIndex(([id]) => id === member.sessionId));
  }

  range(tenantId: string, language: string, limit: number): Promise<readonly QueueCandidate[]> {
    const key = queueKey(tenantId, language);
    this.readKeys.push(key);
    const set = this.sets.get(key);
    if (set === undefined || limit <= 0) return Promise.resolve([]);
    return Promise.resolve(
      this.ordered(set)
        .slice(0, limit)
        .map(([sessionId, score]) => ({ sessionId, score })),
    );
  }

  private ordered(set: Map<string, number>): Array<[string, number]> {
    return [...set.entries()].sort(
      (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
  }
}

interface StoredSession {
  id: string;
  tenantId: string;
  status: SessionStatus;
  language: string;
  priority: number;
  queuedAt: Date;
  version: number;
}

/**
 * The session store, with a mutation counter.
 *
 * `writes` is what proves the read-only invariant over HTTP: the three
 * mutating methods increment it and then throw, so a queue view that touched a
 * session would fail loudly rather than pass quietly.
 */
class FakeSessionStore implements SessionRepository {
  readonly rows = new Map<string, StoredSession>();
  writes = 0;

  clear(): void {
    this.rows.clear();
    this.writes = 0;
  }

  seed(session: StoredSession): void {
    this.rows.set(session.id, session);
  }

  findQueued(
    tenantId: string,
    sessionIds: readonly string[],
  ): Promise<readonly QueuedSessionRow[]> {
    const wanted = new Set(sessionIds);
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            wanted.has(row.id) && row.tenantId === tenantId && row.status === SessionStatus.QUEUED,
        )
        .map((row) => ({
          id: row.id,
          language: row.language,
          priority: row.priority,
          queuedAt: row.queuedAt,
        })),
    );
  }

  create(_input: CreateSessionInput): Promise<SessionRow> {
    this.writes += 1;
    throw new Error('the queue view must not create a session');
  }

  findById(_sessionId: string): Promise<SessionRow | null> {
    this.writes += 1;
    throw new Error('the queue view must not read sessions one at a time');
  }

  update(_command: GuardedUpdate): Promise<SessionRow | null> {
    this.writes += 1;
    throw new Error('the queue view must not update a session');
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
const queueStore = new FakeQueueRepository();
const sessionStore = new FakeSessionStore();

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
    { provide: QUEUE_REPOSITORY, useValue: queueStore },
    { provide: SESSION_REPOSITORY, useValue: sessionStore },
    {
      provide: AgentQueueService,
      useFactory: (
        queue: QueueRepository,
        sessions: SessionRepository,
        agents: AgentRepository,
        logger,
      ) => new AgentQueueService(queue, sessions, agents, logger, () => new Date(clockMs)),
      inject: [QUEUE_REPOSITORY, SESSION_REPOSITORY, AGENT_REPOSITORY, LOGGER],
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
    queueStore.clear();
    sessionStore.clear();
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

  // ------------------------------------------------------------- queue

  describe('GET /v1/agent/queue', () => {
    /** 32 seconds before the frozen clock, so wait_seconds is predictable. */
    const QUEUED_AT = Date.parse('2026-08-31T08:59:28.000Z');

    const get = (token: string) =>
      request(app.getHttpServer()).get('/v1/agent/queue').set('Authorization', `Bearer ${token}`);

    /** Consistent state: the row in PostgreSQL and the member in its queue. */
    const enqueue = (id: string, over: Partial<StoredSession> = {}): StoredSession => {
      const row: StoredSession = {
        id,
        tenantId: TENANT_A,
        status: SessionStatus.QUEUED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(QUEUED_AT),
        version: 2,
        ...over,
      };
      sessionStore.seed(row);
      queueStore.seed(row.tenantId, row.language, row.id, row.queuedAt.getTime());
      return row;
    };

    /** A member in Redis whose session is not eligible, or does not exist. */
    const seedStale = (id: string, status: SessionStatus | null, tenantId = TENANT_A): void => {
      if (status !== null) {
        sessionStore.seed({
          id,
          tenantId,
          status,
          language: 'en',
          priority: 0,
          queuedAt: new Date(QUEUED_AT),
          version: 2,
        });
      }
      queueStore.seed(TENANT_A, 'en', id, QUEUED_AT);
    };

    interface Row {
      session_id: string;
      language: string;
      priority: number;
      queued_at: string;
      wait_seconds: number;
    }

    const rowsOf = (body: { data: { sessions: Row[] } }): Row[] => body.data.sessions;
    const idsOf = (body: { data: { sessions: Row[] } }): string[] =>
      rowsOf(body).map((row) => row.session_id);

    it('returns the documented envelope and fields', async () => {
      enqueue('session-1');

      const response = await get(await loginAs());

      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toEqual([
        {
          session_id: 'session-1',
          language: 'en',
          priority: 0,
          queued_at: '2026-08-31T08:59:28.000Z',
          wait_seconds: 32,
        },
      ]);
    });

    it('returns an empty list rather than a 404 when nothing is queued', async () => {
      const response = await get(await loginAs());

      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toEqual([]);
    });

    // --- who may reach it -------------------------------------------------

    it('rejects a request with no credential', async () => {
      const response = await request(app.getHttpServer()).get('/v1/agent/queue');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('rejects a customer token', async () => {
      const response = await get(customerToken(TENANT_A, 'session-1'));

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('rejects an enterprise API key', async () => {
      const response = await get(API_KEY_A);

      expect(response.status).toBe(401);
    });

    it('rejects the internal token', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/agent/queue')
        .set(INTERNAL_TOKEN_HEADER, TEST_AUTH_CONFIG.internalToken);

      expect(response.status).toBe(401);
    });

    it('rejects an agent-shaped token signed with the customer secret', async () => {
      const forged = signJwt(
        { act: AGENT_ACTOR_CLAIM, uid: AGENT_A1, tid: TENANT_A, role: 'AGENT' },
        { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds: 3600 },
      );

      expect((await get(forged)).status).toBe(401);
    });

    it('refuses a user who holds a valid agent JWT but has no agent profile', async () => {
      const admin = signJwt(
        { act: AGENT_ACTOR_CLAIM, uid: 'admin-a', tid: TENANT_A, role: 'TENANT_ADMIN' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
      );

      const response = await get(admin);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    // --- identity comes from the token ------------------------------------

    it('rejects a query string that names a different tenant', async () => {
      enqueue('a-session');
      const token = await loginAs();

      const response = await request(app.getHttpServer())
        .get(`/v1/agent/queue?tenant_id=${TENANT_B}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('ignores an agent_id in the query string', async () => {
      enqueue('a-session');
      const token = await loginAs();

      const response = await request(app.getHttpServer())
        .get(`/v1/agent/queue?agent_id=${AGENT_B1}`)
        .set('Authorization', `Bearer ${token}`);

      // Answered for the authenticated agent, who is in tenant A.
      expect(response.status).toBe(200);
      expect(idsOf(response.body)).toEqual(['a-session']);
    });

    it('ignores a language in the query string', async () => {
      enqueue('ta-session', { language: 'ta' });
      const token = await loginAs();

      const response = await request(app.getHttpServer())
        .get('/v1/agent/queue?language=ta')
        .set('Authorization', `Bearer ${token}`);

      // agent.one works en and hi; a query parameter cannot add ta.
      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toEqual([]);
    });

    it('ignores a limit in the query string', async () => {
      for (let i = 0; i < 25; i += 1) {
        enqueue(`s-${String(i).padStart(2, '0')}`, {
          queuedAt: new Date(QUEUED_AT + i * 1000),
        });
      }
      const token = await loginAs();

      const response = await request(app.getHttpServer())
        .get('/v1/agent/queue?limit=100')
        .set('Authorization', `Bearer ${token}`);

      expect(response.body.data.sessions).toHaveLength(20);
    });

    // --- tenant isolation --------------------------------------------------

    it('shows each agent only its own tenant queued sessions', async () => {
      enqueue('a-session');
      enqueue('b-session', { tenantId: TENANT_B });

      const a = await get(await loginAs());
      const b = await get(await loginAs('agent.one@other.local', 'other-bank'));

      expect(idsOf(a.body)).toEqual(['a-session']);
      expect(idsOf(b.body)).toEqual(['b-session']);
    });

    it('reads no queue key belonging to another tenant', async () => {
      await get(await loginAs());

      expect(queueStore.readKeys.length).toBeGreaterThan(0);
      for (const key of queueStore.readKeys) {
        expect(key.startsWith(`queue:${TENANT_A}:`)).toBe(true);
        expect(key).not.toContain(TENANT_B);
      }
    });

    it('does not leak another tenant session planted in this tenant key', async () => {
      seedStale('planted', SessionStatus.QUEUED, TENANT_B);

      const response = await get(await loginAs());

      expect(response.body.data.sessions).toEqual([]);
    });

    // --- language ----------------------------------------------------------

    it('shows a multi-language agent every configured language', async () => {
      enqueue('en-1', { language: 'en', queuedAt: new Date(QUEUED_AT) });
      enqueue('hi-1', { language: 'hi', queuedAt: new Date(QUEUED_AT + 1000) });

      expect(idsOf((await get(await loginAs())).body)).toEqual(['en-1', 'hi-1']);
    });

    it('shows a single-language agent nothing from another language', async () => {
      enqueue('ta-1', { language: 'ta' });
      enqueue('en-1', { language: 'en' });

      // agent.two works only `ta`.
      const response = await get(await loginAs('agent.two@demo.local'));

      expect(idsOf(response.body)).toEqual(['ta-1']);
    });

    it('merges the language queues by enqueue time, not grouped by language', async () => {
      enqueue('A', { language: 'en', queuedAt: new Date(QUEUED_AT) });
      enqueue('B', { language: 'hi', queuedAt: new Date(QUEUED_AT + 2000) });
      enqueue('C', { language: 'en', queuedAt: new Date(QUEUED_AT + 5000) });
      enqueue('D', { language: 'hi', queuedAt: new Date(QUEUED_AT + 6000) });

      expect(idsOf((await get(await loginAs())).body)).toEqual(['A', 'B', 'C', 'D']);
    });

    it('matches a session language stored in a different case', async () => {
      enqueue('shouty', { language: 'EN' });

      expect(idsOf((await get(await loginAs())).body)).toEqual(['shouty']);
    });

    it('does not treat en-IN as en', async () => {
      enqueue('regional', { language: 'en-IN' });

      expect((await get(await loginAs())).body.data.sessions).toEqual([]);
    });

    // --- PostgreSQL is the authority ---------------------------------------

    it('excludes every non-QUEUED status even though Redis still holds the member', async () => {
      const excluded = [
        SessionStatus.CREATED,
        SessionStatus.PREFLIGHT_FAILED,
        SessionStatus.OFFERED,
        SessionStatus.IN_CALL,
        SessionStatus.APPROVED,
        SessionStatus.REJECTED,
        SessionStatus.ABORTED,
        SessionStatus.DROPPED_QUEUED,
        SessionStatus.DROPPED_IN_CALL,
      ];
      for (const [i, status] of excluded.entries()) seedStale(`s-${i}`, status);

      const response = await get(await loginAs());

      expect(response.body.data.sessions).toEqual([]);
      // Still in Redis: removal belongs to the task that owns it.
      expect(queueStore.sets.get(queueKey(TENANT_A, 'en'))?.size).toBe(excluded.length);
    });

    it('returns the live sessions around a stale member', async () => {
      enqueue('live-1', { queuedAt: new Date(QUEUED_AT) });
      seedStale('gone', SessionStatus.DROPPED_QUEUED);
      enqueue('live-2', { queuedAt: new Date(QUEUED_AT + 2000) });

      expect(idsOf((await get(await loginAs())).body)).toEqual(['live-1', 'live-2']);
    });

    it('does not return a member with no session row at all', async () => {
      seedStale('ghost', null);

      expect((await get(await loginAs())).body.data.sessions).toEqual([]);
    });

    it('does not return a session PostgreSQL has queued but Redis has lost', async () => {
      // The documented limitation: no reconciliation happens on this GET.
      sessionStore.seed({
        id: 'orphan',
        tenantId: TENANT_A,
        status: SessionStatus.QUEUED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(QUEUED_AT),
        version: 2,
      });

      expect((await get(await loginAs())).body.data.sessions).toEqual([]);
    });

    // --- derived values ----------------------------------------------------

    it('derives wait_seconds from the server clock', async () => {
      enqueue('waiting', { queuedAt: new Date(clockMs - 45_000) });

      expect(rowsOf((await get(await loginAs())).body)[0]?.wait_seconds).toBe(45);
    });

    it('reports a larger wait once the clock advances, with no change to the request', async () => {
      enqueue('waiting', { queuedAt: new Date(clockMs - 10_000) });
      const token = await loginAs();

      const first = await get(token);
      clockMs += 7000;
      const second = await get(token);

      expect(rowsOf(first.body)[0]?.wait_seconds).toBe(10);
      expect(rowsOf(second.body)[0]?.wait_seconds).toBe(17);
    });

    it('returns priority without ordering by it', async () => {
      enqueue('older', { priority: 0, queuedAt: new Date(QUEUED_AT) });
      enqueue('newer', { priority: 9, queuedAt: new Date(QUEUED_AT + 5000) });

      const response = await get(await loginAs());

      expect(idsOf(response.body)).toEqual(['older', 'newer']);
      expect(rowsOf(response.body).map((row) => row.priority)).toEqual([0, 9]);
    });

    it('exposes no field beyond the five the contract defines', async () => {
      enqueue('session-1');

      const response = await get(await loginAs());

      expect(Object.keys(response.body.data.sessions[0]).sort()).toEqual([
        'language',
        'priority',
        'queued_at',
        'session_id',
        'wait_seconds',
      ]);
    });

    // --- bounded -----------------------------------------------------------

    it('returns at most twenty sessions however long the queue is', async () => {
      for (let i = 0; i < 60; i += 1) {
        enqueue(`s-${String(i).padStart(2, '0')}`, {
          queuedAt: new Date(QUEUED_AT + i * 1000),
        });
      }

      const response = await get(await loginAs());

      expect(response.body.data.sessions).toHaveLength(20);
      expect(idsOf(response.body)[0]).toBe('s-00');
      expect(idsOf(response.body).at(-1)).toBe('s-19');
    });

    // --- read-only ---------------------------------------------------------

    it('changes no session row, version, or status', async () => {
      enqueue('one', { version: 4 });
      enqueue('two', { version: 9, queuedAt: new Date(QUEUED_AT + 1000) });
      const before = JSON.stringify([...sessionStore.rows.values()]);
      const token = await loginAs();

      await get(token);
      await get(token);

      expect(JSON.stringify([...sessionStore.rows.values()])).toBe(before);
      // create/findById/update all increment this before throwing.
      expect(sessionStore.writes).toBe(0);
    });

    it('changes no queue membership or score', async () => {
      enqueue('one');
      seedStale('stale-member', SessionStatus.ABORTED);
      const snapshot = (): string =>
        JSON.stringify([...queueStore.sets].map(([k, v]) => [k, [...v.entries()].sort()]));
      const before = snapshot();

      await get(await loginAs());

      expect(snapshot()).toBe(before);
    });

    it('does not create a presence', async () => {
      enqueue('one');
      const token = await loginAs();

      await get(token);

      expect(presenceStore.keys.has(presenceKey(AGENT_A1))).toBe(false);
    });

    it('does not require the agent to be AVAILABLE', async () => {
      enqueue('one');

      // No availability call has been made, so there is no presence at all.
      const response = await get(await loginAs());

      expect(response.status).toBe(200);
      expect(idsOf(response.body)).toEqual(['one']);
    });

    it('leaves an existing AVAILABLE presence exactly as it was', async () => {
      enqueue('one');
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      const before = await presenceStore.read(AGENT_A1);

      await get(token);

      expect(await presenceStore.read(AGENT_A1)).toEqual(before);
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.AVAILABLE);
    });

    it('is idempotent across repeated reads', async () => {
      enqueue('one', { queuedAt: new Date(QUEUED_AT) });
      enqueue('two', { queuedAt: new Date(QUEUED_AT + 1000) });
      const token = await loginAs();

      const first = idsOf((await get(token)).body);
      const second = idsOf((await get(token)).body);
      const third = idsOf((await get(token)).body);

      expect(first).toEqual(['one', 'two']);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    // --- logging -----------------------------------------------------------

    it('logs identifiers and counts, never a token, password, or session id', async () => {
      enqueue('session-1');
      const token = await loginAs();
      logged = '';

      await get(token);

      expect(logged).toContain('agent.queue.viewed');
      expect(logged).toContain(TENANT_A);
      expect(logged).toContain(AGENT_A1);
      expect(logged).toContain('candidate_count');
      expect(logged).toContain('returned_count');
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('session-1');
    });
  });

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
