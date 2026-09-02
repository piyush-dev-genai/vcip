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
import { ErrorCode, LivenessStatus, OcrStatus } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
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

@Module({
  imports: [LoggingModule],
  controllers: [AiResultController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    InternalTokenGuard,
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
      expect(response.body.data.outcome).toBe('ACCEPTED');
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
