/**
 * What this agent is currently holding.
 *
 * The endpoint the contract was missing. Everything else an agent can ask
 * answers a different question: `GET /v1/agent/queue` lists what they *could*
 * take, and a session assigned to them has by definition left the queue;
 * `GET /v1/sessions/{id}` needs an id they may not have; the login response
 * carries a credential and nothing else.
 *
 * Without it, the portal's only record of its own work was a `sessionStorage`
 * entry, which is per-tab and dies with the tab. A fresh login — a new tab, a
 * different browser, cleared storage, or a deliberate sign-out — lost the
 * pointer, and the agent landed on the queue screen while the server refused
 * their availability with a 409 for holding a session they had no way to
 * reach. Nothing recovers an `IN_CALL` session: the expiry sweeper only handles
 * `OFFERED`, so that state was terminal for the agent as well as the customer.
 *
 * A read, and nothing more. It starts nothing, claims nothing, and changes no
 * presence — it reports rows that already exist. The agent is taken from the
 * JWT, so there is no parameter through which one agent could ask what another
 * is holding.
 */

import { Injectable } from '@nestjs/common';
import type { SessionStatus } from '@vcip/shared';
import { SessionStatus as Status } from '@vcip/shared';
import type { AgentActor } from '../common/auth/auth-context.js';
import type { AgentWorkRow, SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';

/**
 * One session the agent holds.
 *
 * Deliberately narrow, and shaped like the accept response the portal already
 * knows: an id, the status the server says it is in, the room name, and the
 * offer window. Nothing about the customer — an agent recovering their screen
 * needs to know *which* session, not who is on it.
 */
export interface AgentWorkItem {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly room_name: string | null;
  /**
   * ISO 8601, or null.
   *
   * Non-null only for an `OFFERED` session, where it is the window the claim
   * issued — reported so a recovered offer shows a real countdown rather than
   * an invented one.
   *
   * Null on a call, and that takes deliberate work rather than falling out of
   * the row: T19's accept **keeps** `offer_expires_at` as history, so an
   * `IN_CALL` row still carries the instant its offer would have lapsed. That
   * value is a record of how the session was assigned, not a deadline, and
   * handing it to a portal that renders countdowns would put a running clock on
   * a call that has none.
   */
  readonly offer_expires_at: string | null;
}

/**
 * `GET /v1/agent/work`.
 *
 * A list, because `agent_profiles.max_concurrent` may exceed one. The portal is
 * single-session and takes the first; a signature promising exactly one would
 * be a lie the schema already permits breaking.
 */
export interface AgentWorkResult {
  readonly sessions: readonly AgentWorkItem[];
}

const toItem = (row: AgentWorkRow): AgentWorkItem => ({
  session_id: row.id,
  status: row.status,
  room_name: row.roomName,
  // Gated on the status, not merely on the column being set. See the field's
  // comment: the accept keeps the offer window as history, so an IN_CALL row
  // carries a non-null value that is not a deadline.
  offer_expires_at:
    row.status === Status.OFFERED && row.offerExpiresAt !== null
      ? row.offerExpiresAt.toISOString()
      : null,
});

@Injectable()
export class AgentWorkService {
  constructor(@InjectSessionRepository() private readonly sessions: SessionRepository) {}

  async work(actor: AgentActor): Promise<AgentWorkResult> {
    // Tenant and agent both from the verified JWT, and both in the WHERE
    // clause rather than checked afterwards (I8).
    const rows = await this.sessions.findActiveWork(actor.tenantId, actor.userId);
    return { sessions: rows.map(toItem) };
  }
}
