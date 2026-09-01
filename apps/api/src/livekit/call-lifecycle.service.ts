/**
 * What a LiveKit webhook does to a session (T26, D7).
 *
 * Four facts, and the module's whole job is to record them honestly:
 *
 *   - **`CALL_STARTED` when both participants are in the room.** Not when the
 *     agent accepted (that is `connected_at`, T19), and not when either one
 *     joined alone. A verification begins when both parties can see each other,
 *     `talk_ms` is measured from it, and the evidence package will claim it —
 *     so a room only one side ever reached must not carry the event.
 *   - **`AGENT_DISCONNECTED` when the agent goes, and the session stays
 *     `IN_CALL`.** D18 is explicit. A reconnect window is armed; the sweeper,
 *     not this service, decides what happens if it lapses.
 *   - **`AGENT_RECONNECTED` when they come back** to a window still counting.
 *   - **A grace window when the customer goes**, for the same reason but
 *     shorter, and ending in `DROPPED_IN_CALL` rather than `ABORTED` (R4).
 *
 * **Nothing here terminates a session.** Every departure arms a deadline and
 * returns; `CallSweeper` owns the transitions. That split is deliberate: a
 * webhook is an untrusted-timing input that can arrive late, twice, or out of
 * order, and letting one directly end a customer's verification would put a
 * billing decision on the far side of a network delivery. The sweeper decides
 * on the server's own clock, against a guarded UPDATE.
 *
 * Every write is idempotent, because LiveKit retries. `markSeen` suppresses the
 * obvious duplicates, `CALL_STARTED` is guarded by PostgreSQL rather than by
 * Redis, and set membership makes a repeated join a no-op.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { SessionEventType, SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
import type { CallSessionRow, SessionRepository } from '../sessions/session.repository.js';
import type { Notifications } from '../realtime/notifications.js';
import { InjectNotifications } from '../realtime/notifications.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantsService } from '../tenants/tenants.service.js';
import type { CallAction, CallWebhookEvent } from './call-events.rules.js';
import { bothPresent, classify } from './call-events.rules.js';
import type { CallRepository } from './call.repository.js';
import { InjectCallRepository } from './call.repository.js';
import { CUSTOMER_GRACE_SECONDS, CallRole, deadlineAt } from './call.keys.js';

/** What one delivery did, for the response and for tests. */
export interface CallEventOutcome {
  /** `IGNORE`, `JOINED`, `LEFT`, `ROOM_CLOSED`, or `DUPLICATE`. */
  readonly handled: string;
  /** True when the delivery had been seen before and was skipped. */
  readonly duplicate: boolean;
}

export type CallClock = () => Date;

/** Optional clock override. A token, for the reason the other services have one. */
export const CALL_LIFECYCLE_CLOCK = Symbol('CALL_LIFECYCLE_CLOCK');

@Injectable()
export class CallLifecycleService {
  private readonly now: CallClock;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectCallRepository() private readonly calls: CallRepository,
    private readonly tenants: TenantsService,
    @InjectNotifications() private readonly notify: Notifications,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(CALL_LIFECYCLE_CLOCK) now?: CallClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  async handle(event: CallWebhookEvent): Promise<CallEventOutcome> {
    // Best-effort replay suppression. A Redis failure must not drop a genuine
    // event, so an error here is treated as "not seen before" and the
    // idempotent handlers below carry the weight.
    let fresh = true;
    try {
      fresh = await this.calls.markSeen(event.id);
    } catch (error) {
      this.logger.warn(
        { event: 'call.webhook.dedupe_failed', webhook_event_id: event.id, err: error },
        'could not record the delivery id; handling it anyway',
      );
    }
    if (!fresh) {
      return { handled: 'DUPLICATE', duplicate: true };
    }

    const action = classify(event);

    if (action.kind === 'IGNORE') {
      this.logger.debug(
        { event: 'call.webhook.ignored', webhook_event: event.event, reason: action.reason },
        'webhook event not acted on',
      );
      return { handled: 'IGNORE', duplicate: false };
    }

    setContextSession(action.sessionId);

    const session = await this.sessions.findForCallEvent(action.sessionId);
    if (session === null) {
      // A room named like one of ours for a session that does not exist. Not an
      // error to report upward: LiveKit cannot fix it by retrying.
      this.logger.warn(
        { event: 'call.webhook.unknown_session', session_id: action.sessionId },
        'webhook named a session that does not exist',
      );
      return { handled: 'IGNORE', duplicate: false };
    }

    switch (action.kind) {
      case 'JOINED':
        await this.onJoined(action, session);
        break;
      case 'LEFT':
        await this.onLeft(action, session);
        break;
      case 'ROOM_CLOSED':
        await this.onRoomClosed(action.sessionId);
        break;
    }

    return { handled: action.kind, duplicate: false };
  }

