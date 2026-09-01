import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { AGENT_REPOSITORY, DrizzleAgentRepository } from './agent.repository.js';
import { AgentAcceptService } from './agent-accept.service.js';
import { AgentClaimService } from './agent-claim.service.js';
import { AgentQueueService } from './agent-queue.service.js';
import { AgentWorkService } from './agent-work.service.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { PRESENCE_REPOSITORY, RedisPresenceRepository } from './presence.repository.js';
import { OfferSweeperController } from './offer-sweeper.controller.js';
import { OFFER_SWEEP_ENABLED, OfferSweeper } from './offer-sweeper.service.js';
import { PresenceService } from './presence.service.js';

/**
 * Agent identity and presence (T16).
 *
 * Its imports are its boundary, and the absences are the point: no sessions, no
 * queue, no billing, no LiveKit. This module authenticates an agent, records
 * whether that agent is here, and exposes the `BUSY` primitives T18/T19 will
 * drive. It assigns nothing.
 *
 * `AuthModule` supplies the JWT secret, `AgentJwtGuard`, and `TenantGuard`. The
 * database handle and the Redis client come from T09's and T11's global
 * modules — one connection each for the application, as D2 requires.
 *
 * `PresenceService` is exported because T18's claim and T19's accept will call
 * `markBusy`/`markAvailable` at the approved point. Nothing in T16 calls them.
 *
 * T17 adds two imports and no new I/O. `QueueModule` supplies T15's queue
 * projection — the same `QueueRepository` the customer side writes through, so
 * there is one ZSET implementation and one Redis client — and `SessionsModule`
 * exports `SESSION_REPOSITORY`, which is how the queue view confirms candidate
 * ids against PostgreSQL. Neither import brings a write path this module uses:
 * the agent queue is a read.
 *
 * T18 is the first write. It adds `IdempotencyModule`, because a claim is one
 * of the six operations D13 protects, and `TenantsModule`, for
 * `offer_timeout_seconds`. It reuses `SESSION_REPOSITORY` rather than reaching
 * for `SessionsService`: the claim is a single conditional UPDATE that the
 * customer lifecycle has no business in, and going through the repository port
 * keeps every SQL statement this module issues in files that already own SQL.
 * `QueueModule` is still read-only here — nothing in T18 removes, re-scores, or
 * repairs a queue member.
 *
 * `AgentWorkService` adds no imports either. It answers "what am I holding"
 * from the same `SESSION_REPOSITORY` and the same predicate the capacity check
 * counts, so the two cannot disagree about what holding work means.
 *
 * T19 and T20 add no imports. Accept is another conditional UPDATE through the
 * same repository port, and the offer sweeper needs only that port and
 * presence. The sweeper is the module's one non-request component: it has no
 * caller, runs across every tenant, and reaches HTTP solely through an
 * internal-token route kept for tests and operations.
 */
@Module({
  imports: [AuthModule, IdempotencyModule, QueueModule, SessionsModule, TenantsModule],
  controllers: [AgentsController, OfferSweeperController],
  providers: [
    { provide: AGENT_REPOSITORY, useClass: DrizzleAgentRepository },
    { provide: PRESENCE_REPOSITORY, useClass: RedisPresenceRepository },
    AgentsService,
    PresenceService,
    AgentQueueService,
    AgentWorkService,
    AgentClaimService,
    AgentAcceptService,
    // The timer runs in the application; test modules build their own graph
    // and leave it off, so no background pass fires between cases.
    { provide: OFFER_SWEEP_ENABLED, useValue: true },
    OfferSweeper,
  ],
  exports: [PresenceService, AGENT_REPOSITORY],
})
export class AgentsModule {}
