/**
 * Taking up an offer: `OFFERED -> IN_CALL` (T19).
 *
 * The second half of D4's pull-claim. T18 gave the agent an exclusive window on
 * one session; this is the agent saying they are ready to work it.
 *
 * **Holding the offer is the authorization.** Unlike the claim, there is no
 * profile lookup, no language check, no capacity count, and no presence
 * requirement. Each of those decided *whether this agent should get this
 * session*, and that was decided at claim time — an unexpired offer in this
 * agent's name is PostgreSQL's record of the answer. Re-asking would only
 * create new ways to refuse work the agent already holds; refusing an accept
 * because a heartbeat was 200ms late would drop a waiting customer for a
 * network blip.
 *
 * **The contender is the sweeper, not another agent.** No other agent can hold
 * this offer, so the race T19 has to win is against T20 returning the same row
 * to the queue. Both are conditional updates on `status = 'OFFERED'`, so
 * PostgreSQL serialises them and the loser matches nothing; the expiry
 * predicate is what stops an agent accepting an offer that lapsed four seconds
 * ago and the sweeper has simply not reached yet.
 *
 * **What this does not do.** No LiveKit room is created, no media token is
 * minted, no recording starts, no WebSocket event is emitted, and no webhook is
 * sent. §17.2 lists those among its side effects, but they belong to T24, T25,
 * T26 and T28. `room_name` is returned because it has existed on the row since
 * creation (R2) — it is a name, not an admission ticket.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError, ErrorCode, SessionEventType, SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
import type { ClaimableSessionRow, SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// The one definition of the room name (R2). Imported rather than repeated: a
// second copy would be a second answer, and the retry path would report a room
// the column does not hold.
import { roomNameFor } from '../sessions/sessions.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { PresenceService } from './presence.service.js';

/**
 * `POST /v1/agent/sessions/{id}/accept` response body, as §17.2 defines it.
 *
 * Four fields, and `room_name` is the only new information — everything the
 * agent needs to open the call is derivable from it once T24 mints tokens.
 * There is still no customer data here.
 */
export interface AcceptResult {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly agent_id: string;
  readonly room_name: string | null;
}

/** The clock, injected so the expiry comparison is testable. */
export type AcceptClock = () => Date;

/** Optional override for the clock. A token, for the reason the others are. */
export const AGENT_ACCEPT_CLOCK = Symbol('AGENT_ACCEPT_CLOCK');

@Injectable()
export class AgentAcceptService {
  private readonly now: AcceptClock;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    private readonly presence: PresenceService,
    private readonly scope: TenantScope,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(AGENT_ACCEPT_CLOCK) now?: AcceptClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  async accept(actor: AgentActor, sessionId: string): Promise<AcceptResult> {
    setContextSession(sessionId);

    const session = this.scope.assertOwnership(
      actor,
      await this.sessions.findClaimable(actor.tenantId, sessionId),
    );

    // Already accepted by this agent. The same reasoning as the claim's retry
    // path, and it matters more here: the agent is about to join a call, and a
    // lost response is the ordinary way to end up asking twice.
    const own = await this.alreadyAccepted(actor, session, sessionId);
    if (own !== null) return own;

    this.requireOwnOffer(actor, session);

    const now = this.now();
    const outcome = await this.sessions.accept({
      sessionId,
      tenantId: actor.tenantId,
      agentId: actor.userId,
      // One clock reading for both jobs: it becomes `connected_at`, and it is
      // the instant the offer's expiry is measured against.
      now,
      event: {
        type: SessionEventType.AGENT_ACCEPTED,
        actorType: 'AGENT',
        actorId: actor.userId,
        payload: {
          from: SessionStatus.OFFERED,
          to: SessionStatus.IN_CALL,
          agent_id: actor.userId,
        },
      },
    });

    if (outcome.kind === 'LOST') {
      // The read said the offer was live and this agent's; the write disagreed.
      // Between the two, the sweeper returned it to the queue — nothing else
      // can move a session out of an offer that belongs to the caller.
      this.logger.info(
        {
          event: 'agent.accept.lost',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
        },
        'accept lost: the offer expired while the request was in flight',
      );
      throw offerGone();
    }

    // The agent was already BUSY from the claim. Reasserted rather than set,
    // because a presence key that lapsed between claim and accept would
    // otherwise leave an agent on a live call looking available.
    await this.markBusy(actor, sessionId);

    this.logger.info(
      {
        event: 'agent.accept.connected',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        session_id: sessionId,
      },
      'agent accepted the session',
    );

    const { session: accepted } = outcome;
    return {
      session_id: accepted.id,
      status: accepted.status,
      agent_id: accepted.agentId,
      room_name: accepted.roomName,
    };
  }

