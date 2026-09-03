/**
 * The webhook surface through a real Nest application, over real HTTP.
 *
 * Every delivery below is **genuinely signed** with the LiveKit SDK's own
 * `AccessToken`, in the exact shape `livekit-server` sends: a JWT in
 * `Authorization` whose claim carries a SHA-256 of the body, and a
 * `application/webhook+json` content type. Nothing is stubbed on the
 * authentication path — `LiveKitWebhookVerifier` and `WebhookReceiver` are the
 * production classes.
 *
 * That matters more than usual here. The content type is what broke this route
 * the first time it met a real LiveKit: the default JSON body parser matches
 * only `application/json`, so `rawBody` was never captured and every authentic
 * delivery failed with a 401. A test that posted `application/json` would have
 * passed while the deployment rejected everything.
 */

import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SessionEventType, SessionStatus } from '@vcip/shared';
import { AccessToken } from 'livekit-server-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import type {
  AcceptCommand,
  AgentWorkRow,
  CallSessionRow,
  ClaimCommand,
  ClaimableSessionRow,
  CreateSessionInput,
  EndCallCommand,
  EndedCallRow,
  ExpiredOfferRow,
  GuardedUpdate,
  MediaTokenSessionRow,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionEventInput,
  SessionRepository,
  SessionRow,
  UnrecordedCallRow,
} from '../sessions/session.repository.js';
import { SESSION_REPOSITORY } from '../sessions/session.repository.js';
import type { TenantConfig, TenantConfigStore } from '../tenants/tenant-config.store.js';
import { TENANT_CONFIG_STORE } from '../tenants/tenant-config.store.js';
import { TenantsService } from '../tenants/tenants.service.js';
import { CallLifecycleService } from './call-lifecycle.service.js';
import type { CallRepository, DueDeadline } from './call.repository.js';
import { CALL_REPOSITORY } from './call.repository.js';
import { deadlineMember } from './call.keys.js';
import { LiveKitWebhookController } from './livekit-webhook.controller.js';
import type { LiveKitConfig } from './livekit.config.js';
import { LIVEKIT_CONFIG } from './livekit.config.js';
import { RecordingService } from './recording.service.js';
import { AiAnalysisService } from '../ai/ai-analysis.service.js';
import { ANALYSIS_STARTER } from '../ai/ai-analysis.client.js';
import { AI_CONFIG } from '../ai/ai.config.js';
import { MEDIA_TOKEN_MINTER } from './media-token.minter.js';
import { RECORDING_STARTER } from './recording.client.js';
import type { RecordingStarter } from './recording.client.js';
import { LiveKitWebhookVerifier, WEBHOOK_VERIFIER } from './webhook.verifier.js';
import { NOTIFICATIONS } from '../realtime/notifications.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ROOM = `vcip_${SESSION}`;

const LIVEKIT: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'FAKE-livekit-secret-for-tests-0123456789',
  tokenTtlSeconds: 900,
};

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
 * Sign a body exactly as `livekit-server` does.
 *
 * The claim carries the base64 SHA-256 of the body; `WebhookReceiver` recomputes
 * it from the raw bytes and refuses a mismatch.
 */
const signed = async (body: string): Promise<string> => {
  const token = new AccessToken(LIVEKIT.apiKey, LIVEKIT.apiSecret, { ttl: 300 });
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
};

const webhookBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event: 'participant_joined',
    id: `EV_${Math.random().toString(36).slice(2)}`,
    createdAt: Math.floor(Date.now() / 1000),
    room: { name: ROOM },
    participant: { identity: 'customer' },
    ...over,
  });

// --------------------------------------------------------------------- fakes

class FakeCalls implements CallRepository {
  readonly seen = new Set<string>();
  readonly participants = new Map<string, Set<string>>();
  readonly deadlines = new Map<string, number>();

