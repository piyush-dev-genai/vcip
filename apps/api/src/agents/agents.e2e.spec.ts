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
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor.js';
import { IdempotencyStore } from '../common/idempotency/idempotency.store.js';
import { REDIS } from '../common/redis/redis.tokens.js';
import type { TenantConfig, TenantConfigStore } from '../tenants/tenant-config.store.js';
import { TENANT_CONFIG_STORE } from '../tenants/tenant-config.store.js';
import { TenantsService } from '../tenants/tenants.service.js';
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
  AcceptCommand,
  ClaimableSessionRow,
  AgentWorkRow,
  CallSessionRow,
  EndedCallRow,
  MediaTokenSessionRow,
  ClaimCommand,
  ExpireOffersCommand,
  ExpiredOfferRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  GuardedUpdate,
  QueuedSessionRow,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import { SESSION_REPOSITORY } from '../sessions/session.repository.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { AGENT_REPOSITORY } from './agent.repository.js';
import { AgentAcceptService } from './agent-accept.service.js';
import { AgentClaimService } from './agent-claim.service.js';
import { AgentQueueService } from './agent-queue.service.js';
import { AgentWorkService } from './agent-work.service.js';
import { NOTIFICATIONS } from '../realtime/notifications.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { OfferSweeperController } from './offer-sweeper.controller.js';
import { OfferSweeper } from './offer-sweeper.service.js';
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
  wsTokenSecret: 'FAKE-ws-secret-for-tests-abcdefghijklmnop',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
  wsTokenTtlSeconds: 300,
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
  connectedAt?: Date | null;
  /** Set by a claim (T18). Absent until one succeeds. */
  offeredToAgentId?: string | null;
  offeredAt?: Date | null;
  offerExpiresAt?: Date | null;
  /** Set by an accept (T19). Present here only so capacity can be counted. */
  agentId?: string | null;
}

/**
 * Widen a stored row into the shape `findById` returns.
 *
 * The claim path reads four of these fields — id, tenant, status, language —
 * and the rest exist because `SessionRow` is what the port promises. Filling
 * them with nulls rather than plausible values keeps a test from accidentally
 * asserting against fiction.
 */
const asSessionRow = (row: StoredSession): SessionRow => ({
  id: row.id,
  tenantId: row.tenantId,
  externalRef: `ref-${row.id}`,
  status: row.status,
  version: row.version,
  language: row.language,
  roomName: null,
  checklistTemplateId: null,
  consentOk: true,
  consentVersion: 'v1',
  consentAt: row.queuedAt,
  preflightOk: true,
  preflightAt: row.queuedAt,
  geoOk: true,
  gpsAccuracyM: 20,
  geoCheckedAt: row.queuedAt,
  ipCountry: 'IN',
  queuedAt: row.queuedAt,
  connectedAt: null,
  endedAt: null,
  verdict: null,
  exportStatus: 'NOT_STARTED',
  createdAt: row.queuedAt,
  updatedAt: row.queuedAt,
});

/**
 * The session store, with counters.
 *
 * `writes` is what proves T17's read-only invariant over HTTP: the mutating
 * methods increment it, so a queue view that touched a session fails loudly
 * rather than passing quietly. `singleReads` does the same for the other half
 * of that invariant — the queue view reads the whole candidate set in one
 * statement, never a row at a time — now that T18 needs `findById` to work
 * rather than throw.
 *
 * `claim` reproduces the real statement's guards rather than merely succeeding:
 * the tenant predicate, `status = 'QUEUED'`, and the capacity count are all
 * here, because dropping any one of them is exactly the mutation the claim
 * tests exist to catch.
 */
class FakeSessionStore implements SessionRepository {
  readonly rows = new Map<string, StoredSession>();
  writes = 0;
  singleReads = 0;
  /** Test-only: make the next claim lose, as a concurrent winner would. */
  loseNextClaim = false;
  /** Test-only: the commands `claim` was called with. */
  readonly claims: ClaimCommand[] = [];

  clear(): void {
    this.rows.clear();
    this.writes = 0;
    this.singleReads = 0;
    this.loseNextClaim = false;
    this.claims.length = 0;
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
    throw new Error('neither the queue view nor a claim may create a session');
  }

  update(_command: GuardedUpdate): Promise<SessionRow | null> {
    this.writes += 1;
    throw new Error('a claim goes through claim(), not the customer guarded update');
  }

  findById(sessionId: string): Promise<SessionRow | null> {
    this.singleReads += 1;
    const row = this.rows.get(sessionId);
    return Promise.resolve(row === undefined ? null : asSessionRow(row));
  }

  /**
   * The same predicate the real query uses: offered to this agent, or in call
   * with them, within their tenant. Reproduced rather than stubbed because the
   * work route is exercised over HTTP here, and a stub would test nothing.
   */
  findForCallEvent(): Promise<CallSessionRow | null> {
    throw new Error('no agent route drives call lifecycle; T26 has its own controller');
  }

  appendCallEvent(): Promise<boolean> {
    throw new Error('no agent route drives call lifecycle; T26 has its own controller');
  }

  hasEvent(): Promise<boolean> {
    throw new Error('no agent route drives call lifecycle; T26 has its own controller');
  }

  endCall(): Promise<EndedCallRow | null> {
    throw new Error('no agent route drives call lifecycle; T26 has its own controller');
  }

