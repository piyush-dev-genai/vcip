/**
 * The media-token surface through a real Nest application, over real HTTP.
 *
 * Everything between the socket and the datastore is production code: both
 * routes, T09's `CustomerTokenGuard`, `AgentJwtGuard`, `AnyOf` and
 * `TenantGuard`, T10's error filter, `MediaTokenService`, and the real
 * `LiveKitTokenMinter` signing with a test key pair. Only the session
 * repository is substituted, because a test that cannot run without PostgreSQL
 * is a test that stops being run.
 *
 * The minter is real on purpose. R1's whole risk is that two routes drift into
 * meaning different things, and the only way to see what a route actually
 * granted is to decode the token it returned.
 */

import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ErrorCode, SessionStatus } from '@vcip/shared';
import { TokenVerifier } from 'livekit-server-sdk';
import type { ClaimGrants, VideoGrant } from 'livekit-server-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ACTOR_CLAIM, AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { CUSTOMER_ACTOR_CLAIM, CustomerTokenGuard } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { signJwt } from '../common/auth/tokens.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import type {
  AcceptCommand,
  ClaimCommand,
  ClaimableSessionRow,
  CreateSessionInput,
  ExpiredOfferRow,
  GuardedUpdate,
  MediaTokenSessionRow,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import { SESSION_REPOSITORY } from '../sessions/session.repository.js';
import type { LiveKitConfig } from './livekit.config.js';
import { LIVEKIT_CONFIG } from './livekit.config.js';
import { MediaTokenController } from './media-token.controller.js';
import type { MediaParticipantMetadata } from './media-token.minter.js';
import { LiveKitTokenMinter, MEDIA_TOKEN_MINTER } from './media-token.minter.js';
import { MediaTokenService } from './media-token.service.js';

// ------------------------------------------------------------------ fixtures

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A1 = '00000000-0000-4000-8000-0000000000a1';
const AGENT_A2 = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';
const SIBLING = '22222222-2222-4222-8222-222222222222';
const ROOM = `vcip_${SESSION}`;

/** Never a real credential. 32+ characters where the config demands it. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-tests-0123456789',
  agentJwtSecret: 'FAKE-agent-secret-for-tests-9876543210ab',
  internalToken: 'FAKE-internal-token-for-tests-abcdefghij',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
};

const LIVEKIT: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'FAKE-livekit-secret-for-tests-0123456789',
  tokenTtlSeconds: 900,
};

const verifier = new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret);

// --------------------------------------------------------------------- fakes

/**
 * Only `findForMediaToken` is real. Every other method throws, which is what
 * proves over HTTP that this path reads one narrow projection and writes
 * nothing — a route that reached for `findById` or a mutation fails loudly.
 */
class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, MediaTokenSessionRow>();
  reads = 0;

  seed(session: MediaTokenSessionRow): void {
    this.rows.set(session.id, session);
  }

  findForMediaToken(tenantId: string, sessionId: string): Promise<MediaTokenSessionRow | null> {
    this.reads += 1;
    const found = this.rows.get(sessionId);
    if (found === undefined || found.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve(found);
  }

  create(_input: CreateSessionInput): Promise<SessionRow> {
    throw new Error('the media-token routes must not create a session');
  }

  update(_command: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('the media-token routes must not mutate a session');
  }

  claim(_command: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('the media-token routes must not claim a session');
  }

  accept(_command: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('the media-token routes must not accept a session');
  }

  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('the media-token routes must not sweep offers');
  }

  findById(): Promise<SessionRow | null> {
    throw new Error('the media-token routes read their own narrow projection');
  }

  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('the media-token routes must not read the claim projection');
  }

  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('the media-token routes must not read the queue projection');
  }

  countActiveWork(): Promise<number> {
    throw new Error('the media-token routes must not count an agent’s work');
  }
}

// ------------------------------------------------------------- application

const sessions = new FakeSessions();

@Module({
  imports: [LoggingModule],
  controllers: [MediaTokenController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    CustomerTokenGuard,
    AgentJwtGuard,
    TenantScope,
    TenantGuard,
    { provide: SESSION_REPOSITORY, useValue: sessions },
    { provide: LIVEKIT_CONFIG, useValue: LIVEKIT },
    { provide: MEDIA_TOKEN_MINTER, useClass: LiveKitTokenMinter },
    MediaTokenService,
  ],
})
class TestLivekitModule {}

const customerToken = (tenantId: string, sessionId: string): string =>
  signJwt(
    { act: CUSTOMER_ACTOR_CLAIM, tid: tenantId, sid: sessionId },
    { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds: 7200 },
  );