  markSeen(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return Promise.resolve(false);
    this.seen.add(eventId);
    return Promise.resolve(true);
  }
  addParticipant(sessionId: string, role: string): Promise<readonly string[]> {
    const set = this.participants.get(sessionId) ?? new Set<string>();
    set.add(role);
    this.participants.set(sessionId, set);
    return Promise.resolve([...set]);
  }
  removeParticipant(sessionId: string, role: string): Promise<readonly string[]> {
    const set = this.participants.get(sessionId) ?? new Set<string>();
    set.delete(role);
    this.participants.set(sessionId, set);
    return Promise.resolve([...set]);
  }
  clearParticipants(sessionId: string): Promise<void> {
    this.participants.delete(sessionId);
    return Promise.resolve();
  }
  armDeadline(sessionId: string, role: string, dueAtMs: number): Promise<void> {
    this.deadlines.set(deadlineMember(sessionId, role as 'customer' | 'agent'), dueAtMs);
    return Promise.resolve();
  }
  disarmDeadline(sessionId: string, role: string): Promise<boolean> {
    return Promise.resolve(
      this.deadlines.delete(deadlineMember(sessionId, role as 'customer' | 'agent')),
    );
  }
  disarmAll(): Promise<void> {
    return Promise.resolve();
  }
  dueDeadlines(): Promise<readonly DueDeadline[]> {
    return Promise.resolve([]);
  }
  clear(): void {
    this.seen.clear();
    this.participants.clear();
    this.deadlines.clear();
  }
}

class FakeSessions implements SessionRepository {
  status: SessionStatus = SessionStatus.IN_CALL;
  exists = true;
  readonly appended: SessionEventInput[] = [];

  findUnrecordedCalls(): Promise<readonly UnrecordedCallRow[]> {
    throw new Error('the webhook route must not look for unrecorded calls');
  }

  findForCallEvent(sessionId: string): Promise<CallSessionRow | null> {
    if (!this.exists) return Promise.resolve(null);
    return Promise.resolve({
      id: sessionId,
      tenantId: TENANT,
      status: this.status,
      roomName: `vcip_${sessionId}`,
      agentId: AGENT,
      queuedAt: new Date(Date.now() - 60_000),
      connectedAt: new Date(),
      callStartedAt: null,
    });
  }
  appendCallEvent(_s: string, event: SessionEventInput): Promise<boolean> {
    this.appended.push(event);
    return Promise.resolve(true);
  }
  hasEvent(_s: string, eventType: SessionEventType): Promise<boolean> {
    return Promise.resolve(this.appended.some((e) => e.type === eventType));
  }
  submitVerdict(): Promise<never> {
    throw new Error('a webhook must never submit a verdict');
  }

  endCall(_c: EndCallCommand): Promise<EndedCallRow | null> {
    throw new Error('the webhook must not end a call; the sweeper does');
  }
  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('no');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('no');
  }

  abortSession(): Promise<SessionRow | null> {
    throw new Error('a webhook must not abort a session');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('no');
  }
  accept(_c: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('no');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('no');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('no');
  }
  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('no');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('no');
  }
  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('no');
  }
  findActiveWork(): Promise<readonly AgentWorkRow[]> {
    throw new Error('no');
  }
  countActiveWork(): Promise<number> {
    throw new Error('no');
  }
  clear(): void {
    this.appended.length = 0;
    this.status = SessionStatus.IN_CALL;
    this.exists = true;
  }
}

/** Records what it was asked to record; starts nothing. */
const recordingStarter: RecordingStarter = {
  start: (roomName: string, sessionId: string) =>
    Promise.resolve({ egressId: `EG_${sessionId.slice(0, 8)}`, key: `raw/${sessionId}.mp4` }),
};

const calls = new FakeCalls();
const sessions = new FakeSessions();

const tenantStore: TenantConfigStore = {
  findConfig: (tenantId) =>
    Promise.resolve({
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
      agentReconnectTimeoutSeconds: 60,
    } satisfies TenantConfig),
  findActiveChecklistTemplateId: () => Promise.resolve(null),
};

/** T30's AI service, recorded rather than called. */
const analysisStarter = {
  started: [] as { sessionId: string; roomName: string }[],
  start(sessionId: string, request: { room_name: string }): Promise<void> {
    analysisStarter.started.push({ sessionId, roomName: request.room_name });
    return Promise.resolve();
  },
};

const analyzerMinter = {
  minted: [] as { role: string; roomName: string }[],
  mint(request: { role: string; roomName: string }): Promise<string> {
    analyzerMinter.minted.push({ role: request.role, roomName: request.roomName });
    return Promise.resolve('an.analyzer.token');
  },
};

