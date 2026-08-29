/**
 * Customer session routes.
 *
 * Each route declares its own credential. There is no "any of the four will do"
 * default, because that is not a meaningful authorization statement — the
 * enterprise creates sessions, the customer drives one, and an agent reads one.
 *
 * Guard order matters and is the same everywhere: authenticate first, then
 * `TenantGuard`, which rejects a request whose body, query, or path asserts a
 * `tenant_id` disagreeing with the credential. Bodies are validated last, by a
 * pipe against the shared schema, so a malformed payload never reaches the
 * service.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  ConsentRequest,
  CreateSessionRequest,
  LocationRequest,
  PreflightRequest,
} from '@vcip/shared';
import { consentSchema, createSessionSchema, locationSchema, preflightSchema } from '@vcip/shared';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { ApiKeyGuard } from '../common/auth/api-key.guard.js';
import { AnyOf } from '../common/auth/any-of.guard.js';
import { Auth } from '../common/auth/auth.decorators.js';
import type { Actor, CustomerActor, EnterpriseActor } from '../common/auth/auth-context.js';
import { CustomerTokenGuard } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import { Idempotent } from '../common/idempotency/idempotency.decorator.js';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import type {
  AbortResult,
  ConsentResult,
  CreateSessionResult,
  LocationResultBody,
  PreflightResultBody,
} from './sessions.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { SessionsService } from './sessions.service.js';
import type { SessionView } from './session.view.js';

/**
 * Narrow the actor a guard already guaranteed.
 *
 * `ApiKeyGuard` only ever attaches an enterprise actor, so this cannot fail at
 * runtime; it exists so the service signature can demand `EnterpriseActor`
 * rather than accepting the union and re-checking. The throw is a wiring
 * assertion, not a request-handling path.
 */
const asEnterprise = (actor: Actor): EnterpriseActor => {
  /* c8 ignore next */
  if (actor.kind !== 'enterprise') throw new Error('expected an enterprise actor');
  return actor;
};

const asCustomer = (actor: Actor): CustomerActor => {
  /* c8 ignore next */
  if (actor.kind !== 'customer') throw new Error('expected a customer actor');
  return actor;
};

/** Rejects a non-UUID id before any query runs. */
const sessionIdParam = (): ParseUUIDPipe => new ParseUUIDPipe({ version: '4' });

@Controller('v1/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /**
   * Create a session (D14).
   *
   * Enterprise API key only — the key never reaches a customer browser, and the
   * customer receives the short-lived token in this response instead.
   */
  @Post()
  @UseGuards(ApiKeyGuard, TenantGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent('POST /v1/sessions')
  async create(
    @Auth() actor: Actor,
    @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionRequest,
  ): Promise<ApiData<CreateSessionResult>> {
    return data(await this.sessions.create(asEnterprise(actor), body));
  }

  @Post(':id/consent')
  @HttpCode(200)
  @UseGuards(CustomerTokenGuard, TenantGuard)
  async consent(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
    @Body(new ZodValidationPipe(consentSchema)) body: ConsentRequest,
  ): Promise<ApiData<ConsentResult>> {
    return data(await this.sessions.consent(asCustomer(actor), id, body));
  }

  /** Measurements in, server verdict out (D11). */
  @Post(':id/preflight')
  @HttpCode(200)
  @UseGuards(CustomerTokenGuard, TenantGuard)
  async preflight(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
    @Body(new ZodValidationPipe(preflightSchema)) body: PreflightRequest,
  ): Promise<ApiData<PreflightResultBody>> {
    return data(await this.sessions.preflight(asCustomer(actor), id, body));
  }

  /**
   * The client address reaches the service as an argument and stops there: it
   * resolves a country through the `GeoProvider` and is never stored or logged.
   */
  @Post(':id/location')
  @HttpCode(200)
  @UseGuards(CustomerTokenGuard, TenantGuard)
  async location(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
    @Body(new ZodValidationPipe(locationSchema)) body: LocationRequest,
    @Ip() ip: string,
  ): Promise<ApiData<LocationResultBody>> {
    return data(
      await this.sessions.location(asCustomer(actor), id, body, ip.length > 0 ? ip : null),
    );
  }

  /**
   * Read current state.
   *
   * The customer holding this session's token, or an agent of the same tenant.
   * `AnyOf` delegates to the real guards; it contains no credential logic of
   * its own.
   */
  @Get(':id')
  @UseGuards(AnyOf(CustomerTokenGuard, AgentJwtGuard), TenantGuard)
  async get(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
  ): Promise<ApiData<SessionView>> {
    return data(await this.sessions.get(actor, id));
  }

  /**
   * Customer-initiated termination.
   *
   * Idempotent (D13): a retried abort returns the original response rather than
   * racing the terminal transition a second time.
   */
  @Post(':id/abort')
  @HttpCode(200)
  @UseGuards(CustomerTokenGuard, TenantGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent('POST /v1/sessions/{id}/abort')
  async abort(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
  ): Promise<ApiData<AbortResult>> {
    return data(await this.sessions.abort(asCustomer(actor), id));
  }
}
