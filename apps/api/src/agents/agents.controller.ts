/**
 * Agent routes (T16).
 *
 * Three endpoints, and the guard list is the interesting part of each.
 *
 * `login` carries no guard because there is no credential yet — it is the route
 * that mints one. It therefore also carries no `TenantGuard`: there is no
 * authenticated tenant to compare a body against, and `tenant_slug` is not an
 * assertion of authority but a namespace selector that the password still has
 * to satisfy.
 *
 * `availability` and `heartbeat` carry `AgentJwtGuard` and then `TenantGuard`,
 * in that order, exactly as the customer routes do: authenticate, then reject
 * any request whose body tries to name a tenant. Neither accepts an enterprise
 * API key, a customer token, or the internal token — each route names the one
 * credential it takes, and `AnyOf` is not used here because there is no second
 * legitimate caller.
 *
 * No route in this file takes an agent id. The agent is whoever the JWT says,
 * and there is no parameter through which that could be overridden.
 */

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { AgentAvailabilityRequest, AgentLoginRequest } from '@vcip/shared';
import { agentAvailabilitySchema, agentHeartbeatSchema, agentLoginSchema } from '@vcip/shared';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { Auth } from '../common/auth/auth.decorators.js';
import type { Actor, AgentActor } from '../common/auth/auth-context.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import type { AgentLoginResult } from './agents.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { AgentsService } from './agents.service.js';
import type { AvailabilityResult, HeartbeatResult } from './presence.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { PresenceService } from './presence.service.js';

/**
 * Narrow the actor `AgentJwtGuard` already guaranteed.
 *
 * Same pattern as `asCustomer` in the sessions controller: the throw is a
 * wiring assertion, not a request-handling path, and it lets the service demand
 * an `AgentActor` instead of accepting the union and re-checking.
 */
const asAgent = (actor: Actor): AgentActor => {
  /* c8 ignore next */
  if (actor.kind !== 'agent') throw new Error('expected an agent actor');
  return actor;
};

@Controller('v1/agent')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly presence: PresenceService,
  ) {}

  /**
   * Exchange credentials for an agent JWT.
   *
   * 200, not 201: nothing was created. No `Idempotency-Key` either — logging in
   * twice mints two tokens, which is correct and harmless, and D13's idempotency
   * records exist to protect operations that must happen at most once.
   *
   * Login does not touch presence. The approved flow is login, then an explicit
   * availability call (§17): an agent who reopens a tab should not silently
   * become someone the queue can hand a customer to.
   */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(agentLoginSchema)) body: AgentLoginRequest,
  ): Promise<ApiData<AgentLoginResult>> {
    return data(await this.agents.login(body));
  }

  /** Set the authenticated agent's own availability. */
  @Post('availability')
  @HttpCode(200)
  @UseGuards(AgentJwtGuard, TenantGuard)
  async setAvailability(
    @Auth() actor: Actor,
    @Body(new ZodValidationPipe(agentAvailabilitySchema)) body: AgentAvailabilityRequest,
  ): Promise<ApiData<AvailabilityResult>> {
    return data(await this.presence.setAvailability(asAgent(actor), body.status));
  }

  /**
   * Refresh the authenticated agent's presence TTL.
   *
   * The body is parsed even though it has no fields: `agentHeartbeatSchema` is
   * an empty `strictObject`, so a client that tries to smuggle a `status` or an
   * `agent_id` through the high-frequency endpoint gets a 400 rather than
   * having it silently ignored.
   */
  @Post('heartbeat')
  @HttpCode(200)
  @UseGuards(AgentJwtGuard, TenantGuard)
  async heartbeat(
    @Auth() actor: Actor,
    @Body(new ZodValidationPipe(agentHeartbeatSchema)) _body: unknown,
  ): Promise<ApiData<HeartbeatResult>> {
    return data(await this.presence.heartbeat(asAgent(actor)));
  }
}
