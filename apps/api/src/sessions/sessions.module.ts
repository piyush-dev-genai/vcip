import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { EventsModule } from '../common/events/events.module.js';
import { GeoModule } from '../common/geo/geo.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { DrizzleSessionRepository, SESSION_REPOSITORY } from './session.repository.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/**
 * The customer session lifecycle.
 *
 * Its imports are its boundary, and the absences are deliberate: no agents, no
 * billing, no LiveKit. This module creates a session, records the customer's
 * gates, puts the session in the queue, reads state back, and ends a session
 * the customer abandons.
 *
 * `AuthModule` supplies the guards and the customer-token secret;
 * `IdempotencyModule` the interceptor for the three idempotent routes;
 * `TenantsModule` the preflight thresholds; `GeoModule` the `GeoProvider`;
 * `EventsModule` the append-only session-event writer (T13); `QueueModule` the
 * Redis queue projection (T15), which this module drives but does not own.
 */
@Module({
  imports: [AuthModule, IdempotencyModule, TenantsModule, GeoModule, EventsModule, QueueModule],
  controllers: [SessionsController],
  providers: [{ provide: SESSION_REPOSITORY, useClass: DrizzleSessionRepository }, SessionsService],
  exports: [SessionsService, SESSION_REPOSITORY],
})
export class SessionsModule {}
