/**
 * The media-token routes (T24, R1).
 *
 * R1 records that the contract has two endpoints for one operation —
 * `GET /v1/sessions/:id/media-token` and `GET /v1/agent/sessions/:id/media-token`
 * — and that the agent path delegates to the same handler. Both are declared
 * here, in one controller, rather than one on `SessionsController` and one on
 * `AgentsController`. Two handlers in two files is how a duplicate pair drifts:
 * a rule tightened on one path and forgotten on the other is a hole that looks
 * like nothing in review. Here, sharing the implementation is structural.
 *
 * `@Controller()` carries no prefix because the two paths share none. The full
 * path is on each method.
 *
 * The guards differ, and the difference is the only thing the two routes do not
 * share:
 *
 *   - The customer path takes either credential, per contract §13
 *     ("customer session token or authorized agent JWT"), so an agent already
 *     holding a session id need not switch URLs.
 *   - The agent path takes an agent JWT only. A customer token would be
 *     meaningless on it, and `AnyOf` there would advertise a customer route
 *     under `/v1/agent` for no gain.
 *
 * Neither route accepts the enterprise API key or the internal token, and
 * neither takes a body or a query parameter. The session id is the one thing a
 * caller chooses; the role is read from the credential.
 */

import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { AnyOf } from '../common/auth/any-of.guard.js';
import { Auth } from '../common/auth/auth.decorators.js';
import type { Actor } from '../common/auth/auth-context.js';
import { CustomerTokenGuard } from '../common/auth/customer-token.guard.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import type { MediaTokenActor, MediaTokenResult } from './media-token.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { MediaTokenService } from './media-token.service.js';

/**
 * Narrow the actor the guards already guaranteed.
 *
 * The same pattern as `asCustomer` in the sessions controller and `asAgent` in
 * the agents one: the throw is a wiring assertion, not a request-handling path.
 * Only `CustomerTokenGuard` and `AgentJwtGuard` are mounted here, and neither
 * attaches anything else.
 */
const asMediaActor = (actor: Actor): MediaTokenActor => {
  /* c8 ignore next */
  if (actor.kind !== 'customer' && actor.kind !== 'agent') {
    throw new Error('expected a customer or agent actor');
  }
  return actor;
};

/** Rejects a non-UUID id before any query runs. */
const sessionIdParam = (): ParseUUIDPipe => new ParseUUIDPipe({ version: '4' });

@Controller()
export class MediaTokenController {
  constructor(private readonly media: MediaTokenService) {}

  /** The customer path. Also serves an agent holding a session id (§13). */
  @Get('v1/sessions/:id/media-token')
  @UseGuards(AnyOf(CustomerTokenGuard, AgentJwtGuard), TenantGuard)
  async forSession(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
  ): Promise<ApiData<MediaTokenResult>> {
    return data(await this.media.issue(asMediaActor(actor), id));
  }

  /** R1's second door onto the same handler. Agent credential only. */
  @Get('v1/agent/sessions/:id/media-token')
  @UseGuards(AgentJwtGuard, TenantGuard)
  async forAgent(
    @Auth() actor: Actor,
    @Param('id', sessionIdParam()) id: string,
  ): Promise<ApiData<MediaTokenResult>> {
    return data(await this.media.issue(asMediaActor(actor), id));
  }
}