const AI = { enabled: true, baseUrl: 'http://ai.test', startTimeoutMs: 2_000 };

@Module({
  imports: [LoggingModule],
  controllers: [LiveKitWebhookController],
  providers: [
    { provide: NOTIFICATIONS, useValue: new RecordingNotifications() },
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    InternalTokenGuard,
    { provide: LIVEKIT_CONFIG, useValue: LIVEKIT },
    { provide: WEBHOOK_VERIFIER, useClass: LiveKitWebhookVerifier },
    { provide: CALL_REPOSITORY, useValue: calls },
    { provide: SESSION_REPOSITORY, useValue: sessions },
    { provide: TENANT_CONFIG_STORE, useValue: tenantStore },
    TenantsService,
    // T28: the lifecycle starts a recording once both participants are in the
    // room. The starter is a double — this suite is about the webhook, and an
    // egress container is not part of it.
    { provide: RECORDING_STARTER, useValue: recordingStarter },
    RecordingService,
    // T30: the same instant also starts the AI analysis. Both collaborators
    // are doubles for the same reason — this suite is about what a webhook
    // delivery does, not about an egress container or a Python service.
    { provide: MEDIA_TOKEN_MINTER, useValue: analyzerMinter },
    { provide: ANALYSIS_STARTER, useValue: analysisStarter },
    { provide: AI_CONFIG, useValue: AI },
    AiAnalysisService,
    CallLifecycleService,
  ],
})
class TestWebhookModule {}

