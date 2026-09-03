/**
 * A duplicate verdict over real HTTP (T36).
 *
 * `verdict-race.spec.ts` proves the service and the guard behave when two
 * verdicts collide. This proves the thing an agent's browser actually does,
 * which is not that at all: it retries with the same `Idempotency-Key`, and the
 * right answer to that is the **original 200**, not a 409.
 *
 * The distinction matters more here than on any other route (§18). A retried
 * verdict answered 409 tells an agent their decision failed at the exact moment
 * it succeeded — they resubmit, get 409 again, and conclude the system lost a
 * verification that is sitting in the ledger fully paid for. Two mechanisms
 * stand between that and reality, and they are not interchangeable:
 *
 *   - the **interceptor** (D13), which recognises the retry as the same
 *     operation and replays the first answer without running the handler,
 *   - the **guard** (D17), which catches everything the interceptor cannot see
 *     — a second tab, a fresh key, a different agent — and refuses with a 409.
 *
 * Both leave one verdict and one billing row. The handler is a real
 * `AgentVerdictService` over a store that models the guarded UPDATE, so the
 * count of executions is observable rather than inferred.
 */

import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AiHudPayload } from '@vcip/shared';
import { ErrorCode, LivenessStatus, OcrStatus, SessionStatus } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiHudRepository } from '../ai/ai-hud.repository.js';
import type {
  ChecklistRepository,
  ChecklistSessionRow,
} from '../checklist/checklist.repository.js';
import { ChecklistService } from '../checklist/checklist.service.js';
import { AGENT_ACTOR_CLAIM, AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { signJwt } from '../common/auth/tokens.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor.js';
import { IdempotencyStore } from '../common/idempotency/idempotency.store.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import { REDIS } from '../common/redis/redis.tokens.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';
import type {
  MediaTokenSessionRow,
  SessionRepository,
  SubmitVerdictCommand,
  SubmitVerdictOutcome,
} from '../sessions/session.repository.js';
import { SESSION_REPOSITORY } from '../sessions/session.repository.js';
import { AgentAcceptService } from './agent-accept.service.js';
import { AgentClaimService } from './agent-claim.service.js';
import { AgentDocumentService } from './agent-document.service.js';
import { AgentQueueService } from './agent-queue.service.js';
import { AgentVerdictService } from './agent-verdict.service.js';
import { AgentWorkService } from './agent-work.service.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { PresenceService } from './presence.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';

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

const ITEMS = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
];

const checklist = (over: Record<string, boolean> = {}) =>
  ITEMS.map((item) => ({ key: item.key, checked: over[item.key] ?? true }));

const HUD: AiHudPayload = {
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1' },
  updated_at: '2026-09-03T12:00:00.000Z',
  document_type: null,
  document_status: null,
  document_checked_at: null,
};

// ------------------------------------------------------------------- fakes

/**
 * The session, with the guarded UPDATE it really has.
 *
 * `executions` is the number of times the handler reached the transaction. It
 * is the only way to tell a replayed response from a second run that happened
 * to produce the same body, which is exactly what this file has to distinguish.
 */
class VerdictStore {
  status: SessionStatus = SessionStatus.IN_CALL;
  verdict: string | null = null;
  executions = 0;
  readonly billing: { category: string; amountPaise: number }[] = [];

  reset(): void {
    this.status = SessionStatus.IN_CALL;
    this.verdict = null;
    this.executions = 0;
    this.billing.length = 0;
  }

  findForMediaToken(tenantId: string, sessionId: string): Promise<MediaTokenSessionRow | null> {
    if (tenantId !== TENANT || sessionId !== SESSION) return Promise.resolve(null);
    return Promise.resolve({
      id: SESSION,
      tenantId: TENANT,
      status: this.status,
      roomName: `vcip_${SESSION}`,
      agentId: AGENT,
    });
  }

  submitVerdict(command: SubmitVerdictCommand): Promise<SubmitVerdictOutcome> {
    this.executions += 1;

    if (this.status !== SessionStatus.IN_CALL || this.verdict !== null) {
      return Promise.resolve({ kind: 'LOST' });
    }
    if (this.billing.length > 0) {
      throw new Error('billing_entries.session_id is the primary key: a second charge is refused');
    }

    this.status = command.verdict;
    this.verdict = command.verdict;
    this.billing.push({ category: command.billCategory, amountPaise: command.billAmountPaise });

    return Promise.resolve({
      kind: 'COMMITTED',
      session: {
        id: SESSION,
        status: command.verdict,
        verdict: command.verdict,
        billCategory: command.billCategory,
        billAmountPaise: command.billAmountPaise,
        talkMs: 90_000,
      },
    });
  }
}

