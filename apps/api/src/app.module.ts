import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/auth.module.js';
import { DbModule } from './common/db/db.module.js';
import { HealthModule } from './health/health.module';

/**
 * Root module of the Control API.
 *
 * Business modules (tenants, sessions, queue, agents, checklist, billing,
 * livekit, realtime, exports, webhooks, internal) are added in later tasks.
 * See docs/05-development-plan.md section 6.1.
 */
@Module({
  imports: [DbModule, AuthModule, HealthModule],
})
export class AppModule {}