  findActiveWork(tenantId: string, agentId: string): Promise<readonly AgentWorkRow[]> {
    this.singleReads += 1;
    const held = [...this.rows.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        ((row.status === SessionStatus.OFFERED && row.offeredToAgentId === agentId) ||
          (row.status === SessionStatus.IN_CALL && row.agentId === agentId)),
    );
    return Promise.resolve(
      held.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        status: row.status,
        roomName: `vcip_${row.id}`,
        offerExpiresAt: row.offerExpiresAt ?? null,
        heldSince: row.connectedAt ?? row.offeredAt ?? row.queuedAt,
      })),
    );
  }

  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('no agent route mints a media token; T24 has its own controller');
  }

  findClaimable(tenantId: string, sessionId: string): Promise<ClaimableSessionRow | null> {
    this.singleReads += 1;
    const row = this.rows.get(sessionId);
    // The tenant predicate is in the real query's WHERE clause, so a foreign
    // id yields nothing here too.
    if (row === undefined || row.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      tenantId: row.tenantId,
      status: row.status,
      language: row.language,
      offeredToAgentId: row.offeredToAgentId ?? null,
      offeredAt: row.offeredAt ?? null,
      offerExpiresAt: row.offerExpiresAt ?? null,
    });
  }

  accept(command: AcceptCommand): Promise<SessionAcceptOutcome> {
    this.writes += 1;
    const row = this.rows.get(command.sessionId);
    // Every predicate the real statement applies: tenant, status, whose offer
    // it is, and whether it has lapsed.
    if (
      row === undefined ||
      row.tenantId !== command.tenantId ||
      row.status !== SessionStatus.OFFERED ||
      row.offeredToAgentId !== command.agentId ||
      row.offerExpiresAt === undefined ||
      row.offerExpiresAt === null ||
      row.offerExpiresAt.getTime() <= command.now.getTime()
    ) {
      return Promise.resolve({ kind: 'LOST' });
    }

    const accepted: StoredSession = {
      ...row,
      status: SessionStatus.IN_CALL,
      agentId: command.agentId,
      connectedAt: command.now,
      version: row.version + 1,
    };
    this.rows.set(accepted.id, accepted);

    return Promise.resolve({
      kind: 'ACCEPTED',
      session: {
        id: accepted.id,
        status: accepted.status,
        agentId: command.agentId,
        connectedAt: command.now,
        roomName: `vcip_${accepted.id}`,
        version: accepted.version,
      },
    });
  }

  countActiveWork(tenantId: string, agentId: string): Promise<number> {
    this.singleReads += 1;
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          ((row.status === SessionStatus.OFFERED && row.offeredToAgentId === agentId) ||
            (row.status === SessionStatus.IN_CALL && row.agentId === agentId)),
      ).length,
    );
  }

  expireOffers(command: ExpireOffersCommand): Promise<readonly ExpiredOfferRow[]> {
    this.writes += 1;
    const due = [...this.rows.values()]
      .filter(
        (row) =>
          row.status === SessionStatus.OFFERED &&
          row.offerExpiresAt !== undefined &&
          row.offerExpiresAt !== null &&
          row.offerExpiresAt.getTime() <= command.now.getTime(),
      )
      .slice(0, command.limit);

    const swept = due.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      agentId: row.offeredToAgentId ?? null,
    }));

    for (const row of due) {
      this.rows.set(row.id, {
        ...row,
        status: SessionStatus.QUEUED,
        offeredToAgentId: null,
        offeredAt: null,
        offerExpiresAt: null,
        version: row.version + 1,
      });
    }
    return Promise.resolve(swept);
  }

  claim(command: ClaimCommand): Promise<SessionClaimOutcome> {
    this.writes += 1;
    this.claims.push(command);

    const active = [...this.rows.values()].filter(
      (row) =>
        row.tenantId === command.tenantId &&
        ((row.status === SessionStatus.OFFERED && row.offeredToAgentId === command.agentId) ||
          (row.status === SessionStatus.IN_CALL && row.agentId === command.agentId)),
    ).length;
    if (active >= command.maxConcurrent) {
      return Promise.resolve({ kind: 'AT_CAPACITY', active });
    }

    const row = this.rows.get(command.sessionId);
    if (
      this.loseNextClaim ||
      row === undefined ||
      row.tenantId !== command.tenantId ||
      row.status !== SessionStatus.QUEUED
    ) {
      this.loseNextClaim = false;
      return Promise.resolve({ kind: 'LOST' });
    }

    const claimed: StoredSession = {
      ...row,
      status: SessionStatus.OFFERED,
      offeredToAgentId: command.agentId,
      offeredAt: command.offeredAt,
      offerExpiresAt: command.offerExpiresAt,
      version: row.version + 1,
    };
    this.rows.set(claimed.id, claimed);

    return Promise.resolve({
      kind: 'CLAIMED',
      session: {
        id: claimed.id,
        status: claimed.status,
        offeredToAgentId: command.agentId,
        offeredAt: command.offeredAt,
        offerExpiresAt: command.offerExpiresAt,
        version: claimed.version,
      },
    });
  }
}

/**
 * Enough Redis for D13's idempotency records.
 *
 * `SET NX` and the TTL are the two semantics the store actually depends on, so
 * they are real here; nothing else is needed, because the queue and presence
 * projections in this suite go through their own fakes.
 */
class FakeRedis {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  clear(): void {
    this.data.clear();
  }

  set(key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX'): Promise<string | null> {
    if (nx === 'NX' && this.live(key) !== undefined) return Promise.resolve(null);
    this.data.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.data.delete(key) ? 1 : 0);
  }

  ttl(key: string): Promise<number> {
    const entry = this.live(key);
    return Promise.resolve(
      entry === undefined ? -2 : Math.ceil((entry.expiresAt - Date.now()) / 1000),
    );
  }
}

/** Only the field the claim needs; the preflight thresholds are T12's suite. */
class FakeTenantConfigStore implements TenantConfigStore {
  offerTimeoutSeconds = 30;

  findConfig(tenantId: string): Promise<TenantConfig | null> {
    if (tenantId !== TENANT_A && tenantId !== TENANT_B) return Promise.resolve(null);
    return Promise.resolve({
      tenantId,
      status: 'ACTIVE',
      minVideoPx: 480,
      minMicLevel: 10,
      maxRttMs: 300,
      minDownlinkKbps: 500,
      minLightingScore: 30,
      minStabilityScore: 30,
      gpsMaxAccuracyM: 100,
      offerTimeoutSeconds: this.offerTimeoutSeconds,
      agentReconnectTimeoutSeconds: 60,
    });
  }

