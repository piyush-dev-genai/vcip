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
import type { AiHudPayload, DocumentCheckStatus, DocumentType } from '@vcip/shared';
import {
  DocumentCheckStatus as DocStatus,
  DocumentType as DocType,
  ErrorCode,
  LivenessStatus,
  OcrStatus,
  SessionStatus,
} from '@vcip/shared';
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
import { AiDocumentService } from './ai-document.service.js';
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

/**
 * The HUD, in memory, modelled as the hash it really is.
 *
 * Two writers touching disjoint fields of one record, and each write returning
 * the merged result — because that is the behaviour the services depend on and
 * a fake that simply stored the last payload would hide the bug it exists to
 * prevent: a sampled result blanking a document check, or the reverse.
 */
class FakeHud {
  readonly saved: { sessionId: string; payload: AiHudPayload }[] = [];
  readonly documents: {
    sessionId: string;
    documentType: DocumentType;
    status: DocumentCheckStatus;
    checkedAt: string;
  }[] = [];
  failWith: Error | null = null;
  documentFailWith: Error | null = null;
  /** Redis answered the write but not the read-back. `saveDocument` returns null. */
  mergeUnreadable = false;

  save(sessionId: string, payload: AiHudPayload): Promise<AiHudPayload> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.saved.push({ sessionId, payload });
    return Promise.resolve(this.merge(sessionId) ?? payload);
  }

  saveDocument(
    sessionId: string,
    documentType: DocumentType,
    status: DocumentCheckStatus,
    checkedAt: string,
  ): Promise<AiHudPayload | null> {
    if (this.documentFailWith) return Promise.reject(this.documentFailWith);
    this.documents.push({ sessionId, documentType, status, checkedAt });
    return Promise.resolve(this.mergeUnreadable ? null : this.merge(sessionId));
  }

  read(sessionId: string): Promise<AiHudPayload | null> {
    return Promise.resolve(this.merge(sessionId));
  }

  /** The three continuous fields from one writer, the document three from the other. */
  private merge(sessionId: string): AiHudPayload | null {
    const sampled = [...this.saved].reverse().find((entry) => entry.sessionId === sessionId);
    if (sampled === undefined) return null;

    const document = [...this.documents].reverse().find((entry) => entry.sessionId === sessionId);
    if (document === undefined) return sampled.payload;

    return {
      ...sampled.payload,
      document_type: document.documentType,
      document_status: document.status,
      document_checked_at: document.checkedAt,
    };
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
    AiDocumentService,
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
    hud.documents.length = 0;
    hud.failWith = null;
    hud.documentFailWith = null;
    hud.mergeUnreadable = false;
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

describe('POST /internal/ai/document-result', () => {
  let app: INestApplication;

  const verified = {
    session_id: SESSION,
    document_type: DocType.PAN,
    status: DocStatus.VERIFIED,
    model_versions: { document_ocr: 'demo-v1', document_verifier: 'mock-v1' },
  };

  const post = (body: unknown, token: string | null = INTERNAL_TOKEN) => {
    const req = request(app.getHttpServer()).post('/internal/ai/document-result');
    if (token !== null) req.set('X-Internal-Token', token);
    return req.send(body as object);
  };

  /** A sampled result first, so the HUD has continuous fields to preserve. */
  const seedSampledResult = () =>
    request(app.getHttpServer())
      .post('/internal/ai/result')
      .set('X-Internal-Token', INTERNAL_TOKEN)
      .send(healthy);

  beforeEach(async () => {
    hud.saved.length = 0;
    hud.documents.length = 0;
    hud.failWith = null;
    hud.documentFailWith = null;
    hud.mergeUnreadable = false;
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

  describe('authentication (D10)', () => {
    it('accepts a result carrying the internal credential', async () => {
      await seedSampledResult();

      const response = await post(verified);

      expect(response.status).toBe(200);
      expect(response.body.data.outcome).toBe('DELIVERED');
    });

    it('refuses a result with no credential', async () => {
      const response = await post(verified, null);

      expect(response.status).toBe(401);
      expect(hud.documents).toHaveLength(0);
    });
  });

  describe('the schema is the guarantee', () => {
    // The design rests on document contents never reaching this process. The
    // route is strict and has no field for them, so an AI service that started
    // sending one is refused rather than quietly storing it.
    it.each([
      ['document_number', '1234 5678 9012'],
      ['number', 'ABCDE1234F'],
      ['name', 'A Customer'],
      ['date_of_birth', '1990-01-01'],
      ['raw_text', 'INCOME TAX DEPARTMENT'],
    ])('refuses a payload carrying %s', async (key, value) => {
      const response = await post({ ...verified, [key]: value });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(hud.documents).toHaveLength(0);
    });

    it('refuses a reason that is prose rather than a token', async () => {
      // Where an upstream error body, which may quote the request, would
      // otherwise arrive under a harmless-looking name.
      const response = await post({
        ...verified,
        status: DocStatus.UNAVAILABLE,
        reason: 'rejected PAN ABCDE1234F: upstream 502',
      });

      expect(response.status).toBe(400);
    });

    it('accepts a machine-readable reason', async () => {
      await seedSampledResult();

      const response = await post({
        ...verified,
        status: DocStatus.UNREADABLE,
        reason: 'no_document_in_frame',
      });

      expect(response.status).toBe(200);
    });

    it.each([
      DocStatus.VERIFIED,
      DocStatus.NOT_VERIFIED,
      DocStatus.UNREADABLE,
      DocStatus.UNAVAILABLE,
    ])('accepts %s', async (status) => {
      await seedSampledResult();

      expect((await post({ ...verified, status })).status).toBe(200);
    });
  });

  describe('neither writer blanks the other', () => {
    it('keeps the continuous checks when a document check arrives', async () => {
      await seedSampledResult();

      await post(verified);
      const published = notifications.of('aiUpdated').at(-1)?.args[2] as AiHudPayload;

      // The whole point of the partial write. A document result that carried
      // its own nulls for these would wipe the panel an agent is watching.
      expect(published.liveness_status).toBe(LivenessStatus.LIVE);
      expect(published.face_match_score).toBe(95);
      expect(published.document_status).toBe(DocStatus.VERIFIED);
      expect(published.document_type).toBe(DocType.PAN);
    });

    it('keeps the document check when the next sampled result arrives', async () => {
      await seedSampledResult();
      await post(verified);
      notifications.clear();

      await seedSampledResult();
      const published = notifications.of('aiUpdated').at(-1)?.args[2] as AiHudPayload;

      // The failure this prevents: an agent presses the button, sees VERIFIED,
      // and it vanishes two seconds later when the next sampled result lands.
      expect(published.document_status).toBe(DocStatus.VERIFIED);
      expect(published.liveness_status).toBe(LivenessStatus.LIVE);
    });

    it('stamps the check with server time, not a clock the caller chose', async () => {
      await seedSampledResult();

      await post(verified);

      const stamped = hud.documents.at(-1)?.checkedAt ?? '';
      expect(Number.isNaN(Date.parse(stamped))).toBe(false);
      // And it is its own field: the panel ages a document check on a different
      // clock from the continuous ones, which go stale in ten seconds.
      const published = notifications.of('aiUpdated').at(-1)?.args[2] as AiHudPayload;
      expect(published.document_checked_at).toBe(stamped);
    });
  });

  describe('nothing here can fail the AI service', () => {
    it('answers 200 when the HUD cannot be written', async () => {
      hud.documentFailWith = new Error('redis is not answering');

      const response = await post(verified);

      expect(response.status).toBe(200);
      expect(response.body.data.outcome).toBe('STORED');
    });

    it('does not publish a partial HUD when the merge cannot be read', async () => {
      // Publishing the document fields alone would arrive at the panel as a
      // payload with no liveness status and blank the rest of it.
      hud.mergeUnreadable = true;

      const response = await post(verified);

      expect(response.body.data.outcome).toBe('STORED');
      expect(notifications.of('aiUpdated')).toHaveLength(0);
    });

    it('reports an unknown session without raising', async () => {
      sessions.row = null;

      const response = await post(verified);

      expect(response.status).toBe(200);
      expect(response.body.data.outcome).toBe('UNKNOWN_SESSION');
    });

    it('stores but does not publish once the call has ended', async () => {
      await seedSampledResult();
      notifications.clear();
      sessions.row = { ...inCall(), status: SessionStatus.APPROVED };

      const response = await post(verified);

      expect(response.body.data.outcome).toBe('STORED');
      expect(notifications.of('aiUpdated')).toHaveLength(0);
    });
  });

  describe('the customer is never told (R3)', () => {
    it('publishes only to the agent channel', async () => {
      await seedSampledResult();
      notifications.clear();

      await post(verified);

      // A customer shown a judgement about their own documents would be a
      // privacy failure and an invitation to argue with a machine that decides
      // nothing (I7).
      expect(notifications.kinds()).toEqual(['aiUpdated']);
    });
  });
});