class FakeChecklistRepository implements ChecklistRepository {
  findForSession(): Promise<ChecklistSessionRow | null> {
    return Promise.resolve({
      sessionId: SESSION,
      tenantId: TENANT,
      assignedAgentId: AGENT,
      templateId: '22222222-2222-4222-8222-222222222222',
      version: 1,
      items: ITEMS,
    });
  }

  saveAnswers(): Promise<never> {
    throw new Error('the verdict transaction writes the checklist, not the service');
  }
}

class FakeHud implements AiHudRepository {
  save(): Promise<AiHudPayload> {
    throw new Error('a verdict must never write the HUD');
  }

  saveDocument(): Promise<AiHudPayload | null> {
    throw new Error('a verdict must never write a document check');
  }
  read(): Promise<AiHudPayload | null> {
    return Promise.resolve(HUD);
  }
}

/**
 * Redis for the idempotency store, with an atomic `SET NX` and a round trip.
 *
 * The hop is not decoration: without it, two requests started together run to
 * completion one after the other, and a non-atomic claim would pass the
 * concurrent case.
 */
class FakeRedis {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();

  private async hop(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
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

  clear(): void {
    this.data.clear();
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
}

// ------------------------------------------------------------------ wiring

const store = new VerdictStore();
const redis = new FakeRedis();
const notifications = new RecordingNotifications();

/**
 * The five services this route does not touch.
 *
 * Present because the controller's constructor demands them, and empty rather
 * than stubbed: a stub that quietly worked would let a verdict route wired to
 * the wrong collaborator pass as a success. An empty object fails on the first
 * call, which is the behaviour wanted from something that must never be called.
 */
const unused = (): unknown => ({});

const presence = {
  markAvailable: (): Promise<void> => Promise.resolve(),
} as unknown as PresenceService;

@Module({
  imports: [LoggingModule],
  controllers: [AgentsController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    AgentJwtGuard,
    TenantScope,
    TenantGuard,
    { provide: REDIS, useValue: redis },
    IdempotencyStore,
    IdempotencyInterceptor,
    { provide: SESSION_REPOSITORY, useValue: store },
    { provide: AgentsService, useValue: unused() },
    { provide: PresenceService, useValue: presence },
    { provide: AgentQueueService, useValue: unused() },
    { provide: AgentWorkService, useValue: unused() },
    { provide: AgentClaimService, useValue: unused() },
    { provide: AgentAcceptService, useValue: unused() },
    { provide: AgentDocumentService, useValue: unused() },
    {
      provide: AgentVerdictService,
      useFactory: (sessions: SessionRepository, logger) =>
        new AgentVerdictService(
          sessions,
          new ChecklistService(new FakeChecklistRepository(), new TenantScope(), logger),
          new FakeHud(),
          presence,
          new TenantScope(),
          notifications,
          logger,
          () => new Date('2026-09-03T12:00:00.000Z'),
        ),
      inject: [SESSION_REPOSITORY, LOGGER],
    },
  ],
})
class TestVerdictModule {}

const tokenFor = (userId: string): string =>
  signJwt(
    { act: AGENT_ACTOR_CLAIM, tid: TENANT, uid: userId, role: 'AGENT' },
    { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
  );

// ------------------------------------------------------------------- tests

describe('a duplicate verdict over HTTP', () => {
  let app: INestApplication;

  const silent = () =>
    createLogger({
      level: 'silent',
      destination: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    });

  /** `POST /v1/agent/sessions/{id}/verdict`, as the portal sends it. */
  const verdict = (
    key: string,
    body: unknown = { verdict: SessionStatus.APPROVED, checklist: checklist() },
    userId = AGENT,
  ) =>
    request(app.getHttpServer())
      .post(`/v1/agent/sessions/${SESSION}/verdict`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .set('Idempotency-Key', key)
      .send(body as object);

  beforeEach(async () => {
    store.reset();
    redis.clear();
    notifications.clear();

    const moduleRef = await Test.createTestingModule({ imports: [TestVerdictModule] })
      .overrideProvider(LOGGER)
      .useValue(silent())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiErrorFilter(silent()));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('records the verdict once and answers 200', async () => {
    const response = await verdict('key-1');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      session_id: SESSION,
      status: SessionStatus.APPROVED,
      verdict: SessionStatus.APPROVED,
      bill_category: 'SUCCESS',
      bill_amount_paise: 2500,
    });
    expect(store.billing).toEqual([{ category: 'SUCCESS', amountPaise: 2500 }]);
  });

  describe('retried with the same key', () => {
    it('replays the original answer instead of refusing it', async () => {
      const first = await verdict('key-1');
      const second = await verdict('key-1');

      // The failure this prevents: an agent whose verdict committed being told
      // 409, resubmitting, and being told 409 again.
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
    });

    it('does not run the handler a second time', async () => {
      await verdict('key-1');
      await verdict('key-1');

      expect(store.executions).toBe(1);
      expect(store.billing).toHaveLength(1);
    });

    it('holds when both arrive at once', async () => {
      const [first, second] = await Promise.all([verdict('key-1'), verdict('key-1')]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.body).toEqual(second.body);
      expect(store.executions).toBe(1);
      expect(store.billing).toHaveLength(1);
    });

    it('refuses to reuse the key for a different decision', async () => {
      await verdict('key-1');
      const flipped = await verdict('key-1', {
        verdict: SessionStatus.REJECTED,
        checklist: checklist(),
      });

      // The fingerprint differs, so this is not the same operation. Replaying
      // the approval would be worse than refusing: it would answer APPROVED to
      // a request that asked for REJECTED.
      expect(flipped.status).toBe(409);
      expect(store.verdict).toBe(SessionStatus.APPROVED);
      expect(store.billing).toHaveLength(1);
    });
  });

  describe('retried with a fresh key', () => {
    it('is refused by the guard with a 409', async () => {
      await verdict('key-1');
      const second = await verdict('key-2');

      // Past the interceptor, which sees a new operation, and into the guard,
      // which sees a session that already ended.
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    });

    it('still leaves one verdict and one billing row', async () => {
      await verdict('key-1');
      await verdict('key-2');
      await verdict('key-3');

      expect(store.verdict).toBe(SessionStatus.APPROVED);
      expect(store.billing).toEqual([{ category: 'SUCCESS', amountPaise: 2500 }]);
    });

    it('tells a second agent the same thing, without naming the first', async () => {
      await verdict('key-1');
      const other = await verdict('key-2', undefined, OTHER_AGENT);

      expect(other.status).toBe(409);
      // No agent id, no verdict, no tenant: the loser learns that the session
      // has an outcome and nothing about who reached it.
      expect(JSON.stringify(other.body)).not.toContain(AGENT);
      expect(JSON.stringify(other.body)).not.toContain(SessionStatus.APPROVED);
    });
  });

  describe('a verdict that never committed', () => {
    it('leaves its key reusable', async () => {
      const rejected = await verdict('key-1', {
        verdict: SessionStatus.APPROVED,
        checklist: checklist({ face_visible: false }),
      });
      expect(rejected.status).toBe(422);

      // The claim was released, so the same key works once the agent ticks the
      // box. A failure cached under its key would strand them on a 409 until
      // the record expired.
      const retried = await verdict('key-1', {
        verdict: SessionStatus.APPROVED,
        checklist: checklist({ face_visible: false }),
      });
      expect(retried.status).toBe(422);
      expect(store.billing).toHaveLength(0);
    });

    it('was never charged for the attempt', async () => {
      await verdict('key-1', {
        verdict: SessionStatus.APPROVED,
        checklist: checklist({ document_shown: false }),
      });

      expect(store.executions).toBe(0);
      expect(store.status).toBe(SessionStatus.IN_CALL);
      expect(notifications.of('sessionCompleted')).toHaveLength(0);
    });
  });

  it('requires an Idempotency-Key at all', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/agent/sessions/${SESSION}/verdict`)
      .set('Authorization', `Bearer ${tokenFor(AGENT)}`)
      .send({ verdict: SessionStatus.APPROVED, checklist: checklist() });

    // §18 requires the header. Without it the route cannot promise at-most-once
    // and refuses rather than running unprotected.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(store.executions).toBe(0);
  });

  it('tells both screens once, however many duplicates arrive', async () => {
    await verdict('key-1');
    await verdict('key-1');
    await verdict('key-2');

    expect(notifications.of('sessionCompleted')).toHaveLength(1);
    expect((notifications.of('sessionCompleted')[0]?.args as unknown[])[1]).toBe(
      SessionStatus.APPROVED,
    );
  });
});
