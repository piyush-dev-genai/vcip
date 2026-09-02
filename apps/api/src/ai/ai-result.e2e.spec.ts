/**
 * `POST /internal/ai/result` through a real Nest application, over real HTTP.
 *
 * Everything between the socket and the service is production code: the
 * internal guard, the error filter, the shared zod schema, the controller.
 * That is the point of testing it this way — the caller is a Python service
 * that cannot be type-checked against this repository, so what actually
 * matters is what the HTTP surface accepts and refuses.
 */

import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AiHudPayload } from '@vcip/shared';
import { ErrorCode, LivenessStatus, OcrStatus, SessionStatus } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import { NOTIFICATIONS } from '../realtime/notifications.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';
import type { CallSessionRow, SessionRepository } from '../sessions/session.repository.js';
import { SESSION_REPOSITORY } from '../sessions/session.repository.js';
import type { AiHudRepository } from './ai-hud.repository.js';
import { AI_HUD_REPOSITORY } from './ai-hud.repository.js';
import { AiResultController } from './ai-result.controller.js';
import { AiResultService } from './ai-result.service.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const INTERNAL_TOKEN = 'an-internal-token-long-enough-to-be-real';

const TEST_AUTH_CONFIG = {
  internalToken: INTERNAL_TOKEN,
  agentJwtSecret: 'x'.repeat(32),
  customerTokenSecret: 'y'.repeat(32),
  wsTokenSecret: 'z'.repeat(32),
  customerTokenTtlSeconds: 7_200,
  wsTokenTtlSeconds: 60,
} as unknown as AuthConfig;

const healthy = {
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1', face_match: 'demo-v1', ocr: 'demo-v1' },
};

const AGENT = '00000000-0000-4000-8000-0000000000a1';
const TENANT = '00000000-0000-4000-8000-00000000000a';

const inCall = (): CallSessionRow => ({
  id: SESSION,
  tenantId: TENANT,
  status: SessionStatus.IN_CALL,
  roomName: `vcip_${SESSION}`,
  agentId: AGENT,
  queuedAt: null,
  connectedAt: null,
  callStartedAt: new Date(),
});

/** The HUD, in memory. Redis is not what this suite is about. */
class FakeHud {
  readonly saved: { sessionId: string; payload: AiHudPayload }[] = [];
  failWith: Error | null = null;

  save(sessionId: string, payload: AiHudPayload): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.saved.push({ sessionId, payload });
    return Promise.resolve();
  }

  read(sessionId: string): Promise<AiHudPayload | null> {
    const last = [...this.saved].reverse().find((entry) => entry.sessionId === sessionId);
    return Promise.resolve(last?.payload ?? null);
  }
}

class FakeSessions {
  row: CallSessionRow | null = inCall();

  findForCallEvent(sessionId: string): Promise<CallSessionRow | null> {
    return Promise.resolve(this.row !== null && this.row.id === sessionId ? this.row : null);
  }
}

const hud = new FakeHud();
const sessions = new FakeSessions();
const notifications = new RecordingNotifications();

@Module({
  imports: [LoggingModule],
  controllers: [AiResultController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    InternalTokenGuard,
    { provide: AI_HUD_REPOSITORY, useValue: hud as unknown as AiHudRepository },
    { provide: SESSION_REPOSITORY, useValue: sessions as unknown as SessionRepository },
    { provide: NOTIFICATIONS, useValue: notifications },
    AiResultService,
  ],
})
class TestAiModule {}

