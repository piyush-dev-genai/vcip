import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

/**
 * Root module of the Control API.
 *
 * Business modules (tenants, sessions, queue, agents, checklist, billing,
 * livekit, realtime, exports, webhooks, internal) are added in later tasks.
 * See docs/05-development-plan.md section 6.1.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
