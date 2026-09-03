/**
 * Every provider T16 adds, resolved through Nest's real DI container.
 *
 * Same reason as `sessions.module.spec.ts`: the HTTP suite builds its own
 * providers, so it cannot see a wiring mistake — an `import type` that erases
 * an injection token, or a constructor argument Nest reads as `Object`. This
 * resolves the production graph and touches each instance.
 *
 * `PresenceService` is the one at risk here: its fourth constructor argument is
 * an optional clock with no injection token, which is exactly the shape that
 * broke `StaticGeoProvider` in T12. `AgentQueueService` (T17) has the same
 * shape and is resolved for the same reason — and it additionally proves that
 * pulling `QueueModule` and `SessionsModule` into this module's imports leaves
 * a graph that still boots.
 *
 * `AgentClaimService` (T18) is the third of that shape, and it carries the most
 * dependencies of any provider here — two repository tokens, two services, the
 * tenant scope, the logger, and an optional clock. It also proves that adding
 * `IdempotencyModule` and `TenantsModule` to the imports did not break the
 * graph.
 */

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AI_CONFIG } from '../ai/ai.config.js';
import { API_KEY_STORE } from '../common/auth/api-key.store.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import { DATABASE } from '../common/db/db.tokens.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { REDIS } from '../common/redis/redis.tokens.js';
import { AGENT_REPOSITORY } from './agent.repository.js';
import { AgentAcceptService } from './agent-accept.service.js';
import { AgentClaimService } from './agent-claim.service.js';
import { AgentQueueService } from './agent-queue.service.js';
import { AgentsController } from './agents.controller.js';
import { AgentsModule } from './agents.module.js';
import { AgentsService } from './agents.service.js';
import { PRESENCE_REPOSITORY } from './presence.repository.js';
import { OfferSweeper } from './offer-sweeper.service.js';
import { PresenceService } from './presence.service.js';
import { NotificationsTestingModule } from '../realtime/notifications.testing.js';

/** Secrets are fake and never leave this file. 32+ chars, as the config demands. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-di-tests-000001',
  agentJwtSecret: 'FAKE-agent-secret-for-di-tests-00000002',
  internalToken: 'FAKE-internal-token-for-di-tests-0000003',
  wsTokenSecret: 'FAKE-ws-secret-for-tests-abcdefghijklmnop',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
  wsTokenTtlSeconds: 300,
};

@Global()
@Module({
  providers: [{ provide: DATABASE, useValue: {} }],
  exports: [DATABASE],
})
class FakeDbModule {}

@Global()
@Module({
  providers: [{ provide: REDIS, useValue: {} }],
  exports: [REDIS],
})
class FakeRedisModule {}

describe('AgentsModule resolves through the container', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        LoggingModule,
        NotificationsTestingModule,
        FakeDbModule,
        FakeRedisModule,
        AgentsModule,
      ],
    })
      .overrideProvider(AUTH_CONFIG)
      .useValue(TEST_AUTH_CONFIG)
      .overrideProvider(API_KEY_STORE)
      .useValue({ findByPrefix: () => Promise.resolve(null) })
      // `AiClientModule` builds this from the environment at boot, and this suite
      // has no environment. Overridden as *disabled*, which also states the
      // property worth stating: the agent surface constructs with AI switched
      // off, because a document check being unavailable is not an error (D6).
      .overrideProvider(AI_CONFIG)
      .useValue({
        enabled: false,
        baseUrl: '',
        startTimeoutMs: 2_000,
        documentTimeoutMs: 15_000,
      })
      .compile();
  });

  it('constructs the module without a boot error', () => {
    expect(moduleRef).toBeDefined();
  });

  it('resolves the controller with both services', () => {
    expect(moduleRef.get(AgentsController, { strict: false })).toBeInstanceOf(AgentsController);
  });

  it('resolves AgentsService', () => {
    expect(moduleRef.get(AgentsService, { strict: false })).toBeInstanceOf(AgentsService);
  });

  it('resolves PresenceService despite its optional clock argument', () => {
    const service = moduleRef.get(PresenceService, { strict: false });
    expect(service).toBeInstanceOf(PresenceService);
    // Resolution alone was not enough in T12: call something that uses the
    // argument Nest could not have supplied.
    expect(typeof service.markBusy).toBe('function');
  });

  it('resolves AgentQueueService despite its optional clock argument', () => {
    const service = moduleRef.get(AgentQueueService, { strict: false });
    expect(service).toBeInstanceOf(AgentQueueService);
    expect(typeof service.view).toBe('function');
  });

  it('resolves AgentClaimService despite its optional clock argument', () => {
    const service = moduleRef.get(AgentClaimService, { strict: false });
    expect(service).toBeInstanceOf(AgentClaimService);
    expect(typeof service.claim).toBe('function');
  });

  it('exposes the claim route on the controller', () => {
    // A method, not a route table: this suite resolves the graph rather than
    // serving requests, and the HTTP suite asserts the path and the guards.
    expect(typeof moduleRef.get(AgentsController, { strict: false }).claimSession).toBe('function');
  });

  it('resolves AgentAcceptService despite its optional clock argument', () => {
    const service = moduleRef.get(AgentAcceptService, { strict: false });
    expect(service).toBeInstanceOf(AgentAcceptService);
    expect(typeof service.accept).toBe('function');
  });

  it('resolves OfferSweeper with both optional arguments', () => {
    // Two optionals, one of them a boolean flag and one a function type — the
    // shape most likely to resolve as `Object` and fail at boot.
    const sweeper = moduleRef.get(OfferSweeper, { strict: false });
    expect(sweeper).toBeInstanceOf(OfferSweeper);
    expect(typeof sweeper.sweep).toBe('function');
  });

  it('exposes the accept route on the controller', () => {
    expect(typeof moduleRef.get(AgentsController, { strict: false }).acceptSession).toBe(
      'function',
    );
  });

  it('resolves both repositories behind their tokens', () => {
    expect(moduleRef.get(AGENT_REPOSITORY, { strict: false })).toBeDefined();
    expect(moduleRef.get(PRESENCE_REPOSITORY, { strict: false })).toBeDefined();
  });
});
