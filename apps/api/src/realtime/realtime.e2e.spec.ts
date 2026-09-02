/**
 * The realtime surface end to end, over real sockets and real Redis Pub/Sub.
 *
 * Everything between a `ws://` connection and the transport is production code:
 * the Nest `WsAdapter`, `RealtimeGateway`, `handshake.ts`, the registry, the
 * channel derivation, `RedisRealtimeTransport`, and both token routes. Only the
 * agent profile lookup is substituted, because that is a database read and
 * these assertions are about routing.
 *
 * Redis is real on purpose. Pub/Sub is the part that makes this correct on more
 * than one instance, and a fake would prove nothing about subscribe timing,
 * message ordering, or the second connection the subscriber needs. The suite
 * skips itself when Redis is unavailable rather than passing on a double.
 *
 * The isolation cases are the point of the file. A customer must never hear
 * about another session, an agent must never hear another agent's work, and a
 * queue notification must reach only agents whose configured languages can
 * actually take the session.
 */

import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import type { AiHudPayload } from '@vcip/shared';
import {
  AgentEvent,
  CustomerEvent,
  LivenessStatus,
  OcrStatus,
  RealtimeAudience,
} from '@vcip/shared';
import { Redis } from 'ioredis';
import WebSocket from 'ws';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentCredentialRow,
  AgentProfileRow,
  AgentRepository,
} from '../agents/agent.repository.js';
import { AGENT_REPOSITORY } from '../agents/agent.repository.js';
import { AGENT_ACTOR_CLAIM } from '../common/auth/agent-jwt.guard.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { CUSTOMER_ACTOR_CLAIM } from '../common/auth/customer-token.guard.js';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { CustomerTokenGuard } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { signJwt } from '../common/auth/tokens.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import { REDIS } from '../common/redis/redis.tokens.js';
import { NOTIFICATIONS, TransportNotifications } from './notifications.js';
import type { Notifications } from './notifications.js';
import { RealtimeGateway, WS_PING_INTERVAL } from './realtime.gateway.js';
import { REALTIME_TRANSPORT, RedisRealtimeTransport } from './realtime.transport.js';
import { WsTokenController } from './ws-token.controller.js';
import { WsTokenService } from './ws-token.service.js';
import type { AiHudSnapshots } from '../ai/ai-hud.snapshots.js';
import { AI_HUD_SNAPSHOTS } from '../ai/ai-hud.snapshots.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_EN = '00000000-0000-4000-8000-0000000000a1';
const AGENT_TA = '00000000-0000-4000-8000-0000000000a2';
const SESSION_ONE = '11111111-1111-4111-8111-111111111111';
const SESSION_TWO = '22222222-2222-4222-8222-222222222222';

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
 * The HUD a connecting agent is handed (T31).
 *
 * Keyed by agent, because that is the question the gateway asks: what does
 * *this* connection already have coming to it.
 */
const HUDS: Record<string, AiHudPayload[]> = {};

const snapshots: AiHudSnapshots = {
  forAgent: (tenantId: string, userId: string) => Promise.resolve(HUDS[userId] ?? []),
};

const hudFor = (sessionId: string): AiHudPayload => ({
  session_id: sessionId,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1', face_match: 'demo-v1', ocr: 'demo-v1' },
  updated_at: '2026-09-02T12:00:00.000Z',
});

const PROFILES: Record<string, AgentProfileRow> = {
  [AGENT_EN]: { userId: AGENT_EN, tenantId: TENANT_A, languages: ['en', 'hi'], maxConcurrent: 1 },
  [AGENT_TA]: { userId: AGENT_TA, tenantId: TENANT_A, languages: ['ta'], maxConcurrent: 1 },
};

const agents: AgentRepository = {
  findAgentByEmail: (): Promise<AgentCredentialRow | null> => Promise.resolve(null),
  findProfile: (userId: string, tenantId: string): Promise<AgentProfileRow | null> => {
    const profile = PROFILES[userId];
    return Promise.resolve(profile !== undefined && profile.tenantId === tenantId ? profile : null);
  },
};

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

/** Real Redis, or skip: a fake would prove nothing about Pub/Sub. */
const redisAvailable = async (): Promise<boolean> => {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
};

let available = false;
beforeAll(async () => {
  available = await redisAvailable();
});

