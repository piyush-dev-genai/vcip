/**
 * The session lifecycle through a real Nest application, over real HTTP.
 *
 * Everything between the socket and the datastore is the production code: the
 * controller, the T09 guards, the T10 error filter, the T11 idempotency
 * interceptor, the validation pipes, and `SessionsService` itself. Only the
 * three I/O ports are substituted — the session repository, the tenant config
 * store, and the geo provider — because a test that cannot run without
 * PostgreSQL is a test that stops being run.
 *
 * The in-memory repository below reproduces the one property that matters:
 * `update` commits only when the row still matches the id, tenant, status, and
 * version the caller observed. That is the guard the real SQL carries, and the
 * concurrency tests are meaningless without it.
 *
 * The live PostgreSQL path is exercised separately, by the HTTP walkthrough in
 * the T12 validation run.
 */

import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ErrorCode, SessionStatus } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentJwtGuard, AGENT_ACTOR_CLAIM } from '../common/auth/agent-jwt.guard.js';
import { ApiKeyGuard } from '../common/auth/api-key.guard.js';
import type { ApiKeyRecord, ApiKeyStore } from '../common/auth/api-key.store.js';
import { API_KEY_STORE, hashApiKey } from '../common/auth/api-key.store.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG, CUSTOMER_TOKEN_TTL_SECONDS } from '../common/auth/auth.config.js';
import { CustomerTokenGuard, CUSTOMER_ACTOR_CLAIM } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { signJwt } from '../common/auth/tokens.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import type { GeoDecision, GeoProvider } from '../common/geo/geo.provider.js';
import { GEO_PROVIDER } from '../common/geo/geo.provider.js';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor.js';
import { IdempotencyStore } from '../common/idempotency/idempotency.store.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import { REDIS } from '../common/redis/redis.tokens.js';
import type { TenantConfig, TenantConfigStore } from '../tenants/tenant-config.store.js';
import { TENANT_CONFIG_STORE } from '../tenants/tenant-config.store.js';
import { TenantsService } from '../tenants/tenants.service.js';
import type {
  CreateSessionInput,
  ClaimableSessionRow,
  MediaTokenSessionRow,
  ClaimCommand,
  ExpiredOfferRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  GuardedUpdate,
  QueuedSessionRow,
  SessionRepository,
  SessionRow,
} from './session.repository.js';
import { QUEUE_REPOSITORY, RedisQueueRepository } from '../queue/queue.repository.js';
import { QueueService } from '../queue/queue.service.js';
import { SESSION_REPOSITORY } from './session.repository.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

// ------------------------------------------------------------------ fakes

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

/** Never a real credential. 32+ characters, as `auth.config.ts` demands. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-tests-0123456789',
  agentJwtSecret: 'FAKE-agent-secret-for-tests-9876543210ab',
  internalToken: 'FAKE-internal-token-for-tests-abcdefghij',
  customerTokenTtlSeconds: CUSTOMER_TOKEN_TTL_SECONDS,
  agentJwtTtlSeconds: 3600,
};

const API_KEY_A = 'vcip_tenanta_FAKEKEYSECRETAAAAAAAAAAAAAAAAAAAA';
const API_KEY_B = 'vcip_tenantb_FAKEKEYSECRETBBBBBBBBBBBBBBBBBBBB';

class FakeApiKeyStore implements ApiKeyStore {
  private readonly byPrefix = new Map<string, ApiKeyRecord>([
    [
      'vcip_tenanta',
      {
        id: 'key-a',
        tenantId: TENANT_A,
        keyHash: hashApiKey(API_KEY_A),
        scopes: ['sessions:write'],
        expiresAt: null,
        revokedAt: null,
      },
    ],
    [
      'vcip_tenantb',
      {
        id: 'key-b',
        tenantId: TENANT_B,
        keyHash: hashApiKey(API_KEY_B),
        scopes: ['sessions:write'],
        expiresAt: null,
        revokedAt: null,
      },
    ],
  ]);

  findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    return Promise.resolve(this.byPrefix.get(prefix) ?? null);
  }
}

/** The schema defaults, per tenant, so a test can retune one tenant only. */
const defaultConfig = (tenantId: string): TenantConfig => ({
  tenantId,
  status: 'ACTIVE',
  minVideoPx: 480,
  minMicLevel: 10,
  maxRttMs: 300,
  minDownlinkKbps: 500,
  minLightingScore: 30,
  minStabilityScore: 30,
  gpsMaxAccuracyM: 100,
  offerTimeoutSeconds: 30,
});

class FakeTenantConfigStore implements TenantConfigStore {
  configs = new Map<string, TenantConfig>([
    [TENANT_A, defaultConfig(TENANT_A)],
    [TENANT_B, defaultConfig(TENANT_B)],
  ]);
  checklistTemplateId: string | null = 'template-1';

  findConfig(tenantId: string): Promise<TenantConfig | null> {
    return Promise.resolve(this.configs.get(tenantId) ?? null);
  }

  findActiveChecklistTemplateId(_tenantId: string): Promise<string | null> {
    return Promise.resolve(this.checklistTemplateId);
  }
}

class FakeGeoProvider implements GeoProvider {
  decision: GeoDecision = { country: null, allowed: true };
  seenIps: (string | null)[] = [];
  calls = 0;

  resolve(ip: string | null): Promise<GeoDecision> {
    this.calls += 1;
    this.seenIps.push(ip);
    return Promise.resolve(this.decision);
  }
}

interface StoredEvent {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly actorType: string;
  readonly payload: Record<string, unknown>;
}

/**
 * In-memory sessions, with the real guard semantics.
 *
 * `update` matches on id + tenant + status + version, exactly like the SQL
 * WHERE clause, and every operation yields to the event loop first so two
 * concurrent requests genuinely interleave. Without that gap a fake serialises
 * work that races in production and the concurrency assertions pass vacuously.
 */
class InMemorySessionRepository implements SessionRepository {
  readonly rows = new Map<string, SessionRow>();
  readonly events: StoredEvent[] = [];
  createCalls = 0;

  private hop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * T17's bounded candidate read.
   *
   * Unused by the customer routes this file exercises, but part of the port —
   * and it applies the same tenant and status predicates the SQL does, so the
   * fake cannot be more permissive than the thing it stands in for.
   */
  async findQueued(
    tenantId: string,
    sessionIds: readonly string[],
  ): Promise<readonly QueuedSessionRow[]> {
    await this.hop();
    const wanted = new Set(sessionIds);
    return [...this.rows.values()]
      .filter(
        (row) =>
          wanted.has(row.id) &&
          row.tenantId === tenantId &&
          row.status === SessionStatus.QUEUED &&
          row.queuedAt !== null,
      )
      .map((row) => ({
        id: row.id,
        language: row.language,
        priority: 0,
        queuedAt: row.queuedAt as Date,
      }));
  }

