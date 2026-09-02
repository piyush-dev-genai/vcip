/**
 * `GET /v1/agent/sessions/:id/checklist` through a real Nest application (T33).
 *
 * Everything between the socket and the repository is production code: the
 * agent JWT guard, the tenant guard, the UUID pipe, the service, the error
 * filter, the response envelope. Only PostgreSQL is a double — the query is one
 * `LEFT JOIN` and what this suite is about is the four answers built on top of
 * it, which are the ones a portal and an auditor actually see.
 *
 * The four:
 *
 *   - a session in another tenant is **404**, not 403, so an id cannot be
 *     confirmed to exist by probing;
 *   - a colleague's session is **403** — the agent is authenticated and the
 *     session is theirs to see in the queue, but the checklist is not;
 *   - a session with no pinned template, or a template that is not a
 *     checklist, is **500** and never a usable-looking empty list;
 *   - the assigned agent gets the pinned template in any status.
 */

import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ErrorCode } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ACTOR_CLAIM, AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { CUSTOMER_ACTOR_CLAIM } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { signJwt } from '../common/auth/tokens.js';
import { ApiErrorFilter } from '../common/errors/api-error.filter.js';
import { createLogger } from '../common/logging/logger.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { LOGGER } from '../common/logging/logging.tokens.js';
import { ChecklistController } from './checklist.controller.js';
import type { ChecklistRepository, ChecklistSessionRow } from './checklist.repository.js';
import { CHECKLIST_REPOSITORY } from './checklist.repository.js';
import { ChecklistService } from './checklist.service.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A1 = '00000000-0000-4000-8000-0000000000a1';
const AGENT_A2 = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';
const TEMPLATE = '22222222-2222-4222-8222-222222222222';

/** Never a real credential. 32+ characters where `auth.config.ts` demands it. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-tests-0123456789',
  agentJwtSecret: 'FAKE-agent-secret-for-tests-9876543210ab',
  internalToken: 'FAKE-internal-token-for-tests-abcdefghij',
  wsTokenSecret: 'FAKE-ws-secret-for-tests-abcdefghijklmnop',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
  wsTokenTtlSeconds: 300,
} as unknown as AuthConfig;

/** The seeded checklist, as `06-database-schema.md` §10 defines it. */
const SEEDED_ITEMS = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
  { key: 'customer_verified', label: 'Customer verified', required: true },
];

const row = (over: Partial<ChecklistSessionRow> = {}): ChecklistSessionRow => ({
  sessionId: SESSION,
  tenantId: TENANT_A,
  assignedAgentId: AGENT_A1,
  templateId: TEMPLATE,
  version: 1,
  items: SEEDED_ITEMS,
  ...over,
});

class FakeChecklistRepository implements ChecklistRepository {
  stored: ChecklistSessionRow | null = row();

  findForSession(tenantId: string, sessionId: string): Promise<ChecklistSessionRow | null> {
    // The real query is tenant-scoped in SQL, so a row from another tenant is
    // never loaded. Reproduced here, or the 404-versus-403 assertions below
    // would be testing the fake rather than the predicate.
    const found =
      this.stored?.tenantId === tenantId && this.stored.sessionId === sessionId
        ? this.stored
        : null;
    return Promise.resolve(found);
  }
}

const agentJwt = (tenantId: string, userId: string): string =>
  signJwt(
    { act: AGENT_ACTOR_CLAIM, tid: tenantId, uid: userId, role: 'AGENT' },
    { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: 3600 },
  );

const customerToken = (tenantId: string, sessionId: string): string =>
  signJwt(
    { act: CUSTOMER_ACTOR_CLAIM, tid: tenantId, sid: sessionId },
    { secret: TEST_AUTH_CONFIG.customerTokenSecret, ttlSeconds: 7200 },
  );

let repository: FakeChecklistRepository;

@Module({
  imports: [LoggingModule],
  controllers: [ChecklistController],
  providers: [
    { provide: AUTH_CONFIG, useValue: TEST_AUTH_CONFIG },
    { provide: CHECKLIST_REPOSITORY, useValue: undefined },
    AgentJwtGuard,
    TenantGuard,
    TenantScope,
    ChecklistService,
  ],
})
class TestModule {}