  findActiveChecklistTemplateId(): Promise<string | null> {
    return Promise.resolve(null);
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
const notifications = new RecordingNotifications();
const idempotencyRedis = new FakeRedis();
const tenantStore = new FakeTenantConfigStore();

@Module({
  imports: [LoggingModule],
  controllers: [AgentsController, OfferSweeperController],
  providers: [
    { provide: NOTIFICATIONS, useValue: notifications },
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
        new PresenceService(presence, agents, sessionStore, logger, () => new Date(clockMs)),
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
    {
      provide: AgentWorkService,
      useFactory: (sessions: SessionRepository) => new AgentWorkService(sessions),
      inject: [SESSION_REPOSITORY],
    },
    { provide: REDIS, useValue: idempotencyRedis },
    IdempotencyStore,
    IdempotencyInterceptor,
    { provide: TENANT_CONFIG_STORE, useValue: tenantStore },
    TenantsService,
    {
      provide: AgentAcceptService,
      useFactory: (
        sessions: SessionRepository,
        presence: PresenceService,
        scope: TenantScope,
        logger,
      ) =>
        new AgentAcceptService(
          sessions,
          presence,
          scope,
          notifications,
          logger,
          () => new Date(clockMs),
        ),
      inject: [SESSION_REPOSITORY, PresenceService, TenantScope, LOGGER],
    },
    {
      // The timer stays off: this suite triggers sweeps explicitly, so no pass
      // can fire between cases and change a fixture out from under an assertion.
      provide: OfferSweeper,
      useFactory: (sessions: SessionRepository, presence: PresenceService, logger) =>
        new OfferSweeper(sessions, presence, notifications, logger, false, () => new Date(clockMs)),
      inject: [SESSION_REPOSITORY, PresenceService, LOGGER],
    },
    {
      provide: AgentClaimService,
      useFactory: (
        sessions: SessionRepository,
        agents: AgentRepository,
        presence: PresenceService,
        tenants: TenantsService,
        scope: TenantScope,
        logger,
      ) =>
        new AgentClaimService(
          sessions,
          agents,
          presence,
          tenants,
          scope,
          notifications,
          logger,
          () => new Date(clockMs),
        ),
      inject: [
        SESSION_REPOSITORY,
        AGENT_REPOSITORY,
        PresenceService,
        TenantsService,
        TenantScope,
        LOGGER,
      ],
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
    notifications.clear();
    idempotencyRedis.clear();
    tenantStore.offerTimeoutSeconds = 30;
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
      // create, update, and claim all increment this.
      expect(sessionStore.writes).toBe(0);
      // And the whole candidate set is confirmed in one statement, never a row
      // at a time — `findById` is the claim path's read, not the queue view's.
      expect(sessionStore.singleReads).toBe(0);
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

  // ------------------------------------------------------------- claim

  describe('POST /v1/agent/sessions/:id/claim', () => {
    const SESSION_EN = '00000000-0000-4000-8000-00000000e001';
    const SESSION_TA = '00000000-0000-4000-8000-00000000e002';
    const SESSION_OTHER = '00000000-0000-4000-8000-00000000e003';
    const QUEUED_AT = Date.parse('2026-08-31T08:59:28.000Z');

    let keySeq = 0;
    const idem = (): string => `claim-key-${(keySeq += 1)}`;

    const claim = (id: string, token: string, key = idem()) =>
      post(`/sessions/${id}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({});

    /** A session that is queued in PostgreSQL and present in Redis. */
    const enqueue = (id: string, over: Partial<StoredSession> = {}): void => {
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
    };

    /** Log in and go AVAILABLE, which is what the claim requires. */
    const availableAgent = async (email = 'agent.one@demo.local'): Promise<string> => {
      const token = await loginAs(email);
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      return token;
    };

    // --- the happy path ----------------------------------------------------

    it('moves a queued session to OFFERED', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(SessionStatus.OFFERED);
      expect(response.body.data.session_id).toBe(SESSION_EN);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.OFFERED);
    });

    it('returns exactly the four contract fields', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(Object.keys(response.body)).toEqual(['data']);
      expect(Object.keys(response.body.data).sort()).toEqual([
        'offer_expires_at',
        'offered_to_agent_id',
        'session_id',
        'status',
      ]);
    });

    it('offers the session to the agent in the token, not to anyone named', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.body.data.offered_to_agent_id).toBe(AGENT_A1);
      expect(sessionStore.claims[0]?.agentId).toBe(AGENT_A1);
      expect(sessionStore.claims[0]?.tenantId).toBe(TENANT_A);
    });

    it('derives the expiry from the tenant offer timeout', async () => {
      tenantStore.offerTimeoutSeconds = 45;
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      // The clock is frozen at 09:00:00.
      expect(response.body.data.offer_expires_at).toBe('2026-08-31T09:00:45.000Z');
    });

    it('marks the agent BUSY', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      await claim(SESSION_EN, token);

      const presence = await presenceStore.read(AGENT_A1);
      expect(presence?.status).toBe(AgentPresence.BUSY);
    });

    it('takes the claimed session out of the agent queue view', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      await claim(SESSION_EN, token);
      const view = await request(app.getHttpServer())
        .get('/v1/agent/queue')
        .set('Authorization', `Bearer ${token}`);

      // Not because Redis changed — because PostgreSQL no longer says QUEUED.
      expect(view.body.data.sessions).toHaveLength(0);
    });

    it('leaves the Redis queue member and its score untouched', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      const snapshot = (): string =>
        JSON.stringify([...queueStore.sets].map(([k, v]) => [k, [...v.entries()].sort()]));
      const before = snapshot();

      await claim(SESSION_EN, token);

      // T20 needs the original score to put an expired offer back in place.
      expect(snapshot()).toBe(before);
    });

    // --- who may claim -----------------------------------------------------

    it('rejects a request with no credential', async () => {
      enqueue(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(401);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.QUEUED);
    });

    it('rejects a customer token', async () => {
      enqueue(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${customerToken(TENANT_A, SESSION_EN)}`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(401);
    });

    it('rejects an enterprise API key', async () => {
      enqueue(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${API_KEY_A}`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(401);
    });

    it('rejects a query string naming another tenant', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await post(`/sessions/${SESSION_EN}/claim?tenant_id=${TENANT_B}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(403);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.QUEUED);
    });

    it('rejects a body trying to name an agent', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({ agent_id: AGENT_A2 });

      // Structural, not ignored: the schema is an empty strictObject.
      expect(response.status).toBe(400);
      expect(sessionStore.claims).toHaveLength(0);
    });

    it('rejects a body trying to set the offer expiry', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({ offer_expires_at: '2099-01-01T00:00:00.000Z' });

      expect(response.status).toBe(400);
    });

    it('rejects a session id that is not a uuid', async () => {
      const token = await availableAgent();

      const response = await post('/sessions/not-a-uuid/claim')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(400);
    });

    it('refuses a user who is not an agent', async () => {
      enqueue(SESSION_EN);
      // The admin cannot log in at all, so mint the token directly: this
      // asserts the profile gate rather than relying on the login gate.
      const token = signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: TENANT_A, uid: 'admin-a', role: 'TENANT_ADMIN' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
      );

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(403);
      expect(sessionStore.claims).toHaveLength(0);
    });

    // --- idempotency -------------------------------------------------------

    it('requires an Idempotency-Key', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.QUEUED);
    });

    it('returns the original response for a repeated key', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      const key = 'claim-replay-key';

      const first = await claim(SESSION_EN, token, key);
      const second = await claim(SESSION_EN, token, key);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      // The replay did not run the handler again, so it did not lose a race
      // against the agent's own first claim.
      expect(sessionStore.claims).toHaveLength(1);
    });