  async create(input: CreateSessionInput): Promise<SessionRow> {
    await this.hop();
    this.createCalls += 1;
    const now = new Date();
    const row: SessionRow = {
      id: input.id,
      tenantId: input.tenantId,
      externalRef: input.externalRef,
      status: SessionStatus.CREATED,
      version: 1,
      language: input.language,
      roomName: input.roomName,
      checklistTemplateId: input.checklistTemplateId,
      consentOk: false,
      consentVersion: null,
      consentAt: null,
      preflightOk: false,
      preflightAt: null,
      geoOk: false,
      gpsAccuracyM: null,
      geoCheckedAt: null,
      ipCountry: null,
      queuedAt: null,
      connectedAt: null,
      endedAt: null,
      verdict: null,
      exportStatus: 'NOT_STARTED',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    this.events.push({
      sessionId: row.id,
      tenantId: row.tenantId,
      type: input.event.type,
      actorType: input.event.actorType,
      payload: input.event.payload,
    });
    return row;
  }

  async findById(sessionId: string): Promise<SessionRow | null> {
    await this.hop();
    return this.rows.get(sessionId) ?? null;
  }

  async update(command: GuardedUpdate): Promise<SessionRow | null> {
    await this.hop();
    if (this.failNextUpdate) {
      // Zero rows affected — what the real guarded UPDATE returns when another
      // writer moved the session first. The transaction rolls back with it.
      this.failNextUpdate = false;
      return null;
    }
    const row = this.rows.get(command.sessionId);
    // The full WHERE clause. Dropping any one of these four is the mutation the
    // concurrency and tenant-isolation tests are meant to catch.
    if (
      row === undefined ||
      row.tenantId !== command.tenantId ||
      row.status !== command.expectedStatus ||
      row.version !== command.expectedVersion
    ) {
      return null;
    }

    const updated: SessionRow = {
      ...row,
      ...command.set,
      version: row.version + 1,
      updatedAt: new Date(),
    };
    this.rows.set(updated.id, updated);
    this.events.push({
      sessionId: updated.id,
      tenantId: command.tenantId,
      type: command.event.type,
      actorType: command.event.actorType,
      payload: command.event.payload,
    });
    return updated;
  }

  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('the customer lifecycle must not mint a media token');
  }

  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('the customer lifecycle must not read the claim projection');
  }

  accept(): Promise<SessionAcceptOutcome> {
    throw new Error('the customer lifecycle must not accept sessions');
  }

  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('the customer lifecycle must not sweep offers');
  }

  countActiveWork(): Promise<number> {
    throw new Error('the customer lifecycle must not count agent work');
  }

  claim(_command: ClaimCommand): Promise<SessionClaimOutcome> {
    // T18's agent claim. No customer route may reach it, and this suite covers
    // only customer routes — so a call here is a wiring defect, not a case to
    // emulate.
    throw new Error('the customer lifecycle must not claim sessions');
  }

  /** Test-only: make the next guarded update lose its race, as a concurrent
   *  writer would. */
  failNextUpdate = false;

  /** Test-only helper: force a session into a state a later task would create. */
  place(sessionId: string, patch: Partial<SessionRow>): void {
    const row = this.rows.get(sessionId);
    if (row === undefined) throw new Error('no such session');
    this.rows.set(sessionId, { ...row, ...patch });
  }

  eventsFor(sessionId: string): StoredEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}

/** In-memory Redis, atomic `SET NX`, as the T11 suite uses. */
class FakeRedis {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();

  private hop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(
    key: string,
    value: string,
    _ex: 'EX',
    seconds: number,
    nx?: 'NX',
  ): Promise<string | null> {
    await this.hop();
    if (nx === 'NX' && this.live(key) !== undefined) return null;
    this.data.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    await this.hop();
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    await this.hop();
    return this.data.delete(key) ? 1 : 0;
  }