describe('reading a session checklist over HTTP', () => {
  let app: INestApplication;

  const get = (sessionId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/v1/agent/sessions/${sessionId}/checklist`)
      .set('Authorization', `Bearer ${token}`);

  beforeEach(async () => {
    repository = new FakeChecklistRepository();

    const sink = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [TestModule] })
      .overrideProvider(CHECKLIST_REPOSITORY)
      .useValue(repository)
      .overrideProvider(LOGGER)
      .useValue(createLogger({ level: 'silent', destination: sink }))
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiErrorFilter(createLogger({ level: 'silent', destination: sink })));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('the assigned agent', () => {
    it('gets the pinned template', async () => {
      const response = await get(SESSION, agentJwt(TENANT_A, AGENT_A1));

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        session_id: SESSION,
        template_id: TEMPLATE,
        version: 1,
        items: SEEDED_ITEMS,
      });
    });

    it('gets it in any status, including after the verdict', async () => {
      // The deliberate difference from a media token, which is confined to
      // IN_CALL. "What exactly did I confirm" is asked after the fact.
      repository.stored = row();

      expect((await get(SESSION, agentJwt(TENANT_A, AGENT_A1))).status).toBe(200);
    });

    it('is told the version, not just the items', async () => {
      // Which checklist a verification was judged against has to be answerable
      // from the response the portal received.
      repository.stored = row({ version: 7 });

      expect((await get(SESSION, agentJwt(TENANT_A, AGENT_A1))).body.data.version).toBe(7);
    });
  });

  describe('everyone else', () => {
    it('refuses a colleague with 403', async () => {
      const response = await get(SESSION, agentJwt(TENANT_A, AGENT_A2));

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('refuses an unassigned session with 403', async () => {
      repository.stored = row({ assignedAgentId: null });

      expect((await get(SESSION, agentJwt(TENANT_A, AGENT_A1))).status).toBe(403);
    });

    it('answers 404 for another tenant, never 403', async () => {
      // A 403 would confirm the id exists somewhere.
      const response = await get(SESSION, agentJwt(TENANT_B, AGENT_A1));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('answers 404 for a session that does not exist', async () => {
      repository.stored = null;

      expect((await get(SESSION, agentJwt(TENANT_A, AGENT_A1))).status).toBe(404);
    });

    it('rejects a customer token', async () => {
      // There is no customer door onto this route. The checklist is the list of
      // things an agent is about to attest to.
      const response = await get(SESSION, customerToken(TENANT_A, SESSION));

      expect(response.status).toBe(401);
    });

    it('rejects a missing or expired credential', async () => {
      const expired = signJwt(
        { act: AGENT_ACTOR_CLAIM, tid: TENANT_A, uid: AGENT_A1, role: 'AGENT' },
        { secret: TEST_AUTH_CONFIG.agentJwtSecret, ttlSeconds: -60 },
      );

      expect(
        (await request(app.getHttpServer()).get(`/v1/agent/sessions/${SESSION}/checklist`)).status,
      ).toBe(401);
      expect((await get(SESSION, expired)).status).toBe(401);
    });

    it('rejects a non-UUID session id before any query runs', async () => {
      const response = await get('not-a-uuid', agentJwt(TENANT_A, AGENT_A1));

      expect(response.status).toBe(400);
    });
  });

  describe('a template that cannot be served', () => {
    it('answers 500 when nothing is pinned, not an empty list', async () => {
      // The column is nullable, so this is representable — but it means a
      // tenant that was never configured, not a verification with no checks.
      repository.stored = row({ templateId: null, version: null, items: null });

      const response = await get(SESSION, agentJwt(TENANT_A, AGENT_A1));

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('answers 500 when the stored template is not a checklist', async () => {
      repository.stored = row({ items: [{ key: 'face_visible' }] });

      expect((await get(SESSION, agentJwt(TENANT_A, AGENT_A1))).status).toBe(500);
    });

    it('never serves a partial list', async () => {
      // Dropping the bad item and keeping the good one would let a verdict be
      // submitted against fewer required items than the tenant configured.
      repository.stored = row({
        items: [SEEDED_ITEMS[0], { key: 'BROKEN', label: '', required: 'yes' }],
      });

      expect((await get(SESSION, agentJwt(TENANT_A, AGENT_A1))).status).toBe(500);
    });

    it('does not leak the template into the error body', async () => {
      repository.stored = row({ items: [{ key: 'internal_only_label', secret: 'x' }] });

      const response = await get(SESSION, agentJwt(TENANT_A, AGENT_A1));

      expect(JSON.stringify(response.body)).not.toContain('internal_only_label');
    });
  });
});
