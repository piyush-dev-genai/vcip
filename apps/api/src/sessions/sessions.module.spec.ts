/**
 * Every provider T12 adds, resolved through Nest's real DI container.
 *
 * This exists because of a boot failure the rest of the suite could not see.
 * `StaticGeoProvider` took `env: NodeJS.ProcessEnv = process.env`, which is
 * harmless to construct by hand and fatal to construct through the container:
 * Nest reads `design:paramtypes`, sees `Object`, and fails with "can't resolve
 * dependencies of the StaticGeoProvider (?)". Eighty-eight passing HTTP tests
 * said nothing, because they build the providers themselves.
 *
 * The same class of bug already hit `tenant.guard.ts` in T09, where an
 * `import type` erased an injection token. The lesson is the same both times:
 * a unit test that constructs a provider directly cannot prove the container
 * can. So these tests resolve through `Test.createTestingModule` and touch each
 * instance, and nothing here asserts behaviour — that is the HTTP suite's job.
 */

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_CONFIG } from '../common/auth/auth.config.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { API_KEY_STORE } from '../common/auth/api-key.store.js';
import { DATABASE } from '../common/db/db.tokens.js';
import { GeoModule } from '../common/geo/geo.module.js';
import type { GeoProvider } from '../common/geo/geo.provider.js';
import { GEO_PROVIDER } from '../common/geo/geo.provider.js';
import { LoggingModule } from '../common/logging/logging.module.js';
import { REDIS } from '../common/redis/redis.tokens.js';
import { TENANT_CONFIG_STORE } from '../tenants/tenant-config.store.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { TenantsService } from '../tenants/tenants.service.js';
import { SESSION_REPOSITORY } from './session.repository.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

/** Secrets are fake and never leave this file. 32+ chars, as the config demands. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: 'FAKE-customer-secret-for-di-tests-000001',
  agentJwtSecret: 'FAKE-agent-secret-for-di-tests-00000002',
  internalToken: 'FAKE-internal-token-for-di-tests-0000003',
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
};

/**
 * Stands in for `DbModule`, which is `@Global()` and would open a real
 * connection. Only the token has to exist for the graph to resolve.
 */
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

describe('SessionsModule resolves through the container', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [LoggingModule, FakeDbModule, FakeRedisModule, SessionsModule],
    })
      // The two providers that would otherwise reach a real datastore. Every
      // other provider in the graph is the production one.
      .overrideProvider(AUTH_CONFIG)
      .useValue(TEST_AUTH_CONFIG)
      .overrideProvider(API_KEY_STORE)
      .useValue({ findByPrefix: () => Promise.resolve(null) })
      .compile();
  });

  it('constructs the module without a boot error', () => {
    expect(moduleRef).toBeDefined();
  });

  it('resolves SessionsService with all five of its dependencies', () => {
    const service = moduleRef.get(SessionsService, { strict: false });
    expect(service).toBeInstanceOf(SessionsService);
  });

  it('resolves the controller', () => {
    expect(moduleRef.get(SessionsController, { strict: false })).toBeInstanceOf(SessionsController);
  });

  it('resolves the session repository behind its token', () => {
    expect(moduleRef.get(SESSION_REPOSITORY, { strict: false })).toBeDefined();
  });

  it('resolves the tenant config store and service', () => {
    expect(moduleRef.get(TENANT_CONFIG_STORE, { strict: false })).toBeDefined();
    expect(moduleRef.get(TenantsService, { strict: false })).toBeInstanceOf(TenantsService);
  });

  it('resolves the geo provider, and the instance actually works', async () => {
    // Resolution alone was not enough to catch the original bug's cousin: a
    // provider can resolve and still be misconfigured. Calling it proves the
    // constructor ran with a real environment.
    const geo = moduleRef.get<GeoProvider>(GEO_PROVIDER, { strict: false });
    const decision = await geo.resolve('203.0.113.9');
    expect(decision.allowed).toBe(true);
    expect(decision.country === null || /^[A-Z]{2}$/.test(decision.country)).toBe(true);
  });
});

describe('the smaller modules resolve on their own', () => {
  it('GeoModule resolves standalone', async () => {
    const ref = await Test.createTestingModule({ imports: [GeoModule] }).compile();
    expect(ref.get(GEO_PROVIDER, { strict: false })).toBeDefined();
  });

  it('TenantsModule resolves standalone', async () => {
    const ref = await Test.createTestingModule({
      imports: [FakeDbModule, TenantsModule],
    }).compile();
    expect(ref.get(TenantsService, { strict: false })).toBeInstanceOf(TenantsService);
  });
});