  ttl(key: string): Promise<number> {
    const entry = this.live(key);
    return Promise.resolve(
      entry === undefined ? -2 : Math.ceil((entry.expiresAt - Date.now()) / 1000),
    );
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  // ------------------------------------------------------------ sorted sets
  //
  // Enough of the ZSET commands for the queue projection (T15), with the same
  // semantics the real server has: `ZADD` on an existing member updates its
  // score rather than duplicating it, and `ZRANK` and `ZRANGE` order by score
  // ascending with equal scores broken by lexical order of the member.

  private readonly zsets = new Map<string, Map<string, number>>();

  /** Set when a test wants ZADD to fail after the database has committed. */
  zaddFailure: Error | null = null;

  async zadd(key: string, score: number, member: string): Promise<number> {
    await this.hop();
    if (this.zaddFailure !== null) throw this.zaddFailure;
    const set = this.zsets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.zsets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zrank(key: string, member: string): Promise<number | null> {
    await this.hop();
    if (this.zaddFailure !== null) throw this.zaddFailure;
    const set = this.zsets.get(key);
    if (set === undefined || !set.has(member)) return null;
    const ordered = [...set.entries()].sort(
      (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    return ordered.findIndex(([id]) => id === member);
  }

  /**
   * `ZRANGE key 0 stop WITHSCORES`, as the position filter uses it.
   *
   * Flat `[member, score, member, score, …]`, which is the shape ioredis
   * returns and the shape the adapter parses — a fake returning pairs would
   * make the adapter's own parsing untested here.
   */
  async zrange(
    key: string,
    start: number,
    stop: string,
    withScores: 'WITHSCORES',
  ): Promise<string[]> {
    await this.hop();
    if (this.zaddFailure !== null) throw this.zaddFailure;
    void withScores;
    const ordered = this.zsetMembers(key).slice(start, Number(stop) + 1);
    return ordered.flatMap(({ member, score }) => [member, String(score)]);
  }

  /** Test-only: inspect a queue without going through the adapter. */
  zsetMembers(key: string): { member: string; score: number }[] {
    const set = this.zsets.get(key);
    if (set === undefined) return [];
    return [...set.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([member, score]) => ({ member, score }));
  }

  zsetKeys(): string[] {
    return [...this.zsets.keys()];
  }

  clearZsets(): void {
    this.zsets.clear();
  }
}

// ------------------------------------------------------------- application

const repository = new InMemorySessionRepository();
const tenantStore = new FakeTenantConfigStore();
const geo = new FakeGeoProvider();
const redis = new FakeRedis();

@Module({
  imports: [LoggingModule],
  controllers: [SessionsController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    { provide: API_KEY_STORE, useClass: FakeApiKeyStore },
    ApiKeyGuard,
    CustomerTokenGuard,
    AgentJwtGuard,
    TenantScope,
    TenantGuard,
    { provide: REDIS, useValue: redis },
    IdempotencyStore,
    IdempotencyInterceptor,
    { provide: TENANT_CONFIG_STORE, useValue: tenantStore },
    TenantsService,
    { provide: GEO_PROVIDER, useValue: geo },
    { provide: SESSION_REPOSITORY, useValue: repository },
    { provide: QUEUE_REPOSITORY, useClass: RedisQueueRepository },
    QueueService,
    SessionsService,
  ],
})
class TestSessionsModule {}

// -------------------------------------------------------------- fixtures

const GOOD_PREFLIGHT = {
  camera_width: 1280,
  camera_height: 720,
  microphone_level: 62.5,
  network_rtt_ms: 48,
  downlink_kbps: 4200,
  lighting_score: 71,
  stability_score: 88,
};

const GOOD_LOCATION = {
  latitude: 28.6139,
  longitude: 77.209,
  accuracy_m: 25,
  captured_at: '2026-08-27T10:30:00Z',
};

const customerTokenFor = (tenantId: string, sessionId: string, ttlSeconds = 7200): string =>
  signJwt(
    { act: CUSTOMER_ACTOR_CLAIM, tid: tenantId, sid: sessionId },
    { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds },
  );

const agentTokenFor = (tenantId: string): string =>
  signJwt(
    { act: AGENT_ACTOR_CLAIM, tid: tenantId, uid: 'user-1', role: 'AGENT' },
    { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
  );

const decodeClaims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

describe('session lifecycle over HTTP', () => {
  let app: INestApplication;
  let logged = '';
  let keyCounter = 0;

  const idem = (): string => `key-${(keyCounter += 1)}`;

  const createSession = async (
    apiKey = API_KEY_A,
    body: Record<string, unknown> = { external_ref: 'loan-12345', language: 'en' },
  ) =>
    request(app.getHttpServer())
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', idem())
      .send(body);

  beforeEach(async () => {
    repository.rows.clear();
    repository.events.length = 0;
    repository.createCalls = 0;
    repository.failNextUpdate = false;
    tenantStore.configs.set(TENANT_A, defaultConfig(TENANT_A));
    tenantStore.configs.set(TENANT_B, defaultConfig(TENANT_B));
    tenantStore.checklistTemplateId = 'template-1';
    geo.decision = { country: null, allowed: true };
    geo.seenIps = [];
    geo.calls = 0;
    for (const key of redis.keys()) await redis.del(key);
    redis.clearZsets();
    redis.zaddFailure = null;
    logged = '';

    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logged += String(chunk);
        callback();
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [TestSessionsModule] })
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

  // ------------------------------------------------------------- create

  describe('POST /v1/sessions', () => {
    it('creates a session with a valid enterprise API key', async () => {
      const response = await createSession();
      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe('CREATED');
      expect(response.body.data.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('rejects a request with no API key', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/sessions')
        .set('Idempotency-Key', idem())
        .send({ external_ref: 'r', language: 'en' });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('rejects a customer token on the creation route', async () => {
      // D14: only the enterprise creates sessions.
      const response = await request(app.getHttpServer())
        .post('/v1/sessions')
        .set('Authorization', `Bearer ${customerTokenFor(TENANT_A, 'any')}`)
        .set('Idempotency-Key', idem())
        .send({ external_ref: 'r', language: 'en' });
      expect(response.status).toBe(401);
    });

    it('takes the tenant from the authenticated key, not the request', async () => {
      const response = await createSession();
      const row = repository.rows.get(response.body.data.session_id);
      expect(row?.tenantId).toBe(TENANT_A);
    });

    it('refuses a client-supplied tenant_id that disagrees with the key', async () => {
      const response = await createSession(API_KEY_A, {
        external_ref: 'r',
        language: 'en',
        tenant_id: TENANT_B,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
      expect(repository.createCalls).toBe(0);
    });

    it('sets room_name to vcip_{session_id}', async () => {
      const response = await createSession();
      expect(response.body.data.room_name).toBe(`vcip_${response.body.data.session_id}`);
    });

    it('starts export_status at NOT_STARTED, independently of status', async () => {
      const response = await createSession();
      const row = repository.rows.get(response.body.data.session_id);
      expect(row?.status).toBe('CREATED');
      expect(row?.exportStatus).toBe('NOT_STARTED');
    });

    it('starts version at the schema default', async () => {
      const response = await createSession();
      expect(repository.rows.get(response.body.data.session_id)?.version).toBe(1);
    });

    it('pins the tenant active checklist template', async () => {
      const response = await createSession();
      expect(repository.rows.get(response.body.data.session_id)?.checklistTemplateId).toBe(
        'template-1',
      );
    });

    it('creates a session even when the tenant has no active template', async () => {
      tenantStore.checklistTemplateId = null;
      const response = await createSession();
      expect(response.status).toBe(201);
      expect(repository.rows.get(response.body.data.session_id)?.checklistTemplateId).toBeNull();
    });

    it('allows duplicate external_ref values (D15)', async () => {
      const first = await createSession(API_KEY_A, { external_ref: 'loan-1', language: 'en' });
      const second = await createSession(API_KEY_A, { external_ref: 'loan-1', language: 'en' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.session_id).not.toBe(first.body.data.session_id);
    });

    it('records a SESSION_CREATED event', async () => {
      const response = await createSession();
      const events = repository.eventsFor(response.body.data.session_id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('SESSION_CREATED');
      expect(events[0]?.actorType).toBe('ENTERPRISE');
    });

    it('keeps the enterprise reference out of the event payload', async () => {
      const response = await createSession(API_KEY_A, {
        external_ref: 'EXTREF-SENTINEL-88',
        language: 'en',
      });
      const payload = JSON.stringify(repository.eventsFor(response.body.data.session_id));
      expect(payload).not.toContain('EXTREF-SENTINEL-88');
    });

    it('rejects an invalid body with 400 VALIDATION_ERROR', async () => {
      const response = await createSession(API_KEY_A, { language: 'en' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(repository.createCalls).toBe(0);
    });

    it('requires an Idempotency-Key', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/sessions')
        .set('Authorization', `Bearer ${API_KEY_A}`)
        .send({ external_ref: 'r', language: 'en' });
      expect(response.status).toBe(400);
      expect(repository.createCalls).toBe(0);
    });

    it('returns the original response for a repeated Idempotency-Key', async () => {
      const key = idem();
      const send = () =>
        request(app.getHttpServer())
          .post('/v1/sessions')
          .set('Authorization', `Bearer ${API_KEY_A}`)
          .set('Idempotency-Key', key)
          .send({ external_ref: 'loan-1', language: 'en' });

      const first = await send();
      const second = await send();
      expect(second.body).toEqual(first.body);
      expect(repository.createCalls).toBe(1);
      expect(repository.rows.size).toBe(1);
    });

    it('does not share an idempotency record across tenants', async () => {
      const key = idem();
      const post = (apiKey: string) =>
        request(app.getHttpServer())
          .post('/v1/sessions')
          .set('Authorization', `Bearer ${apiKey}`)
          .set('Idempotency-Key', key)
          .send({ external_ref: 'loan-1', language: 'en' });

      const a = await post(API_KEY_A);
      const b = await post(API_KEY_B);
      expect(a.body.data.session_id).not.toBe(b.body.data.session_id);
      expect(repository.createCalls).toBe(2);
    });
  });

  // ------------------------------------------------------ customer token

  describe('customer token issuance', () => {
    it('issues a token bound to the tenant and the session', async () => {
      const response = await createSession();
      const claims = decodeClaims(response.body.data.customer_token);
      expect(claims['act']).toBe('customer');
      expect(claims['tid']).toBe(TENANT_A);
      expect(claims['sid']).toBe(response.body.data.session_id);
    });

    it('expires the token in exactly two hours (R8)', async () => {
      const response = await createSession();
      const claims = decodeClaims(response.body.data.customer_token);
      expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(2 * 60 * 60);
    });

    it('accepts the issued token on that session', async () => {
      const created = await createSession();
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${created.body.data.session_id}`)
        .set('Authorization', `Bearer ${created.body.data.customer_token}`);
      expect(response.status).toBe(200);
    });

    it('refuses the issued token on a different session', async () => {
      const a = await createSession();
      const b = await createSession();
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${b.body.data.session_id}`)
        .set('Authorization', `Bearer ${a.body.data.customer_token}`);
      expect(response.status).toBe(401);
    });

    it('refuses an expired token', async () => {
      const created = await createSession();
      const expired = signJwt(
        { act: CUSTOMER_ACTOR_CLAIM, tid: TENANT_A, sid: created.body.data.session_id },
        {
          secret: TEST_AUTH_CONFIG.customerTokenSecret,
          ttlSeconds: 60,
          issuedAt: Math.floor(Date.now() / 1000) - 3600,
        },
      );
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${created.body.data.session_id}`)
        .set('Authorization', `Bearer ${expired}`);
      expect(response.status).toBe(401);
    });
  });

  // ------------------------------------------------------------ consent

  describe('POST /v1/sessions/:id/consent', () => {
    const consent = async (
      sessionId: string,
      token: string,
      body: Record<string, unknown> = { accepted: true, consent_version: 'v1' },
    ) =>
      request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/consent`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('records an accepted consent', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await consent(id, created.body.data.customer_token);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        session_id: id,
        consent_ok: true,
        status: 'CREATED',
      });

      const row = repository.rows.get(id);
      expect(row?.consentOk).toBe(true);
      expect(row?.consentVersion).toBe('v1');
      expect(row?.consentAt).toBeInstanceOf(Date);
    });

    it('appends a CONSENT_ACCEPTED event', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      await consent(id, created.body.data.customer_token);
      expect(repository.eventsFor(id).map((e) => e.type)).toEqual([
        'SESSION_CREATED',
        'CONSENT_ACCEPTED',
      ]);
    });

    it('records a refusal without making the session queue-eligible', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await consent(id, created.body.data.customer_token, {
        accepted: false,
        consent_version: 'v1',
      });

      expect(response.status).toBe(200);
      expect(response.body.data.consent_ok).toBe(false);
      // Still CREATED, still unbilled (D19), and not queue-eligible.
      expect(response.body.data.status).toBe('CREATED');
      expect(repository.rows.get(id)?.consentOk).toBe(false);
      expect(repository.eventsFor(id).map((e) => e.type)).toContain('CONSENT_REJECTED');
    });

    it('requires a session token, not an API key', async () => {
      const created = await createSession();
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${created.body.data.session_id}/consent`)
        .set('Authorization', `Bearer ${API_KEY_A}`)
        .send({ accepted: true, consent_version: 'v1' });
      expect(response.status).toBe(401);
    });

    it('rejects a token scoped to another session', async () => {
      const a = await createSession();
      const b = await createSession();
      const response = await consent(b.body.data.session_id, a.body.data.customer_token);
      expect(response.status).toBe(401);
      expect(repository.rows.get(b.body.data.session_id)?.consentOk).toBe(false);
    });

    it('rejects a token from another tenant with a 404, not a 403', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      // A well-formed token for the right session id, but the wrong tenant.
      const response = await consent(id, customerTokenFor(TENANT_B, id));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('is deterministic when the identical consent is submitted twice', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;

      const first = await consent(id, token);
      const second = await consent(id, token);

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      // One event, not two: a retry must not double the audit trail.
      expect(repository.eventsFor(id).filter((e) => e.type === 'CONSENT_ACCEPTED')).toHaveLength(1);
    });

    it('refuses to contradict a consent already recorded', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;

      await consent(id, token, { accepted: true, consent_version: 'v1' });
      const response = await consent(id, token, { accepted: false, consent_version: 'v1' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
      expect(repository.rows.get(id)?.consentOk).toBe(true);
    });

    it('rejects consent once the session has left CREATED', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      repository.place(id, { status: SessionStatus.QUEUED });

      const response = await consent(id, created.body.data.customer_token);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    });

    it('rejects a non-boolean accepted', async () => {
      const created = await createSession();
      const response = await consent(
        created.body.data.session_id,
        created.body.data.customer_token,
        { accepted: 'true', consent_version: 'v1' },
      );
      expect(response.status).toBe(400);
    });

    it('rejects an empty consent_version', async () => {
      const created = await createSession();
      const response = await consent(
        created.body.data.session_id,
        created.body.data.customer_token,
        { accepted: true, consent_version: '' },
      );
      expect(response.status).toBe(400);
    });

    it('does not let the client set the status directly', async () => {
      const created = await createSession();
      const response = await consent(
        created.body.data.session_id,
        created.body.data.customer_token,
        { accepted: true, consent_version: 'v1', status: 'APPROVED' },
      );
      expect(response.status).toBe(400);
      expect(repository.rows.get(created.body.data.session_id)?.status).toBe('CREATED');
    });
  });

  // ---------------------------------------------------------- preflight

  describe('POST /v1/sessions/:id/preflight', () => {
    const preflight = async (
      sessionId: string,
      token: string,
      body: Record<string, unknown> = GOOD_PREFLIGHT,
    ) =>
      request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/preflight`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('passes good measurements and stays CREATED', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await preflight(id, created.body.data.customer_token);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        session_id: id,
        preflight_ok: true,
        status: 'CREATED',
      });
      const row = repository.rows.get(id);
      expect(row?.preflightOk).toBe(true);
      expect(row?.preflightAt).toBeInstanceOf(Date);
    });

    it('fails a sub-threshold measurement and transitions to PREFLIGHT_FAILED', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await preflight(id, created.body.data.customer_token, {
        ...GOOD_PREFLIGHT,
        downlink_kbps: 100,
        lighting_score: 5,
      });

      expect(response.status).toBe(200);
      expect(response.body.data.preflight_ok).toBe(false);
      expect(response.body.data.status).toBe('PREFLIGHT_FAILED');
      expect(response.body.data.failed_checks).toEqual(['downlink_kbps', 'lighting_score']);
      expect(repository.rows.get(id)?.status).toBe('PREFLIGHT_FAILED');
    });

    it('computes the verdict server-side, ignoring what the client claims', async () => {
      const created = await createSession();
      const response = await preflight(
        created.body.data.session_id,
        created.body.data.customer_token,
        { ...GOOD_PREFLIGHT, downlink_kbps: 1, preflight_ok: true },
      );
      // The claim is not merely ignored — the body is rejected outright.
      expect(response.status).toBe(400);
      expect(repository.rows.get(created.body.data.session_id)?.preflightOk).toBe(false);
    });

    it('applies this tenant thresholds, not another tenant', async () => {
      tenantStore.configs.set(TENANT_A, {
        ...defaultConfig(TENANT_A),
        minDownlinkKbps: 100_000,
      });
      const created = await createSession();
      const response = await preflight(
        created.body.data.session_id,
        created.body.data.customer_token,
      );
      expect(response.body.data.preflight_ok).toBe(false);
      expect(response.body.data.failed_checks).toEqual(['downlink_kbps']);
    });

    it('records the measurements and thresholds in the event payload', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      await preflight(id, created.body.data.customer_token);

      const event = repository.eventsFor(id).find((e) => e.type === 'PREFLIGHT_PASSED');
      expect(event?.payload['measurements']).toEqual(GOOD_PREFLIGHT);
      expect(event?.payload['thresholds']).toMatchObject({ min_downlink_kbps: 500 });
    });

    it('keeps credentials out of the event payload', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      await preflight(id, created.body.data.customer_token);

      const serialised = JSON.stringify(repository.eventsFor(id));
      expect(serialised).not.toContain(created.body.data.customer_token);
      expect(serialised).not.toContain(API_KEY_A);
      expect(serialised).not.toContain('Bearer');
      expect(serialised.toLowerCase()).not.toContain('authorization');
    });

    it('creates no billing row on failure (invariant I5)', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      await preflight(id, created.body.data.customer_token, {
        ...GOOD_PREFLIGHT,
        downlink_kbps: 1,
      });
      const row = repository.rows.get(id);
      // T12 writes no billing at all; these columns must remain untouched.
      expect(row).not.toHaveProperty('billCategory');
      expect(JSON.stringify(repository.eventsFor(id))).not.toContain('BILLING_CREATED');
    });

    it('leaves a PREFLIGHT_FAILED session unable to proceed', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;
      await preflight(id, token, { ...GOOD_PREFLIGHT, downlink_kbps: 1 });

      // Terminal: no further gate may be recorded, so it can never be queued.
      const again = await preflight(id, token);
      expect(again.status).toBe(409);
      const location = await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/location`)
        .set('Authorization', `Bearer ${token}`)
        .send(GOOD_LOCATION);
      expect(location.status).toBe(409);
      expect(repository.rows.get(id)?.status).toBe('PREFLIGHT_FAILED');
    });

    it('rejects a token scoped to another session', async () => {
      const a = await createSession();
      const b = await createSession();
      const response = await preflight(b.body.data.session_id, a.body.data.customer_token);
      expect(response.status).toBe(401);
    });

    it('rejects a measurement outside the documented range', async () => {
      const created = await createSession();
      const response = await preflight(
        created.body.data.session_id,
        created.body.data.customer_token,
        { ...GOOD_PREFLIGHT, lighting_score: 101 },
      );
      expect(response.status).toBe(400);
    });
  });

  // ----------------------------------------------------------- location

  describe('POST /v1/sessions/:id/location', () => {
    const location = async (
      sessionId: string,
      token: string,
      body: Record<string, unknown> = GOOD_LOCATION,
    ) =>
      request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/location`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('passes an accurate location and stays CREATED', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await location(id, created.body.data.customer_token);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ session_id: id, geo_ok: true, status: 'CREATED' });
      const row = repository.rows.get(id);
      expect(row?.geoOk).toBe(true);
      expect(row?.gpsAccuracyM).toBe(25);
      expect(row?.geoCheckedAt).toBeInstanceOf(Date);
    });

    it('enforces the tenant GPS accuracy threshold', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await location(id, created.body.data.customer_token, {
        ...GOOD_LOCATION,
        accuracy_m: 5000,
      });

      expect(response.body.data.geo_ok).toBe(false);
      expect(response.body.data.status).toBe('PREFLIGHT_FAILED');
      expect(response.body.data.failed_checks).toEqual(['gps_accuracy_m']);
      expect(repository.rows.get(id)?.status).toBe('PREFLIGHT_FAILED');
    });

    it('invokes the GeoProvider with the client address', async () => {
      const created = await createSession();
      await location(created.body.data.session_id, created.body.data.customer_token);
      expect(geo.calls).toBe(1);
      expect(geo.seenIps).toHaveLength(1);
      expect(typeof geo.seenIps[0]).toBe('string');
    });

    it('records a resolved country', async () => {
      geo.decision = { country: 'IN', allowed: true };
      const created = await createSession();
      const id = created.body.data.session_id;
      await location(id, created.body.data.customer_token);
      expect(repository.rows.get(id)?.ipCountry).toBe('IN');
    });

    it('passes when the country is unknown (R7)', async () => {
      geo.decision = { country: null, allowed: true };
      const created = await createSession();
      const response = await location(
        created.body.data.session_id,
        created.body.data.customer_token,
      );
      expect(response.body.data.geo_ok).toBe(true);
    });

    it('fails the location when the provider refuses the country', async () => {
      geo.decision = { country: 'XX', allowed: false };
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await location(id, created.body.data.customer_token);

      expect(response.body.data.geo_ok).toBe(false);
      expect(response.body.data.failed_checks).toEqual(['ip_country']);
      expect(repository.rows.get(id)?.status).toBe('PREFLIGHT_FAILED');
    });

    it('never persists raw coordinates', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      await location(id, created.body.data.customer_token);

      const row = JSON.stringify(repository.rows.get(id));
      expect(row).not.toContain('28.6139');
      expect(row).not.toContain('77.209');
      expect(row).not.toContain('latitude');
      expect(row).not.toContain('longitude');
    });

    it('never records coordinates or an IP in the event payload', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      await location(id, created.body.data.customer_token);

      const events = JSON.stringify(repository.eventsFor(id));
      expect(events).not.toContain('28.6139');
      expect(events).not.toContain('77.209');
      expect(events).not.toContain('latitude');
      expect(events).not.toContain('127.0.0.1');
      expect(events).not.toContain('::ffff:');
    });

    it('appends LOCATION_PASSED or LOCATION_FAILED', async () => {
      const passed = await createSession();
      await location(passed.body.data.session_id, passed.body.data.customer_token);
      expect(repository.eventsFor(passed.body.data.session_id).map((e) => e.type)).toContain(
        'LOCATION_PASSED',
      );

      const failed = await createSession();
      await location(failed.body.data.session_id, failed.body.data.customer_token, {
        ...GOOD_LOCATION,
        accuracy_m: 9000,
      });
      expect(repository.eventsFor(failed.body.data.session_id).map((e) => e.type)).toContain(
        'LOCATION_FAILED',
      );
    });

    it('refuses a client-asserted geo_ok', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await location(id, created.body.data.customer_token, {
        ...GOOD_LOCATION,
        accuracy_m: 9000,
        geo_ok: true,
      });
      expect(response.status).toBe(400);
      expect(repository.rows.get(id)?.geoOk).toBe(false);
    });

    it('rejects coordinates outside their valid ranges', async () => {
      const created = await createSession();
      const response = await location(
        created.body.data.session_id,
        created.body.data.customer_token,
        { ...GOOD_LOCATION, latitude: 120 },
      );
      expect(response.status).toBe(400);
    });

    it('leaves a location-failed session unbilled and unable to proceed', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;
      await location(id, token, { ...GOOD_LOCATION, accuracy_m: 9000 });

      expect(JSON.stringify(repository.eventsFor(id))).not.toContain('BILLING_CREATED');
      const retry = await location(id, token);
      expect(retry.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------- get

  describe('GET /v1/sessions/:id', () => {
    it('lets the owning customer read the session', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${id}`)
        .set('Authorization', `Bearer ${created.body.data.customer_token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.session_id).toBe(id);
      expect(response.body.data.status).toBe('CREATED');
      expect(response.body.data.room_name).toBe(`vcip_${id}`);
      expect(response.body.data.queue_position).toBeNull();
    });

    it('returns the current PostgreSQL state after each gate', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;

      await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/consent`)
        .set('Authorization', `Bearer ${token}`)
        .send({ accepted: true, consent_version: 'v1' });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/preflight`)
        .set('Authorization', `Bearer ${token}`)
        .send(GOOD_PREFLIGHT);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/location`)
        .set('Authorization', `Bearer ${token}`)
        .send(GOOD_LOCATION);

      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.body.data.consent_ok).toBe(true);
      expect(response.body.data.preflight_ok).toBe(true);
      expect(response.body.data.geo_ok).toBe(true);
      expect(response.body.data.export_status).toBe('NOT_STARTED');
    });

    it('lets an agent of the same tenant read the session', async () => {
      const created = await createSession();
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${created.body.data.session_id}`)
        .set('Authorization', `Bearer ${agentTokenFor(TENANT_A)}`);
      expect(response.status).toBe(200);
    });

    it('refuses an agent from another tenant with a 404', async () => {
      const created = await createSession();
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${created.body.data.session_id}`)
        .set('Authorization', `Bearer ${agentTokenFor(TENANT_B)}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses a customer token for a different session', async () => {
      const a = await createSession();
      const b = await createSession();
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${b.body.data.session_id}`)
        .set('Authorization', `Bearer ${a.body.data.customer_token}`);
      expect(response.status).toBe(401);
    });

    it('refuses an unauthenticated read', async () => {
      const created = await createSession();
      const response = await request(app.getHttpServer()).get(
        `/v1/sessions/${created.body.data.session_id}`,
      );
      expect(response.status).toBe(401);
    });

    it('answers a nonexistent session exactly as it answers another tenant', async () => {
      const missing = await request(app.getHttpServer())
        .get('/v1/sessions/99999999-9999-4999-8999-999999999999')
        .set('Authorization', `Bearer ${agentTokenFor(TENANT_A)}`);
      const created = await createSession();
      const foreign = await request(app.getHttpServer())
        .get(`/v1/sessions/${created.body.data.session_id}`)
        .set('Authorization', `Bearer ${agentTokenFor(TENANT_B)}`);

      expect(missing.status).toBe(foreign.status);
      expect(missing.body.error.code).toBe(foreign.body.error.code);
      expect(missing.body.error.message).toBe(foreign.body.error.message);
    });

    it('leaks no credential or location detail', async () => {
      geo.decision = { country: 'IN', allowed: true };
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;
      await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/location`)
        .set('Authorization', `Bearer ${token}`)
        .send(GOOD_LOCATION);

      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${id}`)
        .set('Authorization', `Bearer ${token}`);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain(API_KEY_A);
      expect(serialised).not.toContain(TENANT_A);
      expect(serialised).not.toContain('loan-12345');
      expect(serialised).not.toContain('28.6139');
      expect(serialised).not.toContain('gps');
    });
  });

  // -------------------------------------------------------------- abort

  describe('POST /v1/sessions/:id/queue', () => {
    const join = async (sessionId: string, token: string, key = idem()) =>
      request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/queue`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({});

    /** A session that has passed all three customer gates. */
    const eligible = async (language = 'en') => {
      const created = await createSession(API_KEY_A, {
        external_ref: 'loan-12345',
        language,
      });
      const id = created.body.data.session_id as string;
      repository.place(id, { consentOk: true, preflightOk: true, geoOk: true });
      return { id, token: created.body.data.customer_token as string };
    };

    const keyFor = (tenantId: string, language: string) => `queue:${tenantId}:${language}`;

    // ------------------------------------------------------ the transition

    it('takes an eligible CREATED session to QUEUED', async () => {
      const { id, token } = await eligible();
      const response = await join(id, token);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('QUEUED');
      expect(repository.rows.get(id)?.status).toBe('QUEUED');
    });

    it('assigns queued_at and increments version', async () => {
      const { id, token } = await eligible();
      const before = repository.rows.get(id)?.version ?? 0;
      await join(id, token);

      const row = repository.rows.get(id);
      expect(row?.queuedAt).toBeInstanceOf(Date);
      expect(row?.version).toBe(before + 1);
    });

    it('appends exactly one SESSION_QUEUED event', async () => {
      const { id, token } = await eligible();
      await join(id, token);

      const events = repository.eventsFor(id).filter((e) => e.type === 'SESSION_QUEUED');
      expect(events).toHaveLength(1);
      expect(events[0]?.actorType).toBe('CUSTOMER');
      expect(events[0]?.payload).toEqual({ language: 'en' });
    });

    it('refuses when consent has not passed', async () => {
      const { id, token } = await eligible();
      repository.place(id, { consentOk: false });
      const response = await join(id, token);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE);
      expect(repository.rows.get(id)?.status).toBe('CREATED');
    });

    it('refuses when preflight has not passed', async () => {
      const { id, token } = await eligible();
      repository.place(id, { preflightOk: false });
      const response = await join(id, token);
      expect(response.status).toBe(422);
      expect(repository.rows.get(id)?.status).toBe('CREATED');
    });

    it('refuses when location has not passed', async () => {
      const { id, token } = await eligible();
      repository.place(id, { geoOk: false });
      const response = await join(id, token);
      expect(response.status).toBe(422);
      expect(repository.rows.get(id)?.status).toBe('CREATED');
    });

    it('writes nothing to Redis when the transition is refused', async () => {
      const { id, token } = await eligible();
      repository.place(id, { geoOk: false });
      await join(id, token);
      expect(redis.zsetKeys()).toEqual([]);
    });

    it('refuses to re-queue an OFFERED session', async () => {
      // `OFFERED -> QUEUED` is a legal edge in the shared state machine — T20's
      // offer-expiry sweeper uses it — so `canTransition` alone would permit
      // this. The `CREATED` guard is what stops a *customer* driving it and
      // pulling their session back from the agent who just claimed it.
      const { id, token } = await eligible();
      repository.place(id, { status: SessionStatus.OFFERED });

      const response = await join(id, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
      expect(repository.rows.get(id)?.status).toBe('OFFERED');
      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_QUEUED')).toHaveLength(0);
      expect(redis.zsetKeys()).toEqual([]);
    });

    it('refuses to re-queue an IN_CALL session', async () => {
      const { id, token } = await eligible();
      repository.place(id, { status: SessionStatus.IN_CALL, connectedAt: new Date() });
      const response = await join(id, token);

      expect(response.status).toBe(409);
      expect(repository.rows.get(id)?.status).toBe('IN_CALL');
      expect(redis.zsetKeys()).toEqual([]);
    });

    it('writes nothing to Redis when the transaction rolls back', async () => {
      // The ordering test that matters, and the one a naive suite misses: the
      // gates pass, the status check passes, and then the guarded UPDATE loses
      // its race. Nothing committed, so nothing may be in the queue — a member
      // here would be claimable by an agent for a session that is still
      // `CREATED`.
      const { id, token } = await eligible();
      repository.failNextUpdate = true;

      const response = await join(id, token);

      expect(response.status).toBe(409);
      expect(repository.rows.get(id)?.status).toBe('CREATED');
      expect(repository.rows.get(id)?.queuedAt).toBeNull();
      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_QUEUED')).toHaveLength(0);
      expect(redis.zsetKeys()).toEqual([]);
    });

    it('refuses from a terminal state with 409, not 422', async () => {
      const { id, token } = await eligible();
      repository.place(id, { status: SessionStatus.PREFLIGHT_FAILED });
      const response = await join(id, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
      expect(redis.zsetKeys()).toEqual([]);
    });

    // --------------------------------------------------------- the queue

    it('adds the session to queue:{tenant}:{language} at its queued_at score', async () => {
      const { id, token } = await eligible();
      await join(id, token);

      const members = redis.zsetMembers(keyFor(TENANT_A, 'en'));
      expect(members).toHaveLength(1);
      expect(members[0]?.member).toBe(id);
      expect(members[0]?.score).toBe(repository.rows.get(id)?.queuedAt?.getTime());
    });

    it('reports position 1 for the first session and 2 for the second', async () => {
      const first = await eligible();
      const second = await eligible();

      const one = await join(first.id, first.token);
      const two = await join(second.id, second.token);

      expect(one.body.data.queue_position).toBe(1);
      expect(two.body.data.queue_position).toBe(2);
    });

    // ------------------------------------ positions and claimed sessions

    // The regression, at the level the customer experiences it. T18's claim
    // moves a session to OFFERED in PostgreSQL and deliberately leaves it in
    // the ZSET, so a raw ZRANK counts customers who have already been taken.
    // The number a waiting customer sees must come down as those ahead are
    // served, and before this fix it never did.

    /** Where this customer is told they are, over HTTP. */
    const positionOf = async (sessionId: string, token: string): Promise<number | null> => {
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${sessionId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      return response.body.data.queue_position as number | null;
    };

    /** Three customers in one queue, in the order they joined it. */
    const threeWaiting = async () => {
      const first = await eligible();
      const second = await eligible();
      const third = await eligible();
      for (const customer of [first, second, third]) await join(customer.id, customer.token);
      return { first, second, third };
    };

    it('does not count a customer an agent has already claimed', async () => {
      const { first, second, third } = await threeWaiting();
      expect(await positionOf(third.id, third.token)).toBe(3);

      // Exactly what a claim does: PostgreSQL moves on, Redis is left alone.
      repository.place(first.id, { status: SessionStatus.OFFERED });
      repository.place(second.id, { status: SessionStatus.IN_CALL });

      expect(await positionOf(third.id, third.token)).toBe(1);
    });

    it('counts down as the customers ahead are served', async () => {
      const { first, second, third } = await threeWaiting();

      expect(await positionOf(third.id, third.token)).toBe(3);
      repository.place(first.id, { status: SessionStatus.IN_CALL });
      expect(await positionOf(third.id, third.token)).toBe(2);
      repository.place(second.id, { status: SessionStatus.IN_CALL });
      expect(await positionOf(third.id, third.token)).toBe(1);
    });

    it('leaves every member in Redis while doing so', async () => {
      // T18's ruling: a claim does not ZREM, and neither does reading a
      // position. The queue stays a derived projection.
      const { first, third } = await threeWaiting();
      repository.place(first.id, { status: SessionStatus.OFFERED });

      await positionOf(third.id, third.token);

      expect(redis.zsetMembers(keyFor(TENANT_A, 'en'))).toHaveLength(3);
    });

    it('does not count a customer who abandoned the queue', async () => {
      const { first, third } = await threeWaiting();
      await request(app.getHttpServer())
        .post(`/v1/sessions/${first.id}/abort`)
        .set('Authorization', `Bearer ${first.token}`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(await positionOf(third.id, third.token)).toBe(2);
    });

    it('reports the position a new customer actually joins at', async () => {
      // The number in the queue response itself, not just on the poll after.
      const { first } = await threeWaiting();
      repository.place(first.id, { status: SessionStatus.IN_CALL });

      const late = await eligible();
      const response = await join(late.id, late.token);

      // Two still waiting ahead, not the three members Redis holds.
      expect(response.body.data.queue_position).toBe(3);
    });

    it('keeps another tenant queue out of this tenant position', async () => {
      // Separate keys, so a second tenant's customers cannot be ranked ahead in
      // the first place — and the confirmation binds the tenant from the
      // session row, so a foreign id could not be counted even if one appeared
      // (I8).
      const { third } = await threeWaiting();

      const other = await createSession(API_KEY_B, {
        external_ref: 'loan-99999',
        language: 'en',
      });
      const otherId = other.body.data.session_id as string;
      repository.place(otherId, { consentOk: true, preflightOk: true, geoOk: true });
      await join(otherId, other.body.data.customer_token as string);

      expect(redis.zsetMembers(keyFor(TENANT_B, 'en'))).toHaveLength(1);
      expect(await positionOf(third.id, third.token)).toBe(3);
    });

    it('keeps different languages in different queues', async () => {
      const en = await eligible('en');
      const hi = await eligible('hi');
      const enResponse = await join(en.id, en.token);
      const hiResponse = await join(hi.id, hi.token);

      // Each is first in its own queue, not first and second in a shared one.
      expect(enResponse.body.data.queue_position).toBe(1);
      expect(hiResponse.body.data.queue_position).toBe(1);
      expect(redis.zsetKeys().sort()).toEqual(
        [keyFor(TENANT_A, 'en'), keyFor(TENANT_A, 'hi')].sort(),
      );
    });

    it('scopes the queue key to the authenticated tenant', async () => {
      const { id, token } = await eligible();
      await join(id, token);
      expect(redis.zsetKeys()).toEqual([keyFor(TENANT_A, 'en')]);
      expect(redis.zsetKeys()[0]).not.toContain(TENANT_B);
    });

    // ------------------------------------------------- already queued (§7)

    it('answers an already-QUEUED session with 200, not 409', async () => {
      const { id, token } = await eligible();
      await join(id, token);
      // A fresh idempotency key: this is the retry that arrives after T11's
      // record has expired, not a replay.
      const again = await join(id, token, idem());

      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe('QUEUED');
    });

    it('does not append a second SESSION_QUEUED event', async () => {
      const { id, token } = await eligible();
      await join(id, token);
      await join(id, token, idem());

      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_QUEUED')).toHaveLength(1);
    });

    it('does not move queued_at', async () => {
      const { id, token } = await eligible();
      await join(id, token);
      const original = repository.rows.get(id)?.queuedAt;
      await join(id, token, idem());

      expect(repository.rows.get(id)?.queuedAt).toEqual(original);
    });

    it('does not bump version a second time', async () => {
      const { id, token } = await eligible();
      await join(id, token);
      const version = repository.rows.get(id)?.version;
      await join(id, token, idem());
      expect(repository.rows.get(id)?.version).toBe(version);
    });

    it('reconciles missing Redis membership on a repeat request', async () => {
      const { id, token } = await eligible();
      await join(id, token);
      // Simulate the member being lost after the commit.
      redis.clearZsets();
      expect(redis.zsetKeys()).toEqual([]);

      const again = await join(id, token, idem());

      expect(again.body.data.queue_position).toBe(1);
      expect(redis.zsetMembers(keyFor(TENANT_A, 'en'))[0]?.member).toBe(id);
    });

    // ---------------------------------------- redis failure after commit

    it('still returns 200 when the Redis enqueue fails', async () => {
      const { id, token } = await eligible();
      redis.zaddFailure = new Error('ECONNREFUSED');
      const response = await join(id, token);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('QUEUED');
    });

    it('reports queue_position null rather than a fabricated number', async () => {
      const { id, token } = await eligible();
      redis.zaddFailure = new Error('ECONNREFUSED');
      const response = await join(id, token);

      expect(response.body.data.queue_position).toBeNull();
      expect(response.body.data.queue_position).not.toBe(0);
    });

    it('leaves the session durably QUEUED in PostgreSQL', async () => {
      // The whole point: Redis cannot undo a committed business transition.
      const { id, token } = await eligible();
      redis.zaddFailure = new Error('ECONNREFUSED');
      await join(id, token);

      expect(repository.rows.get(id)?.status).toBe('QUEUED');
      expect(repository.rows.get(id)?.queuedAt).toBeInstanceOf(Date);
      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_QUEUED')).toHaveLength(1);
    });

    it('recovers the membership at the original score once Redis returns', async () => {
      const { id, token } = await eligible();
      redis.zaddFailure = new Error('ECONNREFUSED');
      await join(id, token);
      const queuedAt = repository.rows.get(id)?.queuedAt;

      redis.zaddFailure = null;
      const recovered = await request(app.getHttpServer())
        .get(`/v1/sessions/${id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(recovered.body.data.queue_position).toBe(1);
      expect(redis.zsetMembers(keyFor(TENANT_A, 'en'))[0]?.score).toBe(queuedAt?.getTime());
    });

    // -------------------------------------------------------- the route

    it('requires a customer token', async () => {
      const { id } = await eligible();
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/queue`)
        .set('Idempotency-Key', idem())
        .send({});
      expect(response.status).toBe(401);
    });

    it('rejects a token scoped to another session', async () => {
      const { id } = await eligible();
      const other = await eligible();
      const response = await join(id, other.token);
      expect(response.status).toBe(401);
    });

    it('rejects a token from another tenant with a 404', async () => {
      const { id } = await eligible();
      const response = await join(id, customerTokenFor(TENANT_B, id));
      expect(response.status).toBe(404);
    });

    it('requires an Idempotency-Key', async () => {
      const { id, token } = await eligible();
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/queue`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(response.status).toBe(400);
    });

    it('replays the original response for a repeated key', async () => {
      const { id, token } = await eligible();
      const key = idem();
      const first = await join(id, token, key);
      const second = await join(id, token, key);

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      // One transition, not two.
      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_QUEUED')).toHaveLength(1);
    });
  });

  describe('POST /v1/sessions/:id/abort', () => {
    const abort = async (sessionId: string, token: string, key = idem()) =>
      request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({});

    const queuedSession = async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      repository.place(id, { status: SessionStatus.QUEUED, queuedAt: new Date() });
      return { id, token: created.body.data.customer_token as string };
    };

    it('takes a QUEUED session to DROPPED_QUEUED', async () => {
      const { id, token } = await queuedSession();
      const response = await abort(id, token);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('DROPPED_QUEUED');
      expect(repository.rows.get(id)?.status).toBe('DROPPED_QUEUED');
      expect(repository.rows.get(id)?.endedAt).toBeInstanceOf(Date);
    });

    it('takes an OFFERED session to DROPPED_QUEUED (R15)', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      repository.place(id, { status: SessionStatus.OFFERED });
      const response = await abort(id, created.body.data.customer_token);
      expect(response.body.data.status).toBe('DROPPED_QUEUED');
    });

    it('takes an IN_CALL session to ABORTED (R4)', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      repository.place(id, { status: SessionStatus.IN_CALL, connectedAt: new Date() });
      const response = await abort(id, created.body.data.customer_token);
      expect(response.body.data.status).toBe('ABORTED');
      expect(repository.rows.get(id)?.status).toBe('ABORTED');
    });

    it('reports the server-derived amount without writing a billing row', async () => {
      const { id, token } = await queuedSession();
      const response = await abort(id, token);
      expect(response.body.data.bill_amount_paise).toBe(500);
      expect(response.body.data.bill_category).toBe('FAILED');
      expect(JSON.stringify(repository.eventsFor(id))).not.toContain('BILLING_CREATED');
    });

    it('ignores a client-supplied bill amount', async () => {
      const { id, token } = await queuedSession();
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({ bill_amount_paise: 1, bill_category: 'SUCCESS' });
      // The amount is derived, never read from the body.
      expect(response.body.data.bill_amount_paise).toBe(500);
      expect(response.body.data.bill_category).toBe('FAILED');
    });

    it('appends a SESSION_ABORTED event naming the transition', async () => {
      const { id, token } = await queuedSession();
      await abort(id, token);
      const event = repository.eventsFor(id).find((e) => e.type === 'SESSION_ABORTED');
      expect(event?.actorType).toBe('CUSTOMER');
      expect(event?.payload).toMatchObject({ from: 'QUEUED', to: 'DROPPED_QUEUED' });
    });

    it('refuses an abort from CREATED, which is unbilled and has nothing to end', async () => {
      const created = await createSession();
      const response = await abort(created.body.data.session_id, created.body.data.customer_token);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
      expect(repository.rows.get(created.body.data.session_id)?.status).toBe('CREATED');
    });

    it('refuses to overwrite a terminal status (invariant I11)', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      repository.place(id, { status: SessionStatus.APPROVED, verdict: 'APPROVED' });

      const response = await abort(id, created.body.data.customer_token);
      expect(response.status).toBe(409);
      expect(repository.rows.get(id)?.status).toBe('APPROVED');
      expect(repository.rows.get(id)?.verdict).toBe('APPROVED');
    });

    it('returns the original response for a repeated Idempotency-Key', async () => {
      const { id, token } = await queuedSession();
      const key = idem();
      const first = await abort(id, token, key);
      const second = await abort(id, token, key);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
    });

    it('returns 409 for a second abort under a fresh key', async () => {
      // Without a cached response the transition is genuinely retried, and the
      // guard refuses it. Both answers are correct; they differ because only
      // one of them is a replay.
      const { id, token } = await queuedSession();
      await abort(id, token);
      const second = await abort(id, token);
      expect(second.status).toBe(409);
    });

    it('rejects an abort by a customer holding another session token', async () => {
      const { id } = await queuedSession();
      const other = await createSession();
      const response = await abort(id, other.body.data.customer_token);
      expect(response.status).toBe(401);
      expect(repository.rows.get(id)?.status).toBe('QUEUED');
    });

    it('rejects an abort by another tenant', async () => {
      const { id } = await queuedSession();
      const response = await abort(id, customerTokenFor(TENANT_B, id));
      expect(response.status).toBe(404);
      expect(repository.rows.get(id)?.status).toBe('QUEUED');
    });

    it('requires an Idempotency-Key', async () => {
      const { id, token } = await queuedSession();
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(response.status).toBe(400);
      expect(repository.rows.get(id)?.status).toBe('QUEUED');
    });
  });

  // ------------------------------------------------------- guard shape

  describe('every mutation carries the full single-winner guard', () => {
    /**
     * The in-memory repository always bumps `version`, so its version check
     * happens to catch every race the status check would — which means a
     * dropped `expectedStatus` fails nothing above. The real SQL puts BOTH in
     * the WHERE clause, as D5 and D17 specify, and the status guard is the one
     * the decision record names.
     *
     * These assert what the service actually sends, so removing either field
     * from a command fails here even where the fake cannot tell the difference.
     */
    const commandFor = async (
      act: (id: string, token: string) => Promise<unknown>,
      place?: Partial<SessionRow>,
    ): Promise<GuardedUpdate> => {
      const created = await createSession();
      const id = created.body.data.session_id;
      if (place !== undefined) repository.place(id, place);
      const before = repository.rows.get(id) as SessionRow;

      const seen: GuardedUpdate[] = [];
      const original = repository.update.bind(repository);
      repository.update = (command: GuardedUpdate) => {
        seen.push(command);
        return original(command);
      };
      try {
        await act(id, created.body.data.customer_token);
      } finally {
        repository.update = original;
      }

      const command = seen[0];
      if (command === undefined) throw new Error('no guarded update was issued');
      expect(command.sessionId).toBe(id);
      // The tenant is in the guard itself, not merely checked beforehand.
      expect(command.tenantId).toBe(TENANT_A);
      expect(command.expectedStatus).toBe(before.status);
      expect(command.expectedVersion).toBe(before.version);
      return command;
    };

    it('consent guards on the observed status and version', async () => {
      await commandFor((id, token) =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${id}/consent`)
          .set('Authorization', `Bearer ${token}`)
          .send({ accepted: true, consent_version: 'v1' }),
      );
    });

    it('preflight guards on the observed status and version', async () => {
      await commandFor((id, token) =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${id}/preflight`)
          .set('Authorization', `Bearer ${token}`)
          .send(GOOD_PREFLIGHT),
      );
    });

    it('location guards on the observed status and version', async () => {
      await commandFor((id, token) =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${id}/location`)
          .set('Authorization', `Bearer ${token}`)
          .send(GOOD_LOCATION),
      );
    });

    it('abort guards on the observed status and version', async () => {
      const command = await commandFor(
        (id, token) =>
          request(app.getHttpServer())
            .post(`/v1/sessions/${id}/abort`)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', idem())
            .send({}),
        { status: SessionStatus.IN_CALL },
      );
      expect(command.expectedStatus).toBe('IN_CALL');
      expect(command.set.status).toBe('ABORTED');
    });

    it('never lets a mutation touch a column T12 does not own', async () => {
      const command = await commandFor(
        (id, token) =>
          request(app.getHttpServer())
            .post(`/v1/sessions/${id}/abort`)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', idem())
            .send({ verdict: 'APPROVED', bill_amount_paise: 999, agent_id: 'someone' }),
        { status: SessionStatus.IN_CALL },
      );
      const written = Object.keys(command.set);
      for (const forbidden of [
        'verdict',
        'agentId',
        'billCategory',
        'billAmountPaise',
        'exportStatus',
        'queuedAt',
        'connectedAt',
        'version',
      ]) {
        expect(written).not.toContain(forbidden);
      }
    });
  });

  // -------------------------------------------------------- concurrency

  describe('concurrent mutations cannot bypass the state guards', () => {
    it('commits exactly one of two simultaneous aborts', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;
      repository.place(id, { status: SessionStatus.IN_CALL });

      // Distinct keys, so idempotency replay cannot be what makes this pass —
      // the state guard has to.
      const [a, b] = await Promise.all([
        abortWith(id, token, idem()),
        abortWith(id, token, idem()),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(repository.rows.get(id)?.status).toBe('ABORTED');
      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_ABORTED')).toHaveLength(1);
    });

    it('commits exactly one of many simultaneous aborts', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;
      repository.place(id, { status: SessionStatus.QUEUED });

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => abortWith(id, token, idem())),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
      expect(repository.eventsFor(id).filter((e) => e.type === 'SESSION_ABORTED')).toHaveLength(1);
    });

    it('records one consent when two identical requests race', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;

      const consentOnce = () =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${id}/consent`)
          .set('Authorization', `Bearer ${token}`)
          .send({ accepted: true, consent_version: 'v1' });

      const [a, b] = await Promise.all([consentOnce(), consentOnce()]);
      // One wins outright; the other either loses the guard (409) or observes
      // the completed write and returns the same answer (200). Never two events.
      expect([a.status, b.status]).toContain(200);
      expect(repository.eventsFor(id).filter((e) => e.type === 'CONSENT_ACCEPTED')).toHaveLength(1);
    });

    it('lets only one of a racing preflight and location commit', async () => {
      const created = await createSession();
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;

      const [preflight, location] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/sessions/${id}/preflight`)
          .set('Authorization', `Bearer ${token}`)
          .send(GOOD_PREFLIGHT),
        request(app.getHttpServer())
          .post(`/v1/sessions/${id}/location`)
          .set('Authorization', `Bearer ${token}`)
          .send(GOOD_LOCATION),
      ]);

