import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { AGENT_REPOSITORY, DrizzleAgentRepository } from './agent.repository.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { PRESENCE_REPOSITORY, RedisPresenceRepository } from './presence.repository.js';
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
 */
@Module({
  imports: [AuthModule],
  controllers: [AgentsController],
  providers: [
    { provide: AGENT_REPOSITORY, useClass: DrizzleAgentRepository },
    { provide: PRESENCE_REPOSITORY, useClass: RedisPresenceRepository },
    AgentsService,
    PresenceService,
  ],
  exports: [PresenceService, AGENT_REPOSITORY],
})
export class AgentsModule {}
