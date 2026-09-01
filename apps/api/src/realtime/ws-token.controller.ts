/**
 * The two connection-token routes (T27, D9).
 *
 * Declared in one controller for the reason T24's media-token pair is: they
 * mint the same kind of credential and differ only in the scope they take from
 * the caller, so keeping them together makes that the only difference rather
 * than something a reviewer has to check across two files.
 *
 * `@Controller()` carries no prefix because the two paths share none.
 *
 * The guards are the whole authorization story. D9 says the token is minted by
 * an endpoint the caller is already authorised to use, so these routes grant
 * nothing new: a customer who cannot pass `CustomerTokenGuard` for this session
 * could not read it either, and an agent without a JWT has nothing to connect
 * with. Neither route accepts the enterprise API key or the internal token.
 *
 * `POST`, not `GET`: minting a credential is not a read, and a token in a
 * response to a cacheable verb is a token in a cache.
 */

import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { Auth } from '../common/auth/auth.decorators.js';
import type { Actor, AgentActor, CustomerActor } from '../common/auth/auth-context.js';
import { CustomerTokenGuard } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import type { WsTokenResult } from './ws-token.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { WsTokenService } from './ws-token.service.js';

/** Narrow what the guard already guaranteed. A wiring assertion, not a path. */
const asCustomer = (actor: Actor): CustomerActor => {
  /* c8 ignore next */
  if (actor.kind !== 'customer') throw new Error('expected a customer actor');
  return actor;
};

const asAgent = (actor: Actor): AgentActor => {
  /* c8 ignore next */
  if (actor.kind !== 'agent') throw new Error('expected an agent actor');
  return actor;
};

const sessionIdParam = (): ParseUUIDPipe => new ParseUUIDPipe({ version: '4' });

@Controller()
export class WsTokenController {
  constructor(private readonly tokens: WsTokenService) {}

  /**
   * A customer's connection token.
   *
   * `CustomerTokenGuard` alone — not `AnyOf(...)` as the media-token route
   * uses. An agent has their own endpoint below, and their connection is
   * user-scoped rather than session-scoped, so there is no meaning to an agent
   * minting a *session*-scoped connection token.
   *
   * The path `:id` is only ever checked, never used: the guard rejects a
   * request whose token names a different session (R8), and the token is signed
   * from the actor.
   */
  @Post('v1/sessions/:id/ws-token')
  @HttpCode(200)
  @UseGuards(CustomerTokenGuard, TenantGuard)
  wsTokenForSession(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) _id: string,
  ): ApiData<WsTokenResult> {
    return data(this.tokens.forCustomer(asCustomer(actor)));
  }

  /**
   * An agent's connection token.
   *
   * No session id: an agent's connection is scoped to tenant plus user and
   * outlives any one session (D9).
   */
  @Post('v1/agent/ws-token')
  @HttpCode(200)
  @UseGuards(AgentJwtGuard, TenantGuard)
  wsTokenForAgent(@Auth() actor: Actor): ApiData<WsTokenResult> {
    return data(this.tokens.forAgent(asAgent(actor)));
  }
}