  /**
   * A participant arrived.
   *
   * Two things can follow: the call may now have both parties in it, and this
   * arrival may be a return from a window that was counting down.
   */
  private async onJoined(
    action: Extract<CallAction, { kind: 'JOINED' }>,
    session: CallSessionRow,
  ): Promise<void> {
    const wasAway = await this.calls.disarmDeadline(action.sessionId, action.role);
    const present = await this.calls.addParticipant(action.sessionId, action.role);

    if (wasAway && action.role === CallRole.AGENT) {
      // D25: the reconnection is history, in events, with no column.
      await this.sessions.appendCallEvent(action.sessionId, {
        type: SessionEventType.AGENT_RECONNECTED,
        actorType: 'AGENT',
        actorId: session.agentId,
        payload: { role: action.role },
      });
      this.logger.info(
        { event: 'call.agent.reconnected', session_id: action.sessionId },
        'the agent returned before the window lapsed',
      );
    }

    // The customer's cue that their agent is actually in the room. T26 owns
    // the decision — this is the point at which it is known — and T27 only
    // carries it. Published on the agent's join whether or not the customer has
    // arrived yet: a customer who connects later reads the session instead.
    if (action.role === CallRole.AGENT) {
      await this.notify.agentJoined(action.sessionId);
    }

    if (!bothPresent(present)) return;

    // Both are here. `CALL_STARTED` is once per session, and PostgreSQL is what
    // says so — Redis knows only who is in the room right now, and a room the
    // customer rejoins twice must not produce a second start.
    if (await this.sessions.hasEvent(action.sessionId, SessionEventType.CALL_STARTED)) return;

    await this.sessions.appendCallEvent(action.sessionId, {
      type: SessionEventType.CALL_STARTED,
      actorType: 'SYSTEM',
      actorId: null,
      payload: {
        // The wait the customer actually experienced: queued until both parties
        // were in the room. Reported, not stored — `wait_ms` is a column no
        // task has claimed, and inventing a writer for it here would be T26
        // deciding something nobody asked it to.
        waited_ms: this.waitedMs(session),
      },
    });

    this.logger.info(
      { event: 'call.started', session_id: action.sessionId },
      'both participants are in the room',
    );
  }

  /**
   * A participant left, and it was not a reconnection.
   *
   * Nothing terminates here. A window is armed and the sweeper decides, on the
   * server's clock, whether it lapsed.
   */
  private async onLeft(
    action: Extract<CallAction, { kind: 'LEFT' }>,
    session: CallSessionRow,
  ): Promise<void> {
    await this.calls.removeParticipant(action.sessionId, action.role);

    // A session that is already finished has nothing to wait for. A verdict
    // (T35) or a customer abort will produce exactly this: both participants
    // leave a room whose session is terminal.
    if (session.status !== SessionStatus.IN_CALL) {
      this.logger.debug(
        {
          event: 'call.participant.left_after_end',
          session_id: action.sessionId,
          status: session.status,
        },
        'participant left a session that had already ended',
      );
      return;
    }

    const graceSeconds = await this.graceFor(action.role, session);
    const due = deadlineAt(this.now(), graceSeconds);
    await this.calls.armDeadline(action.sessionId, action.role, due);

    if (action.role === CallRole.AGENT) {
      // D18: the session stays IN_CALL. The event is the record.
      await this.sessions.appendCallEvent(action.sessionId, {
        type: SessionEventType.AGENT_DISCONNECTED,
        actorType: 'AGENT',
        actorId: session.agentId,
        payload: { role: action.role, reconnect_deadline: new Date(due).toISOString() },
      });
    }

    this.logger.info(
      {
        event: 'call.participant.left',
        session_id: action.sessionId,
        role: action.role,
        deadline: new Date(due).toISOString(),
      },
      'participant left; a window is armed',
    );
  }

  /**
   * The room closed.
   *
   * LiveKit closes a room after `empty_timeout`, long after the departures that
   * emptied it. Those departures already armed their windows and the sweeper
   * has already acted, so the only thing left is to stop tracking the room. It
   * deliberately does not terminate anything: a room closing is LiveKit's
   * housekeeping, not a statement about a verification.
   */
  private async onRoomClosed(sessionId: string): Promise<void> {
    await this.calls.clearParticipants(sessionId);
  }

  /** The customer's window is fixed; the agent's is the tenant's (D18). */
  private async graceFor(role: CallRole, session: CallSessionRow): Promise<number> {
    if (role === CallRole.CUSTOMER) return CUSTOMER_GRACE_SECONDS;
    const config = await this.tenants.requireConfig(session.tenantId);
    return config.agentReconnectTimeoutSeconds;
  }

  /** Queued until both parties were in the room, or null if never queued. */
  private waitedMs(session: CallSessionRow): number | null {
    if (session.queuedAt === null) return null;
    return Math.max(0, this.now().getTime() - session.queuedAt.getTime());
  }
}
