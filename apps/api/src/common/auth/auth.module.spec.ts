import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentJwtGuard } from './agent-jwt.guard.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { API_KEY_STORE } from './api-key.store.js';
import { AUTH_CONFIG, redactable } from './auth.config.js';
import { CustomerTokenGuard } from './customer-token.guard.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantScope } from './tenant-scope.js';

/**
 * Resolves every guard through the Nest DI container.
 *
 * The other specs construct guards directly — `new TenantGuard(new TenantScope())`
 * — which proves the logic but says nothing about whether Nest can build them.
 * A dependency imported with `import type` still satisfies the compiler and
 * still passes those tests, while erasing the injection token and making the
 * module unresolvable at boot. That happened once here; this is the guard
 * against it happening again.
 */

const testModule = () =>
  Test.createTestingModule({
    providers: [
      {
        provide: AUTH_CONFIG,
        useValue: redactable({
          customerTokenSecret: 'c'.repeat(40),
          agentJwtSecret: 'a'.repeat(40),
          internalToken: 'i'.repeat(40),
          customerTokenTtlSeconds: 7200,
          agentJwtTtlSeconds: 43200,
        }),
      },
      { provide: API_KEY_STORE, useValue: { findByPrefix: () => Promise.resolve(null) } },
      ApiKeyGuard,
      CustomerTokenGuard,
      AgentJwtGuard,
      InternalTokenGuard,
      TenantScope,
      TenantGuard,
    ],
  }).compile();

describe('auth providers resolve through the DI container', () => {
  it.each([
    ['ApiKeyGuard', ApiKeyGuard],
    ['CustomerTokenGuard', CustomerTokenGuard],
    ['AgentJwtGuard', AgentJwtGuard],
    ['InternalTokenGuard', InternalTokenGuard],
    ['TenantScope', TenantScope],
    ['TenantGuard', TenantGuard],
  ])('resolves %s', async (_name, token) => {
    const moduleRef = await testModule();
    expect(moduleRef.get(token)).toBeDefined();
  });

  it('injects TenantScope into TenantGuard as a real instance', async () => {
    // The specific failure this exists for: a type-only import leaves the
    // parameter undefined at run time rather than failing to compile.
    const moduleRef = await testModule();
    const guard = moduleRef.get(TenantGuard);
    const scope = (guard as unknown as { tenantScope: unknown }).tenantScope;
    expect(scope).toBeInstanceOf(TenantScope);
  });

  it('gives every guard a working canActivate', async () => {
    const moduleRef = await testModule();
    for (const token of [
      ApiKeyGuard,
      CustomerTokenGuard,
      AgentJwtGuard,
      InternalTokenGuard,
      TenantGuard,
    ]) {
      const guard = moduleRef.get(token) as { canActivate?: unknown };
      expect(typeof guard.canActivate).toBe('function');
    }
  });
});
