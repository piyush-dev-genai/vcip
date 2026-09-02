/**
 * The checklist route (T33, D8).
 *
 * `GET /v1/agent/sessions/:id/checklist` — one route, in its own controller
 * rather than appended to `AgentsController`, because design §11's module
 * layout gives the checklist a directory of its own and T34's required-item
 * validation will land next to these rules rather than in the agents module.
 *
 * Agent credential only. There is no customer door onto this: R3 and the
 * product flow both put the checklist on the agent's side of the call, and a
 * customer being shown the list of things an agent is about to attest to would
 * be an invitation to perform for it.
 *
 * No body, no query parameter, no `Idempotency-Key`. The session id is the one
 * thing the caller chooses; the agent is read from the credential.
 */

import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { ChecklistResult } from '@vcip/shared';
import { AgentJwtGuard } from '../common/auth/agent-jwt.guard.js';
import { Auth } from '../common/auth/auth.decorators.js';
import type { Actor, AgentActor } from '../common/auth/auth-context.js';
import { TenantGuard } from '../common/auth/tenant.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { ChecklistService } from './checklist.service.js';

/**
 * Narrow the actor the guard already guaranteed.
 *
 * The same wiring assertion `asAgent` makes in the agents controller: only
 * `AgentJwtGuard` is mounted here, so the throw is unreachable from a request
 * and exists to fail loudly if a future guard change made it reachable.
 */
const asAgent = (actor: Actor): AgentActor => {
  /* c8 ignore next */
  if (actor.kind !== 'agent') throw new Error('expected an agent actor');
  return actor;
};

@Controller('v1/agent')
export class ChecklistController {
  constructor(private readonly checklist: ChecklistService) {}

  /**
   * The checklist pinned to this session (contract §32).
   *
   * Pinned, not current: a tenant that activates a new template does not
   * change what an existing verification was judged against (schema §18).
   */
  @Get('sessions/:id/checklist')
  @UseGuards(AgentJwtGuard, TenantGuard)
  async forSession(
    @Auth() actor: Actor,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ApiData<ChecklistResult>> {
    return data(await this.checklist.read(asAgent(actor), id));
  }
}