      const statuses = [preflight.status, location.status].sort();
      expect(statuses).toEqual([200, 409]);
      // The version guard means the loser wrote nothing at all.
      expect(repository.rows.get(id)?.version).toBe(2);
    });

    function abortWith(id: string, token: string, key: string) {
      return request(app.getHttpServer())
        .post(`/v1/sessions/${id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({});
    }
  });

  // ------------------------------------------------------------ logging

  describe('logs carry no secrets and no coordinates', () => {
    it('records the lifecycle without credentials, coordinates, or references', async () => {
      const created = await createSession(API_KEY_A, {
        external_ref: 'EXTREF-SENTINEL-77',
        language: 'en',
      });
      const id = created.body.data.session_id;
      const token = created.body.data.customer_token;

      await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/location`)
        .set('Authorization', `Bearer ${token}`)
        .send(GOOD_LOCATION);
      // Provoke an error line too, so the failure path is covered.
      await request(app.getHttpServer())
        .post(`/v1/sessions/${id}/consent`)
        .set('Authorization', `Bearer ${token}`)
        .send({ accepted: 'nonsense', consent_version: 'v1' });

      expect(logged).not.toContain(API_KEY_A);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(TEST_AUTH_CONFIG.customerTokenSecret);
      expect(logged).not.toContain('28.6139');
      expect(logged).not.toContain('77.209');
      expect(logged).not.toContain('EXTREF-SENTINEL-77');
      expect(logged).not.toContain('latitude');
    });

    it('returns a request id on an error response', async () => {
      const created = await createSession();
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${created.body.data.session_id}/abort`)
        .set('Authorization', `Bearer ${created.body.data.customer_token}`)
        .set('Idempotency-Key', idem())
        .send({});
      expect(response.status).toBe(409);
      expect(typeof response.body.error.request_id).toBe('string');
      expect(response.body.error.request_id.length).toBeGreaterThan(0);
    });
  });
});