const agentToken = (tenantId: string, userId: string): string =>
  signJwt(
    { act: AGENT_ACTOR_CLAIM, tid: tenantId, uid: userId, role: 'AGENT' },
    { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
  );

const row = (over: Partial<MediaTokenSessionRow> = {}): MediaTokenSessionRow => ({
  id: SESSION,
  tenantId: TENANT_A,
  status: SessionStatus.IN_CALL,
  roomName: ROOM,
  agentId: AGENT_A1,
  ...over,
});

const CUSTOMER_PATH = `/v1/sessions/${SESSION}/media-token`;
const AGENT_PATH = `/v1/agent/sessions/${SESSION}/media-token`;

const video = (claims: ClaimGrants): VideoGrant => claims.video as VideoGrant;

describe('media tokens over HTTP', () => {
  let app: INestApplication;

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  beforeEach(async () => {
    sessions.rows.clear();
    sessions.reads = 0;

    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const logger = createLogger({ level: 'silent', destination: sink });

    const moduleRef = await Test.createTestingModule({ imports: [TestLivekitModule] })
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

  // ------------------------------------------------------- customer path

  describe('GET /v1/sessions/:id/media-token', () => {
    it('issues a token to the customer while QUEUED', async () => {
      sessions.seed(row({ status: SessionStatus.QUEUED, agentId: null }));

      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));

      expect(response.status).toBe(200);
      expect(response.body.data.room_name).toBe(ROOM);
      expect(typeof response.body.data.token).toBe('string');
    });

    it('issues a token to the customer while IN_CALL', async () => {
      sessions.seed(row());
      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      expect(response.status).toBe(200);
    });

    it('returns exactly the three fields contract §13 documents', async () => {
      sessions.seed(row());
      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      expect(Object.keys(response.body.data).sort()).toEqual(['expires_at', 'room_name', 'token']);
    });

    it('never leaks the LiveKit URL or key into the response', async () => {
      sessions.seed(row());
      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(LIVEKIT.url);
      expect(body).not.toContain(LIVEKIT.apiSecret);
    });

    it('reports an expiry fifteen minutes out', async () => {
      sessions.seed(row());
      const before = Date.now();
      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      const expires = Date.parse(response.body.data.expires_at as string);
      expect(expires - before).toBeGreaterThan(890_000);
      expect(expires - before).toBeLessThanOrEqual(900_000 + 5_000);
    });

    // --- negative: invalid customer states -------------------------------

    it.each([
      SessionStatus.CREATED,
      SessionStatus.OFFERED,
      SessionStatus.PREFLIGHT_FAILED,
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ])('409s the customer on a %s session', async (status) => {
      sessions.seed(row({ status, agentId: null }));

      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    });

    it('401s with no credential', async () => {
      sessions.seed(row());
      const response = await request(app.getHttpServer()).get(CUSTOMER_PATH);
      expect(response.status).toBe(401);
    });

    /**
     * R8: the token is bound to one session and can do nothing outside it.
     *
     * A 401, not a 404, and the guard is why — `CustomerTokenGuard` compares
     * the token's `sid` against the route parameter and rejects there, before
     * the service is reached. The same answer every other customer route gives
     * for the same mistake: the credential is valid, but not for this resource.
     * The service's own binding check stays as the second line, for the day a
     * route is mounted without that guard.
     */
    it('401s a customer holding a sibling session’s token, before any read', async () => {
      sessions.seed(row());
      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SIBLING));
      expect(response.status).toBe(401);
      expect(sessions.reads).toBe(0);
    });

    /**
     * Guards run before pipes, so an agent credential is what actually reaches
     * `ParseUUIDPipe` — a customer token would be rejected by the binding check
     * above first, for a malformed id as much as for a sibling's.
     */
    it('400s a non-UUID session id before any read', async () => {
      const response = await get(
        '/v1/sessions/not-a-uuid/media-token',
        agentToken(TENANT_A, AGENT_A1),
      );
      expect(response.status).toBe(400);
      expect(sessions.reads).toBe(0);
    });

    it('serves an agent of the same tenant, per §13’s two credentials', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));
      const response = await get(CUSTOMER_PATH, agentToken(TENANT_A, AGENT_A1));
      expect(response.status).toBe(200);
    });
  });

  // ---------------------------------------------------------- agent path

  describe('GET /v1/agent/sessions/:id/media-token', () => {
    it('issues a token to the assigned agent on an IN_CALL session', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      const response = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A1));

      expect(response.status).toBe(200);
      expect(response.body.data.room_name).toBe(ROOM);
    });

    /**
     * The negative this task exists for. Every agent in the tenant can already
     * read this session through `GET /v1/sessions/:id`; publishing video into
     * it is a different permission entirely.
     */
    it('409s an agent reaching for another agent’s IN_CALL session', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      const response = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A2));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
    });

    it('409s on the customer path too — the URL does not change the answer', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      const response = await get(CUSTOMER_PATH, agentToken(TENANT_A, AGENT_A2));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
    });

    it('409s an IN_CALL session that names no agent', async () => {
      sessions.seed(row({ agentId: null }));
      const response = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A1));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
    });

    it.each([
      SessionStatus.CREATED,
      SessionStatus.QUEUED,
      SessionStatus.OFFERED,
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ])('409s the agent on a %s session', async (status) => {
      sessions.seed(row({ status, agentId: AGENT_A1 }));

      const response = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A1));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    });

    it('401s a customer token on the agent path', async () => {
      sessions.seed(row());
      const response = await get(AGENT_PATH, customerToken(TENANT_A, SESSION));
      expect(response.status).toBe(401);
    });
  });

  // ------------------------------------------------------ tenant isolation

  describe('tenant isolation', () => {
    it('404s another tenant’s session', async () => {
      sessions.seed(row({ tenantId: TENANT_A, agentId: AGENT_A1 }));
      const response = await get(AGENT_PATH, agentToken(TENANT_B, AGENT_A1));
      expect(response.status).toBe(404);
    });

    it('answers an unknown id exactly as it answers a foreign one', async () => {
      sessions.seed(row({ tenantId: TENANT_A }));

      const foreign = await get(AGENT_PATH, agentToken(TENANT_B, AGENT_A1));
      const unknown = await get(
        `/v1/agent/sessions/${SIBLING}/media-token`,
        agentToken(TENANT_B, AGENT_A1),
      );

      expect(foreign.status).toBe(unknown.status);
      expect(foreign.body.error.code).toBe(unknown.body.error.code);
      expect(foreign.body.error.message).toBe(unknown.body.error.message);
    });
  });

  // ------------------------------------------------- what the token grants

  describe('the credential each route returns', () => {
    it('scopes the customer’s token to the room, as the customer', async () => {
      sessions.seed(row());

      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      const claims = await verifier.verify(response.body.data.token as string);

      expect(claims.sub).toBe('customer');
      expect(video(claims).room).toBe(ROOM);
      expect(video(claims).roomJoin).toBe(true);
    });

    it('scopes the agent’s token to the room, as the agent', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      const response = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A1));
      const claims = await verifier.verify(response.body.data.token as string);

      expect(claims.sub).toBe('agent');
      expect(video(claims).room).toBe(ROOM);
    });

    /**
     * R1's actual risk: two routes that quietly come to mean different things.
     * The same agent through both doors must get the same credential.
     */
    it('grants the same thing through both doors', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      const viaAgent = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A1));
      const viaCustomer = await get(CUSTOMER_PATH, agentToken(TENANT_A, AGENT_A1));

      const a = await verifier.verify(viaAgent.body.data.token as string);
      const b = await verifier.verify(viaCustomer.body.data.token as string);

      expect(a.sub).toBe(b.sub);
      expect(a.metadata).toBe(b.metadata);
      expect(video(a)).toEqual(video(b));
    });

    it('denies the control-plane scopes on both routes', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      for (const [path, token] of [
        [CUSTOMER_PATH, customerToken(TENANT_A, SESSION)],
        [AGENT_PATH, agentToken(TENANT_A, AGENT_A1)],
      ] as const) {
        const response = await get(path, token);
        const grant = video(await verifier.verify(response.body.data.token as string));
        expect(grant.roomCreate ?? false).toBe(false);
        expect(grant.roomAdmin ?? false).toBe(false);
        expect(grant.roomRecord ?? false).toBe(false);
        expect(grant.canPublishData ?? false).toBe(false);
        expect(grant.canUpdateOwnMetadata ?? false).toBe(false);
      }
    });

    it('carries the metadata T26 will read', async () => {
      sessions.seed(row({ agentId: AGENT_A1 }));

      const response = await get(AGENT_PATH, agentToken(TENANT_A, AGENT_A1));
      const claims = await verifier.verify(response.body.data.token as string);
      const metadata = JSON.parse(claims.metadata as string) as MediaParticipantMetadata;

      expect(metadata).toEqual({
        role: 'agent',
        session_id: SESSION,
        tenant_id: TENANT_A,
        user_id: AGENT_A1,
      });
    });
  });

  // --------------------------------------------------- absence of effects

  describe('what a media token does not do', () => {
    it('is repeatable, because it changes no state', async () => {
      sessions.seed(row());

      const first = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      const second = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.room_name).toBe(first.body.data.room_name);
    });

    it('needs no Idempotency-Key, unlike the six operations D13 protects', async () => {
      sessions.seed(row());
      const response = await get(CUSTOMER_PATH, customerToken(TENANT_A, SESSION));
      expect(response.status).toBe(200);
    });
  });
});