describe('the LiveKit webhook over HTTP', () => {
  let app: NestExpressApplication;

  const post = async (body: string, contentType = 'application/webhook+json') =>
    request(app.getHttpServer())
      .post('/internal/livekit/webhook')
      .set('Authorization', await signed(body))
      .set('Content-Type', contentType)
      .send(body);

  beforeEach(async () => {
    calls.clear();
    sessions.clear();
    analysisStarter.started.length = 0;
    analyzerMinter.minted.length = 0;

    const sink = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const logger = createLogger({ level: 'silent', destination: sink });

    const moduleRef = await Test.createTestingModule({ imports: [TestWebhookModule] })
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    // The same parser configuration `main.ts` installs. Without it the raw body
    // is never captured for LiveKit's content type.
    app.useBodyParser('json', { type: ['application/json', 'application/webhook+json'] });
    app.useGlobalFilters(new ApiErrorFilter(logger));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------- T31

  describe('the AI analysis across a customer drop', () => {
    const joined = (identity: string) => post(webhookBody({ participant: { identity } }));
    const left = (identity: string) =>
      post(webhookBody({ event: 'participant_left', participant: { identity } }));

    const bothJoin = async (): Promise<void> => {
      await joined('agent');
      await joined('customer');
    };

    it('is asked for once when the call starts', async () => {
      await bothJoin();

      expect(analysisStarter.started).toHaveLength(1);
      expect(analysisStarter.started[0]!.roomName).toBe(ROOM);
    });

    it('mints a subscribe-only analyzer credential for it', async () => {
      await bothJoin();

      expect(analyzerMinter.minted.map((entry) => entry.role)).toContain('analyzer');
    });

    it('is asked for again when the customer returns', async () => {
      // Over real HTTP, through the real signature check and the real
      // lifecycle: the analyzer leaves with the customer, so something has to
      // bring it back or the HUD stays frozen for the rest of the call.
      await bothJoin();
      await left('customer');
      await joined('customer');

      expect(analysisStarter.started).toHaveLength(2);
    });
  });

  // ------------------------------------------------------ authentication

  describe('authentication', () => {
    it('accepts a genuinely signed delivery', async () => {
      const response = await post(webhookBody());
      expect(response.status).toBe(200);
    });

    it('refuses a delivery with no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .post('/internal/livekit/webhook')
        .set('Content-Type', 'application/webhook+json')
        .send(webhookBody());
      expect(response.status).toBe(401);
    });

    it('refuses a signature from a different key pair', async () => {
      const body = webhookBody();
      const wrong = new AccessToken('devkey', 'FAKE-different-secret-for-tests-987654321', {
        ttl: 300,
      });
      wrong.sha256 = createHash('sha256').update(body).digest('base64');

      const response = await request(app.getHttpServer())
        .post('/internal/livekit/webhook')
        .set('Authorization', await wrong.toJwt())
        .set('Content-Type', 'application/webhook+json')
        .send(body);

      expect(response.status).toBe(401);
    });

    /**
     * The signature covers the body, so a replayed envelope cannot be edited to
     * name a different room or a different participant.
     */
    it('refuses a body that does not match the signed hash', async () => {
      const authorization = await signed(webhookBody());
      const tampered = webhookBody({ room: { name: 'vcip_00000000-0000-4000-8000-000000000999' } });

      const response = await request(app.getHttpServer())
        .post('/internal/livekit/webhook')
        .set('Authorization', authorization)
        .set('Content-Type', 'application/webhook+json')
        .send(tampered);

      expect(response.status).toBe(401);
    });

    /**
     * The regression that mattered. `livekit-server` posts
     * `application/webhook+json`; a parser configured only for
     * `application/json` never captures the raw body, and every authentic
     * delivery 401s.
     */
    it('captures the raw body for LiveKit’s own content type', async () => {
      const response = await post(webhookBody(), 'application/webhook+json');
      expect(response.status).toBe(200);
      expect(sessions.appended.length + calls.participants.size).toBeGreaterThan(0);
    });

    it('still accepts plain application/json', async () => {
      const response = await post(webhookBody(), 'application/json');
      expect(response.status).toBe(200);
    });

    it('carries no X-Internal-Token, because LiveKit cannot send one', async () => {
      // The deviation from D10, asserted rather than assumed: the route must
      // work without the shared credential.
      const response = await post(webhookBody());
      expect(response.status).toBe(200);
    });
  });

  // ------------------------------------------------------------ behaviour

  describe('what a delivery does', () => {
    it('starts the call only once both participants have joined', async () => {
      await post(webhookBody({ participant: { identity: 'agent' } }));
      expect(sessions.appended.map((e) => e.type)).not.toContain(SessionEventType.CALL_STARTED);

      await post(webhookBody({ participant: { identity: 'customer' } }));
      expect(sessions.appended.map((e) => e.type)).toContain(SessionEventType.CALL_STARTED);
    });

    it('records an agent disconnect and arms a window', async () => {
      await post(webhookBody({ participant: { identity: 'agent' } }));
      await post(webhookBody({ event: 'participant_left', participant: { identity: 'agent' } }));

      expect(sessions.appended.map((e) => e.type)).toContain(SessionEventType.AGENT_DISCONNECTED);
      expect(calls.deadlines.has(deadlineMember(SESSION, 'agent'))).toBe(true);
    });

    it('ignores a duplicate-identity eviction', async () => {
      await post(
        webhookBody({
          event: 'participant_left',
          participant: { identity: 'customer', disconnectReason: 2 },
        }),
      );
      expect(calls.deadlines.size).toBe(0);
    });
  });

  // ------------------------------------------- acknowledging what it cannot use

  describe('deliveries it cannot act on are still acknowledged', () => {
    /**
     * LiveKit retries a non-2xx. Reporting "not our room" as an error would buy
     * an endless redelivery of an event nothing will ever accept.
     */
    it('200s a room this product did not name', async () => {
      const response = await post(webhookBody({ room: { name: 'spike-room' } }));
      expect(response.status).toBe(200);
      expect(response.body.data.handled).toBe('IGNORE');
    });

    it('200s an unknown session', async () => {
      sessions.exists = false;
      const response = await post(webhookBody());
      expect(response.status).toBe(200);
      expect(response.body.data.handled).toBe('IGNORE');
    });

    it('200s an event type this product does not model', async () => {
      const response = await post(webhookBody({ event: 'track_published' }));
      expect(response.status).toBe(200);
      expect(response.body.data.handled).toBe('IGNORE');
    });

    it('200s a repeat of the same delivery, and does not act twice', async () => {
      const body = webhookBody({ participant: { identity: 'agent' } });
      const first = await post(body);
      const second = await post(body);

      expect(first.body.data.duplicate).toBe(false);
      expect(second.body.data.duplicate).toBe(true);
      expect(calls.participants.get(SESSION)?.size).toBe(1);
    });
  });
});
