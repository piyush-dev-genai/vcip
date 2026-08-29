import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/auth.module.js';
import { DbModule } from './common/db/db.module.js';
import { IdempotencyModule } from './common/idempotency/idempotency.module.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { RedisModule } from './common/redis/redis.module.js';
import { HealthModule } from './health/health.module';

/**
 * Root module of the Control API.
 *
 * LoggingModule is imported first: it installs the request-context middleware,
 * so correlation is established before any guard runs and every failure - the
 * authentication ones included - carries a request id.
 *
 * Business modules (tenants, sessions, queue, agents, checklist, billing,
 * livekit, realtime, exports, webhooks, internal) are added in later tasks.
 * See docs/05-development-plan.md section 6.1.
 */
@Module({
  imports: [LoggingModule, DbModule, RedisModule, AuthModule, IdempotencyModule, HealthModule],
})
export class AppModule {}