describe('POST /internal/ai/result', () => {
  let app: INestApplication;

  const post = (body: unknown, token: string | null = INTERNAL_TOKEN) => {
    const req = request(app.getHttpServer()).post('/internal/ai/result');
    if (token !== null) req.set('X-Internal-Token', token);
    return req.send(body as object);
  };

  beforeEach(async () => {
    hud.saved.length = 0;
    hud.failWith = null;
    notifications.clear();
    sessions.row = inCall();

    const sink = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const logger = createLogger({ level: 'silent', destination: sink });

    const moduleRef = await Test.createTestingModule({ imports: [TestAiModule] })
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiErrorFilter(logger));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------ authentication

  describe('authentication (D10)', () => {
    it('accepts a result carrying the internal credential', async () => {
      const response = await post(healthy);

      expect(response.status).toBe(200);
      expect(response.body.data.outcome).toBe('DELIVERED');
    });

    it('refuses a result with no credential', async () => {
      const response = await post(healthy, null);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('refuses a result with the wrong credential', async () => {
      // Otherwise anyone who can reach the port could write onto the HUD an
      // agent is using to decide whether a person is who they say they are.
      const response = await post(healthy, 'not-the-internal-token');

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------- validation

  describe('what it accepts', () => {
    it('takes a wholly unavailable result', async () => {
      // D6: AI failure degrades the HUD, and the report still arrives.
      const response = await post({
        ...healthy,
        liveness_score: null,
        liveness_status: LivenessStatus.UNAVAILABLE,
        face_match_score: null,
        ocr_status: OcrStatus.UNAVAILABLE,
        model_versions: { liveness: 'unavailable', face_match: 'unavailable', ocr: 'unavailable' },
      });

      expect(response.status).toBe(200);
    });

    it('takes a repeated result without complaint', async () => {
      // The analyzer publishes a fresh snapshot every couple of seconds. The
      // last one winning is what a HUD is, so there is no idempotency key and
      // no conflict.
      await post(healthy);
      const second = await post(healthy);

      expect(second.status).toBe(200);
    });
  });

  describe('what it refuses', () => {
    it('refuses a misspelled field rather than ignoring it', async () => {
      const { liveness_score: _dropped, ...rest } = healthy;

      const response = await post({ ...rest, livenes_score: 97 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it.each([-1, 101, 96.5])('refuses %s as a score', async (liveness_score) => {
      const response = await post({ ...healthy, liveness_score });

      expect(response.status).toBe(400);
    });

    it('refuses a status outside the vocabulary', async () => {
      // The older `03-system-design.md` §19 sketch, which the contract replaced.
      const response = await post({ ...healthy, ocr_status: 'OCR_PASS' });

      expect(response.status).toBe(400);
    });

    it('refuses a session id that is not a uuid', async () => {
      const response = await post({ ...healthy, session_id: 'session-1' });

      expect(response.status).toBe(400);
    });

    it('refuses a result with no model versions', async () => {
      const { model_versions: _dropped, ...without } = healthy;

      const response = await post(without);

      expect(response.status).toBe(400);
    });

    it('refuses an empty body', async () => {
      const response = await post({});

      expect(response.status).toBe(400);
    });
  });

  // ----------------------------------------------------------- the HUD

  describe('the Redis HUD (T31)', () => {
    it('stores the result', async () => {
      await post(healthy);

      expect(hud.saved).toHaveLength(1);
      expect(hud.saved[0]!.sessionId).toBe(SESSION);
    });

    it('stores every field, including the model versions T35 will snapshot', async () => {
      // `06-database-schema.md` §"Snapshot Redis HUD -> session_ai_summaries":
      // this HUD is the source of that row, so anything the column needs has
      // to survive here.
      await post(healthy);

      expect(hud.saved[0]!.payload).toMatchObject({
        session_id: SESSION,
        liveness_score: 97,
        liveness_status: LivenessStatus.LIVE,
        face_match_score: 95,
        ocr_status: OcrStatus.PASS,
        model_versions: { liveness: 'demo-v1', face_match: 'demo-v1', ocr: 'demo-v1' },
      });
    });

    it('stamps the instant the Control API took delivery', async () => {
      // Server time, because the panel reads this to decide the AI has gone
      // quiet, and a clock the caller chose is one a dead caller could have
      // left in the future.
      await post(healthy);

      expect(Date.parse(hud.saved[0]!.payload.updated_at)).not.toBeNaN();
    });

    it('keeps an absent score absent rather than zero', async () => {
      await post({ ...healthy, liveness_score: null, liveness_status: LivenessStatus.UNAVAILABLE });

      expect(hud.saved[0]!.payload.liveness_score).toBeNull();
    });

    it('is still written for a session no agent is on', async () => {
      // The call ended while the analyzer was mid-cycle, which happens on
      // almost every call. The verdict transaction may still snapshot it.
      sessions.row = { ...inCall(), status: SessionStatus.APPROVED, agentId: null };

      const response = await post(healthy);

      expect(response.body.data.outcome).toBe('STORED');
      expect(hud.saved).toHaveLength(1);
    });
  });

  // --------------------------------------------------------- the fan-out

  describe('telling the agent (T31)', () => {
    it('publishes to the agent on the call', async () => {
      await post(healthy);

      const sent = notifications.of('aiUpdated');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.args[0]).toBe(TENANT);
      expect(sent[0]!.args[1]).toBe(AGENT);
    });

    it('publishes the HUD itself, so the panel needs no second read', async () => {
      await post(healthy);

      expect(notifications.of('aiUpdated')[0]!.args[2]).toMatchObject({
        session_id: SESSION,
        liveness_status: LivenessStatus.LIVE,
        model_versions: { liveness: 'demo-v1' },
      });
    });

    it('tells nobody when the session has ended', async () => {
      sessions.row = { ...inCall(), status: SessionStatus.APPROVED, agentId: null };

      await post(healthy);

      expect(notifications.kinds()).toEqual([]);
    });

    it('tells nobody when no agent holds the session', async () => {
      sessions.row = { ...inCall(), status: SessionStatus.QUEUED, agentId: null };

      await post(healthy);

      expect(notifications.kinds()).toEqual([]);
    });

    it('reports an unknown session without publishing', async () => {
      sessions.row = null;

      const response = await post(healthy);

      expect(response.body.data.outcome).toBe('UNKNOWN_SESSION');
      expect(notifications.kinds()).toEqual([]);
    });

    it('never sends anything to the customer', async () => {
      // R3 makes `ai.updated` an agent event, and the customer is the subject
      // of it. `aiUpdated` names an agent channel and there is no other call.
      await post(healthy);

      expect(notifications.kinds()).toEqual(['aiUpdated']);
    });

    it('still tells the agent when the HUD could not be stored', async () => {
      // Redis being down costs the summary, not the signal in front of the
      // agent on a live call.
      hud.failWith = new Error('redis unavailable');

      const response = await post(healthy);

      expect(response.status).toBe(200);
      expect(notifications.of('aiUpdated')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------ contract

  describe('the shape of the route', () => {
    it('answers 200 rather than 202', async () => {
      // By the time this returns the result has gone as far as it goes; there
      // is no later step for the caller to poll.
      expect((await post(healthy)).status).toBe(200);
    });

    it('answers in the documented envelope', async () => {
      const response = await post(healthy);

      expect(Object.keys(response.body)).toEqual(['data']);
    });
  });
});
