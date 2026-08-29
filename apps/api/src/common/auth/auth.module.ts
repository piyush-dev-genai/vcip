import { Module } from '@nestjs/common';
import { AgentJwtGuard } from './agent-jwt.guard.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { API_KEY_STORE, DrizzleApiKeyStore } from './api-key.store.js';
import { AUTH_CONFIG, authConfigFromEnv } from './auth.config.js';
import { CustomerTokenGuard } from './customer-token.guard.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantScope } from './tenant-scope.js';

/**
 * Authentication and tenant authorization.
 *
 * The guards are providers rather than global filters: each route declares
 * which credential it accepts, because "any of the four will do" is not a
 * meaningful authorization statement.
 */
@Module({
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => authConfigFromEnv() },
    { provide: API_KEY_STORE, useClass: DrizzleApiKeyStore },
    ApiKeyGuard,
    CustomerTokenGuard,
    AgentJwtGuard,
    InternalTokenGuard,
    TenantScope,
    TenantGuard,
  ],
  exports: [
    AUTH_CONFIG,
    API_KEY_STORE,
    ApiKeyGuard,
    CustomerTokenGuard,
    AgentJwtGuard,
    InternalTokenGuard,
    TenantScope,
    TenantGuard,
  ],
})
export class AuthModule {}
