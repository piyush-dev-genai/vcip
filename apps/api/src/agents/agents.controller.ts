/**
 * Agent routes (T16, T17, T18).
 *
 * The guard list is the interesting part of each.
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
 * and there is no parameter through which that could be overridden. The claim
 * route takes a session id and nothing else — the one thing the caller is
 * entitled to choose.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { AgentAvailabilityRequest, AgentLoginRequest } from '@vcip/shared';
import {
  agentAvailabilitySchema,
  agentClaimSchema,
  agentHeartbeatSchema,
  agentLoginSchema,
} from '@vcip/shared';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { Auth } from '../common/auth/auth.decorators.js';
import type { Actor, AgentActor } from '../common/auth/auth-context.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import { Idempotent } from '../common/idempotency/idempotency.decorator.js';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import type { ClaimResult } from './agent-claim.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { AgentClaimService } from './agent-claim.service.js';
import type { AgentQueueResult } from './agent-queue.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { AgentQueueService } from './agent-queue.service.js';
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
    private readonly queue: AgentQueueService,
    private readonly claims: AgentClaimService,
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

  /**
   * The queued sessions this agent could work.
   *
   * A GET, and it behaves like one: no body, no query parameters, no
   * `Idempotency-Key`, and no write of any kind. The bound on the result is a
   * server constant, so there is no page size for a client to argue with and no
   * parameter through which one could ask for the whole queue.
   *
   * `TenantGuard` still runs, and it inspects the query string as well as the
   * body — so a `?tenant_id=` that disagrees with the token is a 403 rather
   * than something quietly ignored.
   */
  @Get('queue')
  @UseGuards(AgentJwtGuard, TenantGuard)
  async queueView(@Auth() actor: Actor): Promise<ApiData<AgentQueueResult>> {
    return data(await this.queue.view(asAgent(actor)));
  }

  /**
   * Claim a queued session: `QUEUED -> OFFERED` (T18).
   *
   * 200, not 201: no resource is created. The session already existed and this
   * moved it, which is also why `Idempotency-Key` is required — a retried claim
   * must not consume a second session, and D13's record is what makes the
   * replay return the original answer instead of a 409 against the agent's own
   * first attempt.
   *
   * The body is parsed as an empty `strictObject`, so a request trying to name
   * an `agent_id`, a `tenant_id`, or an offer expiry of its own is a 400. The
   * session id is the only thing the caller chooses, and `TenantGuard` still
   * rejects a `?tenant_id=` that disagrees with the token.
   */
  @Post('sessions/:id/claim')
  @HttpCode(200)
  @UseGuards(AgentJwtGuard, TenantGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent('POST /v1/agent/sessions/{id}/claim')
  async claimSession(
    @Auth() actor: Actor,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body(new ZodValidationPipe(agentClaimSchema)) _body: unknown,
  ): Promise<ApiData<ClaimResult>> {
    return data(await this.claims.claim(asAgent(actor), id));
  }
}