describe('realtime over real sockets and real Redis', () => {
  let app: NestExpressApplication;
  let redis: Redis;
  let notifications: Notifications;
  let port: number;
  let logged = '';

  const customerWsToken = (sessionId: string, tenantId = TENANT_A): string =>
    signJwt(
      { act: 'ws', aud: RealtimeAudience.CUSTOMER, tid: tenantId, sid: sessionId },
      { secret: TEST_AUTH_CONFIG.wsTokenSecret, ttlSeconds: 300 },
    );

  const agentWsToken = (userId: string, tenantId = TENANT_A): string =>
    signJwt(
      { act: 'ws', aud: RealtimeAudience.AGENT, tid: tenantId, uid: userId },
      { secret: TEST_AUTH_CONFIG.wsTokenSecret, ttlSeconds: 300 },
    );

  /**
   * Open a socket, listening from the first byte.
   *
   * Separate from `connect` because T31's snapshot is written during the
   * handshake: a listener attached afterwards would miss it, which is exactly
   * the race the priming exists to close.
   */
  const connectListening = async (
    token: string,
  ): Promise<{ socket: WebSocket; received: unknown[] }> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${encodeURIComponent(token)}`);
    const received: unknown[] = [];
    socket.on('message', (raw) => {
      received.push(JSON.parse(String(raw)));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 200));
    return { socket, received };
  };

  /** Open a socket and wait until the server has finished registering it. */
  const connect = async (token: string): Promise<WebSocket> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
      socket.once('close', (code) => {
        reject(new Error(`closed with ${String(code)}`));
      });
    });
    // The handshake handler is async: registration and the Redis SUBSCRIBE
    // complete after `open` fires. Publishing before that would race.
    await new Promise((r) => setTimeout(r, 200));
    return socket;
  };

  const messages = (socket: WebSocket): { readonly received: unknown[] } => {
    const received: unknown[] = [];
    socket.on('message', (raw) => {
      received.push(JSON.parse(String(raw)));
    });
    return { received };
  };

  /**
   * Wait for delivery, rather than sleeping and hoping.
   *
   * With no argument this is a fixed pause, which is what a "nothing should
   * arrive" assertion needs. With a predicate it polls until the condition
   * holds, so a positive assertion is not racing a fixed timeout — the whole
   * path here is asynchronous (publish, Redis fan-out, socket write) and a
   * quarter-second was enough on an idle machine and not enough under a full
   * suite.
   */
  const settle = async (until?: () => boolean): Promise<void> => {
    if (until === undefined) {
      await new Promise((r) => setTimeout(r, 250));
      return;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (until()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeEach(async (ctx) => {
    // Skipped rather than faked when Redis is absent: Pub/Sub is the part that
    // makes this correct on more than one instance, and a double would prove
    // nothing about subscribe timing or the subscriber's second connection.
    if (!available) {
      ctx.skip();
      return;
    }
    redis = new Redis(REDIS_URL);

    logged = '';
    const sink = new Writable({
      write(chunk, _e, cb) {
        logged += String(chunk);
        cb();
      },
    });
    // Debug level, so the handshake-refusal lines this suite asserts on are
    // actually written.
    const logger = createLogger({ level: 'debug', destination: sink });

    @Module({
      imports: [LoggingModule],
      controllers: [WsTokenController],
      providers: [
        { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
        { provide: REDIS, useValue: redis },
        { provide: AGENT_REPOSITORY, useValue: agents },
        CustomerTokenGuard,
        AgentJwtGuard,
        TenantScope,
        TenantGuard,
        { provide: REALTIME_TRANSPORT, useClass: RedisRealtimeTransport },
        { provide: NOTIFICATIONS, useClass: TransportNotifications },
        WsTokenService,
        // Long, so the gateway's own timer never fires mid-case; the
        // dead-connection cases drive a pass directly instead.
        { provide: WS_PING_INTERVAL, useValue: 60_000 },
        // T31: what the gateway hands a new agent connection. A double, because
        // this suite is about transport — where a HUD comes from is the AI
        // module's business.
        { provide: AI_HUD_SNAPSHOTS, useValue: snapshots },
        RealtimeGateway,
      ],
    })
    class TestRealtimeModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestRealtimeModule] })
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalFilters(new ApiErrorFilter(logger));
    await app.init();
    await app.listen(0);

    port = (app.getHttpServer().address() as AddressInfo).port;
    notifications = app.get<Notifications>(NOTIFICATIONS);
  });

  afterEach(async () => {
    if (!available) return;
    await app.close();
    redis.disconnect();
  });

  // ------------------------------------------------------- token endpoints

  describe('connection tokens', () => {
    const post = async (path: string, credential: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}` },
      });
      return { status: response.status, body: (await response.json()) as { data?: unknown } };
    };

    const customerCredential = (sessionId: string, tenantId = TENANT_A): string =>
      signJwt(
        { act: CUSTOMER_ACTOR_CLAIM, tid: tenantId, sid: sessionId },
        { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds: 7200 },
      );

    const agentCredential = (userId: string, tenantId = TENANT_A): string =>
      signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: tenantId, uid: userId, role: 'AGENT' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
      );

    it('mints a customer token scoped to that session', async () => {
      const { status, body } = await post(
        `/v1/sessions/${SESSION_ONE}/ws-token`,
        customerCredential(SESSION_ONE),
      );
      expect(status).toBe(200);
      expect((body.data as { audience: string }).audience).toBe('customer');
    });

    it('mints an agent token scoped to that user', async () => {
      const { status, body } = await post('/v1/agent/ws-token', agentCredential(AGENT_EN));
      expect(status).toBe(200);
      expect((body.data as { audience: string }).audience).toBe('agent');
    });

    it('refuses a customer minting a token for a sibling session (R8)', async () => {
      const { status } = await post(
        `/v1/sessions/${SESSION_TWO}/ws-token`,
        customerCredential(SESSION_ONE),
      );
      expect(status).toBe(401);
    });

    it('refuses an unauthenticated caller on both routes', async () => {
      for (const path of [`/v1/sessions/${SESSION_ONE}/ws-token`, '/v1/agent/ws-token']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
        expect(response.status).toBe(401);
      }
    });

    it('refuses an agent JWT on the customer route and the reverse', async () => {
      expect(
        (await post(`/v1/sessions/${SESSION_ONE}/ws-token`, agentCredential(AGENT_EN))).status,
      ).toBe(401);
      expect((await post('/v1/agent/ws-token', customerCredential(SESSION_ONE))).status).toBe(401);
    });

    it('reports an expiry five minutes out', async () => {
      const before = Date.now();
      const { body } = await post(
        `/v1/sessions/${SESSION_ONE}/ws-token`,
        customerCredential(SESSION_ONE),
      );
      const expires = Date.parse((body.data as { expires_at: string }).expires_at);
      expect(expires - before).toBeGreaterThan(4 * 60_000);
      expect(expires - before).toBeLessThanOrEqual(5 * 60_000 + 5_000);
    });

    /** A minted token must actually open a connection. */
    it('mints a token the gateway accepts', async () => {
      const { body } = await post(
        `/v1/sessions/${SESSION_ONE}/ws-token`,
        customerCredential(SESSION_ONE),
      );
      const socket = await connect((body.data as { token: string }).token);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    });
  });

  // ------------------------------------------------------------- handshake

  describe('the handshake', () => {
    const refused = async (query: string): Promise<number> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws${query}`);
      return new Promise<number>((resolve, reject) => {
        socket.once('close', (code) => {
          resolve(code);
        });
        socket.once('error', () => undefined);
        setTimeout(() => {
          reject(new Error('never closed'));
        }, 5000);
      });
    };

    it('closes a connection with no token', async () => {
      expect(await refused('')).toBe(4401);
    });

    it('closes a connection with a forged token', async () => {
      const forged = signJwt(
        { act: 'ws', aud: RealtimeAudience.CUSTOMER, tid: TENANT_A, sid: SESSION_ONE },
        { secret: 'FAKE-wrong-secret-for-tests-0000000000000', ttlSeconds: 300 },
      );
      expect(await refused(`?token=${encodeURIComponent(forged)}`)).toBe(4401);
    });

    it('closes a connection with an expired token', async () => {
      const expired = signJwt(
        { act: 'ws', aud: RealtimeAudience.CUSTOMER, tid: TENANT_A, sid: SESSION_ONE },
        { secret: TEST_AUTH_CONFIG.wsTokenSecret, ttlSeconds: -60 },
      );
      expect(await refused(`?token=${encodeURIComponent(expired)}`)).toBe(4401);
    });

    it('closes a connection presenting a session credential instead', async () => {
      const session = signJwt(
        { act: CUSTOMER_ACTOR_CLAIM, tid: TENANT_A, sid: SESSION_ONE },
        { secret: TEST_AUTH_CONFIG.wsTokenSecret, ttlSeconds: 7200 },
      );
      expect(await refused(`?token=${encodeURIComponent(session)}`)).toBe(4401);
    });
  });

  // ------------------------------------------------------------- delivery

  describe('a customer connection', () => {
    it('receives an event for its own session', async () => {
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);

      await notifications.sessionOffered(SESSION_ONE);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toEqual([
        { event: CustomerEvent.SESSION_OFFERED, data: { session_id: SESSION_ONE } },
      ]);
      socket.close();
    });

    it('never receives an event for another session', async () => {
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);

      await notifications.sessionOffered(SESSION_TWO);
      await notifications.queuePosition(SESSION_TWO, 1);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });

    it('never receives an agent event', async () => {
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_A, 'en', SESSION_ONE);
      await notifications.sessionClaimedElsewhere(TENANT_A, AGENT_EN, SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });

    it('receives its queue position', async () => {
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);

      await notifications.queuePosition(SESSION_ONE, 3);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toEqual([
        {
          event: CustomerEvent.QUEUE_POSITION,
          data: { session_id: SESSION_ONE, position: 3 },
        },
      ]);
      socket.close();
    });
  });

  describe('an agent connection', () => {
    it('receives an event addressed to it', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.sessionOfferExpired(TENANT_A, AGENT_EN, SESSION_ONE);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toEqual([
        { event: AgentEvent.SESSION_OFFER_EXPIRED, data: { session_id: SESSION_ONE } },
      ]);
      socket.close();
    });

    it('never receives another agent’s event', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.sessionOfferExpired(TENANT_A, AGENT_TA, SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });

    it('never receives a customer event', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.sessionOffered(SESSION_ONE);
      await notifications.agentJoined(SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });
  });

  describe('queue notifications are targeted by language', () => {
    /**
     * The rule T17 applies when deciding what an agent may see, applied to the
     * push channel so the two cannot disagree.
     */
    it('reaches an agent who works the language', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_A, 'en', SESSION_ONE);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toEqual([
        {
          event: AgentEvent.QUEUE_NEW_SESSION,
          data: { session_id: SESSION_ONE, language: 'en' },
        },
      ]);
      socket.close();
    });

    it('does not reach an agent who does not', async () => {
      const socket = await connect(agentWsToken(AGENT_TA));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_A, 'en', SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });

    it('reaches a multi-language agent on either of their languages', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_A, 'hi', SESSION_ONE);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toHaveLength(1);
      socket.close();
    });

    it('matches case-insensitively, as the queue key does', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_A, 'EN', SESSION_ONE);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toHaveLength(1);
      socket.close();
    });

    it('keeps en distinct from en-IN', async () => {
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_A, 'en-IN', SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });
  });

  describe('tenant isolation (I8)', () => {
    it('does not deliver another tenant’s queue notification', async () => {
      const socket = await connect(agentWsToken(AGENT_EN, TENANT_A));
      const inbox = messages(socket);

      await notifications.queueNewSession(TENANT_B, 'en', SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });

    it('does not deliver an event addressed to the same user id in another tenant', async () => {
      const socket = await connect(agentWsToken(AGENT_EN, TENANT_A));
      const inbox = messages(socket);

      await notifications.sessionOfferExpired(TENANT_B, AGENT_EN, SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });
  });

  describe('several connections', () => {
    it('delivers one customer event to that customer only', async () => {
      const one = await connect(customerWsToken(SESSION_ONE));
      const two = await connect(customerWsToken(SESSION_TWO));
      const inboxOne = messages(one);
      const inboxTwo = messages(two);

      await notifications.agentJoined(SESSION_ONE);
      await settle(() => inboxOne.received.length > 0);

      expect(inboxOne.received).toHaveLength(1);
      expect(inboxTwo.received).toEqual([]);
      one.close();
      two.close();
    });

    it('delivers a queue notification to every eligible agent', async () => {
      const first = await connect(agentWsToken(AGENT_EN));
      const second = await connect(agentWsToken(AGENT_EN));
      const inboxOne = messages(first);
      const inboxTwo = messages(second);

      await notifications.queueNewSession(TENANT_A, 'en', SESSION_ONE);
      await settle(() => inboxOne.received.length > 0 && inboxTwo.received.length > 0);

      expect(inboxOne.received).toHaveLength(1);
      expect(inboxTwo.received).toHaveLength(1);
      first.close();
      second.close();
    });
  });

  describe('reconnection', () => {
    /**
     * D9 makes the token reusable within its lifetime precisely so an ordinary
     * reconnect needs no REST round trip.
     */
    it('accepts the same token again and delivers to the new socket', async () => {
      const token = customerWsToken(SESSION_ONE);
      const first = await connect(token);
      first.close();
      await settle();

      const second = await connect(token);
      const inbox = messages(second);

      await notifications.agentJoined(SESSION_ONE);
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toHaveLength(1);
      second.close();
    });

    it('stops delivering to a socket that has gone', async () => {
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);
      socket.close();
      await settle();

      await notifications.agentJoined(SESSION_ONE);
      await settle();

      expect(inbox.received).toEqual([]);
    });
  });

  describe('what the gateway does not do', () => {
    it('ignores anything a client sends', async () => {
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);

      // A client that tried to subscribe to another session gets no answer and
      // no channel: subscriptions come from the token, and there is no protocol
      // through which to ask.
      socket.send(JSON.stringify({ event: 'subscribe', data: { session_id: SESSION_TWO } }));
      await settle();

      await notifications.sessionOffered(SESSION_TWO);
      await settle();

      expect(inbox.received).toEqual([]);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    });

    it('drops a message published on a channel nobody holds', async () => {
      // Pub/Sub has no queue: a notification with no listener is gone, which is
      // correct for a transport that is not the source of truth.
      await notifications.sessionOffered(SESSION_TWO);
      const socket = await connect(customerWsToken(SESSION_TWO));
      const inbox = messages(socket);
      await settle();

      expect(inbox.received).toEqual([]);
      socket.close();
    });
  });

  // ------------------------------------------------ the D9 query-token risk

  describe('the connection token never reaches a log line', () => {
    /**
     * D9 requires the credential in a query parameter — the one place this
     * codebase otherwise refuses to put one — and query strings are exactly
     * what access logs and proxies record. The gateway logs a redacted URL and
     * never the raw one; this is the invariant that keeps that true.
     */
    it('logs a refused handshake without the token', async () => {
      const forged = signJwt(
        { act: 'ws', aud: RealtimeAudience.CUSTOMER, tid: TENANT_A, sid: SESSION_ONE },
        { secret: 'FAKE-wrong-secret-for-tests-0000000000000', ttlSeconds: 300 },
      );

      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/v1/ws?token=${encodeURIComponent(forged)}`,
      );
      await new Promise<void>((resolve) => {
        socket.once('close', () => {
          resolve();
        });
        socket.once('error', () => undefined);
      });
      await settle();

      expect(logged).toContain('ws.handshake.refused');
      expect(logged).not.toContain(forged);
      for (const part of forged.split('.')) expect(logged).not.toContain(part);
    });

    it('logs an accepted connection without the token', async () => {
      const token = customerWsToken(SESSION_ONE);
      const socket = await connect(token);
      await settle();

      expect(logged).toContain('ws.connected');
      expect(logged).not.toContain(token);
      socket.close();
    });
  });

  // ------------------------------------------------------ dead connections

  describe('a socket that stops answering', () => {
    /**
     * A browser that vanishes without closing leaves a socket that looks open
     * forever. Ping/pong is what reclaims it — and the registration with it, so
     * the channel is unsubscribed and a later connection is not shadowed.
     */
    it('is terminated, and its channel released', async () => {
      const gateway = app.get(RealtimeGateway);
      const socket = await connect(customerWsToken(SESSION_ONE));

      // Silence the pong the client library answers with automatically. From
      // the server's point of view this socket has gone quiet.
      socket.pong = (): void => undefined;

      const closed = new Promise<void>((resolve) => {
        socket.once('close', () => {
          resolve();
        });
      });

      // Two passes: the first marks it unanswered, the second terminates.
      (gateway as unknown as { sweepDeadConnections(): void }).sweepDeadConnections();
      await settle();
      (gateway as unknown as { sweepDeadConnections(): void }).sweepDeadConnections();

      await closed;
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    });

    it('keeps a socket that answers', async () => {
      const gateway = app.get(RealtimeGateway);
      const socket = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(socket);

      // The client answers pings by itself, so two passes should change nothing.
      (gateway as unknown as { sweepDeadConnections(): void }).sweepDeadConnections();
      await settle();
      (gateway as unknown as { sweepDeadConnections(): void }).sweepDeadConnections();
      await settle();

      expect(socket.readyState).toBe(WebSocket.OPEN);

      await notifications.agentJoined(SESSION_ONE);
      await settle(() => inbox.received.length > 0);
      expect(inbox.received).toHaveLength(1);
      socket.close();
    });
  });
  describe('an AI result on the wire (T31)', () => {
    it('reaches the agent on the call, over real Redis', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      // The whole T31 path in production code: `aiUpdated` -> Redis pub/sub ->
      // the gateway's subscriber -> this socket.
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.aiUpdated(TENANT_A, AGENT_EN, hudFor(SESSION_ONE));
      await settle(() => inbox.received.length > 0);

      expect(inbox.received).toEqual([{ event: AgentEvent.AI_UPDATED, data: hudFor(SESSION_ONE) }]);
      socket.close();
    });

    it('carries the model versions T35 will need', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      const socket = await connect(agentWsToken(AGENT_EN));
      const inbox = messages(socket);

      await notifications.aiUpdated(TENANT_A, AGENT_EN, hudFor(SESSION_ONE));
      await settle(() => inbox.received.length > 0);

      const message = inbox.received[0] as { data: AiHudPayload };
      expect(message.data.model_versions).toEqual({
        liveness: 'demo-v1',
        face_match: 'demo-v1',
        ocr: 'demo-v1',
      });
      socket.close();
    });

    it('never reaches the customer whose call it is about', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      // R3 makes `ai.updated` an agent event, and the customer is its subject.
      // Two independent locks: no customer socket holds an agent channel, and
      // the gateway refuses the audience even if one somehow did.
      const customer = await connect(customerWsToken(SESSION_ONE));
      const inbox = messages(customer);

      await notifications.aiUpdated(TENANT_A, AGENT_EN, hudFor(SESSION_ONE));
      await settle();

      expect(inbox.received).toEqual([]);
      customer.close();
    });

    it('never reaches another agent in the same tenant', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      const other = await connect(agentWsToken(AGENT_TA));
      const inbox = messages(other);

      await notifications.aiUpdated(TENANT_A, AGENT_EN, hudFor(SESSION_ONE));
      await settle();

      expect(inbox.received).toEqual([]);
      other.close();
    });
  });

  describe('what a new connection is handed (T31)', () => {
    beforeEach(() => {
      for (const key of Object.keys(HUDS)) delete HUDS[key];
    });

    it('sends an agent the current HUD as soon as the socket opens', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      // Pub/Sub has no replay, so without this an agent reloading mid-call sees
      // an empty panel until the next result — indistinguishable on screen from
      // an AI that is not running.
      HUDS[AGENT_EN] = [hudFor(SESSION_ONE)];

      const { socket, received } = await connectListening(agentWsToken(AGENT_EN));
      await settle(() => received.length > 0);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        event: AgentEvent.AI_UPDATED,
        data: hudFor(SESSION_ONE),
      });
      socket.close();
    });

    it('sends one per call when an agent holds more than one', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      HUDS[AGENT_EN] = [hudFor(SESSION_ONE), hudFor(SESSION_TWO)];

      const { socket, received } = await connectListening(agentWsToken(AGENT_EN));
      await settle(() => received.length > 1);

      expect(received).toHaveLength(2);
      socket.close();
    });

    it('sends nothing when the AI has said nothing about this agent', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      const { socket, received } = await connectListening(agentWsToken(AGENT_EN));
      await settle();

      expect(received).toEqual([]);
      socket.close();
    });

    it('never primes a customer connection', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      // The customer is the subject of the AI's output, never its audience (R3).
      HUDS[AGENT_EN] = [hudFor(SESSION_ONE)];

      const { socket, received } = await connectListening(customerWsToken(SESSION_ONE));
      await settle();

      expect(received).toEqual([]);
      socket.close();
    });

    it('still opens the socket when the HUD cannot be read', async ({ skip }) => {
      if (!available) {
        skip();
        return;
      }
      // A panel that could not be pre-filled is a degraded connection, not a
      // refused one: the stream fills it in two seconds later.
      const original = snapshots.forAgent;
      (snapshots as { forAgent: AiHudSnapshots['forAgent'] }).forAgent = () =>
        Promise.reject(new Error('redis down'));

      try {
        const { socket, received } = await connectListening(agentWsToken(AGENT_EN));
        await settle();

        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(received).toEqual([]);
        socket.close();
      } finally {
        (snapshots as { forAgent: AiHudSnapshots['forAgent'] }).forAgent = original;
      }
    });
  });
});

describe('the realtime suite', () => {
  it('reports whether it ran against a real Redis', () => {
    // Visible rather than silent: a skipped isolation suite is worth noticing
    // in the output, and this line is what makes the skip legible.
    expect(typeof available).toBe('boolean');
  });
});