    // --- the session -------------------------------------------------------

    it('is a 404 for a session that does not exist', async () => {
      const token = await availableAgent();

      const response = await claim(SESSION_OTHER, token);

      expect(response.status).toBe(404);
    });

    it('is the same 404 for another tenant session', async () => {
      sessionStore.seed({
        id: SESSION_OTHER,
        tenantId: TENANT_B,
        status: SessionStatus.QUEUED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(QUEUED_AT),
        version: 2,
      });
      const token = await availableAgent();

      const response = await claim(SESSION_OTHER, token);

      // Indistinguishable from "no such session": a claim must not confirm
      // that another tenant holds an id (I8).
      expect(response.status).toBe(404);
      expect(sessionStore.claims).toHaveLength(0);
      expect(sessionStore.rows.get(SESSION_OTHER)?.status).toBe(SessionStatus.QUEUED);
    });

    it('is a 409 when another agent already holds the offer', async () => {
      enqueue(SESSION_EN, { status: SessionStatus.OFFERED, offeredToAgentId: AGENT_A2 });
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
    });

    it('returns the offer to the agent already holding it', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const first = await claim(SESSION_EN, token);
      // A different key: not an idempotency replay, a genuine second request.
      const again = await claim(SESSION_EN, token);

      expect(first.status).toBe(200);
      expect(again.status).toBe(200);
      expect(again.body.data.offered_to_agent_id).toBe(AGENT_A1);
      expect(again.body.data.offer_expires_at).toBe(first.body.data.offer_expires_at);
    });

    it('does not report an agent own offer as taken by someone else', async () => {
      enqueue(SESSION_EN, { status: SessionStatus.OFFERED, offeredToAgentId: AGENT_A1 });
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).not.toBe(409);
      expect(JSON.stringify(response.body)).not.toContain('another agent');
    });

    it('conflicts when the same key is reused for a different session', async () => {
      enqueue(SESSION_EN);
      enqueue(SESSION_TA, { language: 'hi' });
      const token = await availableAgent();
      const key = 'one-key-two-sessions';

      const first = await claim(SESSION_EN, token, key);
      const second = await claim(SESSION_TA, token, key);

      expect(first.status).toBe(200);
      // Not a 200 replaying SESSION_EN's body, which is what this used to be.
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe(ErrorCode.CONFLICT);
      expect(sessionStore.rows.get(SESSION_TA)?.status).toBe(SessionStatus.QUEUED);
    });

    it('is a 409 when the session has not queued yet', async () => {
      enqueue(SESSION_EN, { status: SessionStatus.CREATED });
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    });

    it('is a 409 when the customer dropped out of the queue', async () => {
      enqueue(SESSION_EN, { status: SessionStatus.DROPPED_QUEUED });
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
    });

    it('is a 409 when another agent wins between the read and the write', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      // What the conditional UPDATE reports when it affects zero rows.
      sessionStore.loseNextClaim = true;

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
      // A lost claim leaves the agent free.
      const presence = await presenceStore.read(AGENT_A1);
      expect(presence?.status).toBe(AgentPresence.AVAILABLE);
    });

    // --- eligibility -------------------------------------------------------

    it('refuses a language the agent is not configured for', async () => {
      enqueue(SESSION_TA, { language: 'ta' });
      const token = await availableAgent();

      const response = await claim(SESSION_TA, token);

      expect(response.status).toBe(403);
      expect(sessionStore.rows.get(SESSION_TA)?.status).toBe(SessionStatus.QUEUED);
    });

    it('refuses an agent who never went available', async () => {
      enqueue(SESSION_EN);
      const token = await loginAs();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(sessionStore.claims).toHaveLength(0);
    });

    it('refuses an agent who went UNAVAILABLE', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      await bearer('/availability', token).send({ status: 'UNAVAILABLE' });

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
    });

    it('refuses an agent whose presence has expired', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      clockMs += (PRESENCE_TTL_SECONDS + 1) * 1000;

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(sessionStore.claims).toHaveLength(0);
    });

    it('refuses a second claim once the agent is BUSY', async () => {
      enqueue(SESSION_EN);
      enqueue(SESSION_TA, { language: 'hi' });
      const token = await availableAgent();

      const first = await claim(SESSION_EN, token);
      const second = await claim(SESSION_TA, token);

      expect(first.status).toBe(200);
      // BUSY is caught first; max_concurrent in PostgreSQL is the backstop.
      expect(second.status).toBe(409);
      expect(sessionStore.rows.get(SESSION_TA)?.status).toBe(SessionStatus.QUEUED);
    });

    it('enforces max_concurrent even when the agent looks free in Redis', async () => {
      // An offer already held, and a presence that says AVAILABLE anyway —
      // exactly the state a failed BUSY write leaves behind.
      enqueue(SESSION_OTHER, { status: SessionStatus.OFFERED, offeredToAgentId: AGENT_A1 });
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.QUEUED);
    });

    it('counts a call in progress against max_concurrent', async () => {
      enqueue(SESSION_OTHER, { status: SessionStatus.IN_CALL, agentId: AGENT_A1 });
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(409);
    });

    it('does not count another agent work against this agent', async () => {
      enqueue(SESSION_OTHER, { status: SessionStatus.IN_CALL, agentId: AGENT_A2 });
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await claim(SESSION_EN, token);

      expect(response.status).toBe(200);
    });

    // --- one agent cannot reach another -----------------------------------

    it('does not let one agent claim on behalf of another', async () => {
      enqueue(SESSION_EN);
      const mine = await availableAgent();
      // A second agent is available too, and is named in the body. The body is
      // rejected outright, and the offer would go to the token holder anyway.
      await availableAgent('agent.two@demo.local');

      const response = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${mine}`)
        .set('Idempotency-Key', idem())
        .send({ agent_id: AGENT_A2, offered_to_agent_id: AGENT_A2 });

      expect(response.status).toBe(400);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.QUEUED);
    });

    // --- logging -----------------------------------------------------------

    it('logs the claim without a credential', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      await claim(SESSION_EN, token);

      expect(logged).not.toContain(token);
      expect(logged).not.toContain(PASSWORD);
      // Not passing by logging nothing.
      expect(logged).toContain('agent.claim.offered');
      expect(logged).toContain(AGENT_A1);
      expect(logged).toContain(TENANT_A);
    });
  });

  // ------------------------------------------------------------ accept

  describe('POST /v1/agent/sessions/:id/accept', () => {
    const SESSION_EN = '00000000-0000-4000-8000-00000000f001';
    const SESSION_TWO = '00000000-0000-4000-8000-00000000f002';
    const QUEUED_AT = Date.parse('2026-08-31T08:59:28.000Z');

    let keySeq = 0;
    const idem = (): string => `accept-key-${(keySeq += 1)}`;

    const call = (path: string, id: string, token: string, key = idem()) =>
      post(`/sessions/${id}/${path}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({});

    const accept = (id: string, token: string, key = idem()) => call('accept', id, token, key);
    const claim = (id: string, token: string, key = idem()) => call('claim', id, token, key);

    const enqueue = (id: string, over: Partial<StoredSession> = {}): void => {
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
    };

    const availableAgent = async (email = 'agent.one@demo.local'): Promise<string> => {
      const token = await loginAs(email);
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      return token;
    };

    /** The real route to an offer: queue it, then claim it. */
    const claimed = async (id: string): Promise<string> => {
      enqueue(id);
      const token = await availableAgent();
      const response = await claim(id, token);
      expect(response.status).toBe(200);
      return token;
    };

    // --- the happy path ----------------------------------------------------

    it('moves an offered session to IN_CALL', async () => {
      const token = await claimed(SESSION_EN);

      const response = await accept(SESSION_EN, token);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(SessionStatus.IN_CALL);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.IN_CALL);
    });

    it('assigns the session to the accepting agent', async () => {
      const token = await claimed(SESSION_EN);

      const response = await accept(SESSION_EN, token);

      expect(response.body.data.agent_id).toBe(AGENT_A1);
      expect(sessionStore.rows.get(SESSION_EN)?.agentId).toBe(AGENT_A1);
    });

    it('returns exactly the four contract fields and no customer data', async () => {
      const token = await claimed(SESSION_EN);

      const response = await accept(SESSION_EN, token);

      expect(Object.keys(response.body)).toEqual(['data']);
      expect(Object.keys(response.body.data).sort()).toEqual([
        'agent_id',
        'room_name',
        'session_id',
        'status',
      ]);
      expect(response.body.data.room_name).toBe(`vcip_${SESSION_EN}`);
    });

    it('sets connected_at', async () => {
      const token = await claimed(SESSION_EN);

      await accept(SESSION_EN, token);

      expect(sessionStore.rows.get(SESSION_EN)?.connectedAt).toBeDefined();
    });

    it('keeps the agent BUSY', async () => {
      const token = await claimed(SESSION_EN);

      await accept(SESSION_EN, token);

      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.BUSY);
    });

    it('keeps the offer fields as history', async () => {
      const token = await claimed(SESSION_EN);

      await accept(SESSION_EN, token);

      const row = sessionStore.rows.get(SESSION_EN);
      expect(row?.offeredToAgentId).toBe(AGENT_A1);
      expect(row?.offerExpiresAt).not.toBeNull();
    });

    // --- refusals ----------------------------------------------------------

    it('refuses a session nobody has claimed', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();

      const response = await accept(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    });

    it('refuses an offer held by another agent', async () => {
      await claimed(SESSION_EN);
      const other = await availableAgent('agent.two@demo.local');

      const response = await accept(SESSION_EN, other);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.OFFERED);
    });

    it('refuses an offer that has lapsed', async () => {
      const token = await claimed(SESSION_EN);
      // Past the tenant's 30-second window.
      clockMs += 31_000;

      const response = await accept(SESSION_EN, token);

      expect(response.status).toBe(409);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.OFFERED);
    });

    it('is a 404 for another tenant session', async () => {
      sessionStore.seed({
        id: SESSION_TWO,
        tenantId: TENANT_B,
        status: SessionStatus.OFFERED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(QUEUED_AT),
        version: 2,
        offeredToAgentId: AGENT_B1,
        offerExpiresAt: new Date(clockMs + 30_000),
      });
      const token = await availableAgent();

      const response = await accept(SESSION_TWO, token);

      expect(response.status).toBe(404);
    });

    it('rejects a request with no credential', async () => {
      await claimed(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/accept`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(401);
    });

    it('rejects a body naming an agent or a room', async () => {
      const token = await claimed(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/accept`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({ agent_id: AGENT_A2, room_name: 'vcip_elsewhere' });

      expect(response.status).toBe(400);
    });

    it('requires an Idempotency-Key', async () => {
      const token = await claimed(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/accept`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('rejects a query string naming another tenant', async () => {
      const token = await claimed(SESSION_EN);

      const response = await post(`/sessions/${SESSION_EN}/accept?tenant_id=${TENANT_B}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({});

      expect(response.status).toBe(403);
    });

    // --- retry -------------------------------------------------------------

    it('returns the session to the agent already in it', async () => {
      const token = await claimed(SESSION_EN);

      const first = await accept(SESSION_EN, token);
      // A different key: a genuine second request, not an idempotency replay.
      const again = await accept(SESSION_EN, token);

      expect(again.status).toBe(200);
      expect(again.body.data).toEqual(first.body.data);
      expect(sessionStore.rows.get(SESSION_EN)?.version).toBe(first.body.data ? 4 : 4);
    });

    it('conflicts when the same key is reused for a different session', async () => {
      const token = await claimed(SESSION_EN);
      const key = 'one-key-two-accepts';

      const first = await accept(SESSION_EN, token, key);
      const second = await accept(SESSION_TWO, token, key);

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe(ErrorCode.CONFLICT);
    });

    // --- the queue ---------------------------------------------------------

    it('leaves the Redis queue member untouched', async () => {
      const token = await claimed(SESSION_EN);
      const snapshot = (): string =>
        JSON.stringify([...queueStore.sets].map(([k, v]) => [k, [...v.entries()].sort()]));
      const before = snapshot();

      await accept(SESSION_EN, token);

      expect(snapshot()).toBe(before);
    });

    it('logs no credential', async () => {
      const token = await claimed(SESSION_EN);

      await accept(SESSION_EN, token);

      expect(logged).not.toContain(token);
      expect(logged).not.toContain(PASSWORD);
      expect(logged).toContain('agent.accept.connected');
    });
  });

  // ------------------------------------------------------- offer sweeper

  describe('POST /internal/offers/sweep', () => {
    const SESSION_EN = '00000000-0000-4000-8000-00000000f101';
    const QUEUED_AT = Date.parse('2026-08-31T08:59:28.000Z');

    const sweep = () =>
      request(app.getHttpServer())
        .post('/internal/offers/sweep')
        .set(INTERNAL_TOKEN_HEADER, TEST_AUTH_CONFIG.internalToken)
        .send({});

    const claimOne = async (id: string): Promise<string> => {
      sessionStore.seed({
        id,
        tenantId: TENANT_A,
        status: SessionStatus.QUEUED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(QUEUED_AT),
        version: 2,
      });
      queueStore.seed(TENANT_A, 'en', id, QUEUED_AT);
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      const response = await post(`/sessions/${id}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `sweep-claim-${id}`)
        .send({});
      expect(response.status).toBe(200);
      return token;
    };

    it('returns a lapsed offer to the queue', async () => {
      await claimOne(SESSION_EN);
      clockMs += 31_000;

      const response = await sweep();

      expect(response.status).toBe(200);
      expect(response.body.data.expired).toBe(1);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.QUEUED);
    });

    it('frees the agent who let it lapse', async () => {
      const token = await claimOne(SESSION_EN);
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.BUSY);

      // Heartbeating throughout, which is the case that matters: an agent who
      // stops loses the key to its 15s TTL, but one with the tab open stays
      // BUSY for as long as they keep refreshing it — that is, for ever.
      for (let i = 0; i < 4; i += 1) {
        clockMs += 8_000;
        await bearer('/heartbeat', token).send({});
      }
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.BUSY);

      const response = await sweep();

      // Otherwise the agent stays BUSY for as long as their heartbeat runs.
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.AVAILABLE);
      expect(response.body.data.freed).toBe(1);
    });

    it('leaves an offer that is still live', async () => {
      await claimOne(SESSION_EN);

      const response = await sweep();

      expect(response.body.data.expired).toBe(0);
      expect(sessionStore.rows.get(SESSION_EN)?.status).toBe(SessionStatus.OFFERED);
    });

    it('lets the session be claimed again once it is back', async () => {
      await claimOne(SESSION_EN);
      clockMs += 31_000;
      await sweep();

      // The same agent, which also proves their max_concurrent was released.
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      const again = await post(`/sessions/${SESSION_EN}/claim`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'reclaim-after-sweep')
        .send({});

      expect(again.status).toBe(200);
      expect(again.body.data.offered_to_agent_id).toBe(AGENT_A1);
    });

    it('keeps the queue member at its original score', async () => {
      await claimOne(SESSION_EN);
      clockMs += 31_000;

      await sweep();

      // T18 never removed it, so the customer keeps the place they waited for.
      expect(queueStore.sets.get(queueKey(TENANT_A, 'en'))?.get(SESSION_EN)).toBe(QUEUED_AT);
    });

    it('is a no-op when run twice', async () => {
      await claimOne(SESSION_EN);
      clockMs += 31_000;

      const first = await sweep();
      const second = await sweep();

      expect(first.body.data.expired).toBe(1);
      expect(second.body.data.expired).toBe(0);
    });

    it('rejects a request with no internal token', async () => {
      const response = await request(app.getHttpServer()).post('/internal/offers/sweep').send({});

      expect(response.status).toBe(401);
    });

    it('rejects an agent JWT', async () => {
      const token = await loginAs();

      const response = await request(app.getHttpServer())
        .post('/internal/offers/sweep')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(401);
    });

    it('reports counts and no identifiers', async () => {
      await claimOne(SESSION_EN);
      clockMs += 31_000;

      const response = await sweep();

      expect(Object.keys(response.body.data).sort()).toEqual(['expired', 'freed']);
      expect(JSON.stringify(response.body)).not.toContain(SESSION_EN);
      expect(JSON.stringify(response.body)).not.toContain(AGENT_A1);
    });
  });

  // ------------------------------- availability while holding work (bug fix)

  describe('POST /v1/agent/availability while holding work', () => {
    const SESSION_EN = '00000000-0000-4000-8000-00000000f201';
    const QUEUED_AT = Date.parse('2026-08-31T08:59:28.000Z');

    let seq = 0;
    const idem = (): string => `avail-key-${(seq += 1)}`;

    const enqueue = (id: string): void => {
      sessionStore.seed({
        id,
        tenantId: TENANT_A,
        status: SessionStatus.QUEUED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(QUEUED_AT),
        version: 2,
      });
      queueStore.seed(TENANT_A, 'en', id, QUEUED_AT);
    };

    const availableAgent = async (): Promise<string> => {
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      return token;
    };

    const act = (path: string, id: string, token: string) =>
      post(`/sessions/${id}/${path}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({});

    it('refuses AVAILABLE while the agent holds an offer', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      expect((await act('claim', SESSION_EN, token)).status).toBe(200);

      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
    });

    it('leaves the agent BUSY after refusing', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      await act('claim', SESSION_EN, token);

      await bearer('/availability', token).send({ status: 'AVAILABLE' });

      // The bug: this used to read AVAILABLE, and the agent looked free while
      // holding a session.
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.BUSY);
      const beat = await bearer('/heartbeat', token).send({});
      expect(beat.body.data.status).toBe(AgentPresence.BUSY);
    });

    it('refuses AVAILABLE while the agent is IN_CALL', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      await act('claim', SESSION_EN, token);
      expect((await act('accept', SESSION_EN, token)).status).toBe(200);

      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(409);
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.BUSY);
    });

    it('still lets a busy agent go UNAVAILABLE', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      await act('claim', SESSION_EN, token);

      const response = await bearer('/availability', token).send({ status: 'UNAVAILABLE' });

      expect(response.status).toBe(200);
      expect(await presenceStore.read(AGENT_A1)).toBeNull();
    });

    it('allows AVAILABLE again once the session ends', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      await act('claim', SESSION_EN, token);
      await act('accept', SESSION_EN, token);

      // The verdict path ends a session; T19 has no route for it yet, so the
      // store is moved directly — the point is that PostgreSQL stops counting
      // the session, and availability follows.
      const row = sessionStore.rows.get(SESSION_EN);
      if (row !== undefined) {
        sessionStore.seed({ ...row, status: SessionStatus.APPROVED });
      }

      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('AVAILABLE');
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.AVAILABLE);
    });

    it('allows AVAILABLE again once the sweeper reclaims the offer', async () => {
      enqueue(SESSION_EN);
      const token = await availableAgent();
      await act('claim', SESSION_EN, token);
      clockMs += 31_000;
      await request(app.getHttpServer())
        .post('/internal/offers/sweep')
        .set(INTERNAL_TOKEN_HEADER, TEST_AUTH_CONFIG.internalToken)
        .send({});

      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(200);
    });

    it('leaves an idle agent AVAILABLE exactly as before', async () => {
      // The existing behaviour, unchanged: nothing held, so nothing refused.
      const token = await loginAs();

      const response = await bearer('/availability', token).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('AVAILABLE');
      expect((await presenceStore.read(AGENT_A1))?.status).toBe(AgentPresence.AVAILABLE);
    });

    it('still rejects a client trying to send BUSY', async () => {
      const token = await loginAs();

      const response = await bearer('/availability', token).send({ status: 'BUSY' });

      // Structural: BUSY is not in the shared schema, so it never reaches the
      // service at all.
      expect(response.status).toBe(400);
    });

    it('does not let one agent work affect another agent availability', async () => {
      enqueue(SESSION_EN);
      const mine = await availableAgent();
      await act('claim', SESSION_EN, mine);

      const other = await loginAs('agent.two@demo.local');
      const response = await bearer('/availability', other).send({ status: 'AVAILABLE' });

      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------- work

  describe('GET /v1/agent/work', () => {
    const SESSION_W = '00000000-0000-4000-8000-0000000000w1'.replace('w1', 'f1');
    const QUEUED_AT = new Date(clockMs - 60_000);

    const held = (over: Partial<StoredSession> = {}): StoredSession => ({
      id: SESSION_W,
      tenantId: TENANT_A,
      status: SessionStatus.IN_CALL,
      language: 'en',
      priority: 0,
      queuedAt: QUEUED_AT,
      version: 3,
      agentId: AGENT_A1,
      connectedAt: new Date(clockMs),
      // The accept keeps the offer columns as history (T19), so a real IN_CALL
      // row carries these. The fixture carries them too, or the work route
      // would be tested against a tidier row than the database ever produces.
      offeredToAgentId: AGENT_A1,
      offeredAt: new Date(clockMs - 5_000),
      offerExpiresAt: new Date(clockMs + 25_000),
      ...over,
    });

    const work = (token: string) =>
      request(app.getHttpServer()).get('/v1/agent/work').set('Authorization', `Bearer ${token}`);

    /**
     * The endpoint that ends the stranding. Before it existed, an agent whose
     * browser state was gone landed on the queue screen while the server
     * refused their availability with a 409 for holding a session no response
     * would name — and nothing frees an IN_CALL session, so it never resolved.
     */
    it('reports the session an agent is in call with', async () => {
      sessionStore.seed(held());
      const token = await loginAs();

      const response = await work(token);

      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toHaveLength(1);
      expect(response.body.data.sessions[0].session_id).toBe(SESSION_W);
      expect(response.body.data.sessions[0].status).toBe(SessionStatus.IN_CALL);
      expect(response.body.data.sessions[0].room_name).toBe(`vcip_${SESSION_W}`);
    });

    it('reports an outstanding offer with its window', async () => {
      const expires = new Date(clockMs + 30_000);
      sessionStore.seed(
        held({
          status: SessionStatus.OFFERED,
          agentId: null,
          connectedAt: null,
          offeredToAgentId: AGENT_A1,
          offeredAt: new Date(clockMs),
          offerExpiresAt: expires,
        }),
      );
      const token = await loginAs();

      const response = await work(token);

      expect(response.body.data.sessions[0].status).toBe(SessionStatus.OFFERED);
      expect(response.body.data.sessions[0].offer_expires_at).toBe(expires.toISOString());
    });

    /**
     * The fixture deliberately carries an offer window, because a real IN_CALL
     * row does: T19 keeps the offer columns as history. Reporting it would put
     * a running countdown on a call that has no deadline.
     */
    it('hides the offer window a call inherited from its claim', async () => {
      sessionStore.seed(held());
      const token = await loginAs();
      const response = await work(token);
      expect(response.body.data.sessions[0].status).toBe(SessionStatus.IN_CALL);
      expect(response.body.data.sessions[0].offer_expires_at).toBeNull();
    });

    it('returns an empty list for an agent holding nothing', async () => {
      const token = await loginAs();
      const response = await work(token);
      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toEqual([]);
    });

    it('never reports another agent’s work', async () => {
      sessionStore.seed(held({ agentId: AGENT_A1 }));
      const token = await loginAs('agent.two@demo.local');

      const response = await work(token);

      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toEqual([]);
    });

    it('never reports another tenant’s session', async () => {
      sessionStore.seed(held({ tenantId: TENANT_A, agentId: AGENT_B1 }));
      const token = await loginAs('agent.one@other.local', 'other-bank');

      const response = await work(token);

      expect(response.status).toBe(200);
      expect(response.body.data.sessions).toEqual([]);
    });

    it('does not report a queued session, which nobody holds', async () => {
      sessionStore.seed(held({ status: SessionStatus.QUEUED, agentId: null, connectedAt: null }));
      const token = await loginAs();
      const response = await work(token);
      expect(response.body.data.sessions).toEqual([]);
    });

    it('does not report a finished session', async () => {
      sessionStore.seed(held({ status: SessionStatus.APPROVED }));
      const token = await loginAs();
      const response = await work(token);
      expect(response.body.data.sessions).toEqual([]);
    });

    it('401s without an agent credential', async () => {
      const response = await request(app.getHttpServer()).get('/v1/agent/work');
      expect(response.status).toBe(401);
    });

    it('401s with a customer token', async () => {
      const response = await work(customerToken(TENANT_A, SESSION_W));
      expect(response.status).toBe(401);
    });

    it('writes nothing', async () => {
      sessionStore.seed(held());
      const token = await loginAs();
      const before = sessionStore.writes;

      await work(token);

      expect(sessionStore.writes).toBe(before);
    });

    /**
     * The two halves of the bug, asserted together: the availability refusal
     * and the work listing must agree about what holding a session means, or
     * an agent is refused for work that no endpoint will show them.
     */
    it('shows exactly the work that makes availability refuse', async () => {
      sessionStore.seed(held());
      const token = await loginAs();

      const availability = await bearer('/availability', token).send({ status: 'AVAILABLE' });
      expect(availability.status).toBe(409);

      const response = await work(token);
      expect(response.body.data.sessions).toHaveLength(1);
      expect(response.body.data.sessions[0].session_id).toBe(SESSION_W);
    });
  });

  // ------------------------------------------------ realtime notifications

  describe('what the agent routes publish (T27)', () => {
    /**
     * T27 owns transport, not timing: these assert that the module which
     * *decides* something happened is the one that says so, and that it says it
     * once, to the right audience.
     */
    const enqueueOne = (id: string): void => {
      const row: StoredSession = {
        id,
        tenantId: TENANT_A,
        status: SessionStatus.QUEUED,
        language: 'en',
        priority: 0,
        queuedAt: new Date(clockMs - 60_000),
        version: 1,
      };
      sessionStore.seed(row);
      queueStore.seed(row.tenantId, row.language, row.id, row.queuedAt.getTime());
    };

    it('tells the customer an agent was offered their session', async () => {
      const id = '00000000-0000-4000-8000-0000000000c1';
      enqueueOne(id);
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      notifications.clear();

      await bearer(`/sessions/${id}/claim`, token)
        .set('Idempotency-Key', `k-${Math.random()}`)
        .send({});

      expect(notifications.of('sessionOffered').map((n) => n.args[0])).toEqual([id]);
    });

    it('tells the customer and the agent when the offer is accepted', async () => {
      const id = '00000000-0000-4000-8000-0000000000c2';
      enqueueOne(id);
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      await bearer(`/sessions/${id}/claim`, token)
        .set('Idempotency-Key', `k-${Math.random()}`)
        .send({});
      notifications.clear();

      await bearer(`/sessions/${id}/accept`, token)
        .set('Idempotency-Key', `k-${Math.random()}`)
        .send({});

      expect(notifications.of('sessionAssigned')).toHaveLength(1);
      expect(notifications.of('sessionAssigned')[0]?.args[0]).toBe(id);
    });

    it('publishes nothing when a claim is refused', async () => {
      const id = '00000000-0000-4000-8000-0000000000c3';
      enqueueOne(id);
      const first = await loginAs();
      const second = await loginAs('agent.two@demo.local');
      await bearer('/availability', first).send({ status: 'AVAILABLE' });
      await bearer('/availability', second).send({ status: 'AVAILABLE' });
      await bearer(`/sessions/${id}/claim`, first)
        .set('Idempotency-Key', `k-${Math.random()}`)
        .send({});
      notifications.clear();

      // The loser is told their target went elsewhere, and the customer is not
      // told a second time that an agent was offered the session.
      await bearer(`/sessions/${id}/claim`, second)
        .set('Idempotency-Key', `k-${Math.random()}`)
        .send({});

      expect(notifications.of('sessionOffered')).toHaveLength(0);
      expect(notifications.of('sessionClaimedElsewhere')).toHaveLength(1);
    });

    it('tells the agent when the sweeper takes their offer back', async () => {
      const id = '00000000-0000-4000-8000-0000000000c4';
      enqueueOne(id);
      const token = await loginAs();
      await bearer('/availability', token).send({ status: 'AVAILABLE' });
      await bearer(`/sessions/${id}/claim`, token)
        .set('Idempotency-Key', `k-${Math.random()}`)
        .send({});
      notifications.clear();

      clockMs += 60_000;
      await request(app.getHttpServer())
        .post('/internal/offers/sweep')
        .set(INTERNAL_TOKEN_HEADER, TEST_AUTH_CONFIG.internalToken);

      expect(notifications.of('sessionOfferExpired').map((n) => n.args[2])).toEqual([id]);
    });
  });
});