  /**
   * The session this agent is already in, or null.
   *
   * A success, not a conflict, and it decides nothing — the transition already
   * happened. Nothing is re-accepted: no second `AGENT_ACCEPTED`, no version
   * bump, and `connected_at` keeps the instant the call actually began rather
   * than being pushed forward by every retry.
   */
  private async alreadyAccepted(
    actor: AgentActor,
    session: ClaimableSessionRow,
    sessionId: string,
  ): Promise<AcceptResult | null> {
    if (session.status !== SessionStatus.IN_CALL) return null;
    // `offered_to_agent_id` survives the accept as history, and on an IN_CALL
    // row it is exactly "the agent this was offered to" — which, since only
    // the offer holder can accept, is the agent now on the call.
    if (session.offeredToAgentId !== actor.userId) throw takenByAnother();

    await this.markBusy(actor, sessionId);

    this.logger.info(
      {
        event: 'agent.accept.already_connected',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        session_id: sessionId,
      },
      'returning the session this agent is already in',
    );

    return {
      session_id: session.id,
      status: SessionStatus.IN_CALL,
      agent_id: actor.userId,
      room_name: roomNameFor(session.id),
    };
  }

  /** The offer must exist, be this agent's, and not have lapsed. */
  private requireOwnOffer(actor: AgentActor, session: ClaimableSessionRow): void {
    if (session.status !== SessionStatus.OFFERED) {
      throw new DomainError(
        ErrorCode.SESSION_INVALID_STATE,
        'There is no offer outstanding on this session.',
      );
    }
    if (session.offeredToAgentId !== actor.userId) throw takenByAnother();

    // A pre-check for a better message. The predicate that actually decides is
    // in the UPDATE, because this one can go stale in the microseconds before
    // the write and because a guard the service short-circuits is a guard
    // nothing exercises.
    if (session.offerExpiresAt === null || session.offerExpiresAt <= this.now()) {
      this.logger.info(
        {
          event: 'agent.accept.expired',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: session.id,
        },
        'accept refused: the offer had already lapsed',
      );
      throw offerGone();
    }
  }

  /** Reassert BUSY, and never fail the accept for it (D1, D2). */
  private async markBusy(actor: AgentActor, sessionId: string): Promise<void> {
    try {
      const marked = await this.presence.markBusy(actor.userId);
      if (marked) return;
      this.logger.warn(
        {
          event: 'agent.accept.presence_missing',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
        },
        'accepted but the agent had no presence to mark BUSY',
      );
    } catch (error) {
      this.logger.error(
        {
          event: 'agent.accept.presence_failed',
          agent_id: actor.userId,
          tenant_id: actor.tenantId,
          session_id: sessionId,
          err: error,
        },
        'accepted but the BUSY write failed',
      );
    }
  }
}

const offerGone = (): DomainError =>
  new DomainError(
    ErrorCode.SESSION_INVALID_STATE,
    'The offer has expired and the session has returned to the queue.',
  );

const takenByAnother = (): DomainError =>
  new DomainError(ErrorCode.SESSION_ALREADY_ASSIGNED, 'This session is assigned to another agent.');
