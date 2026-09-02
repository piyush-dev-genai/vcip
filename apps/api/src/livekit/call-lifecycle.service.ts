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
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { AiAnalysisService } from '../ai/ai-analysis.service.js';
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
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { RecordingService } from './recording.service.js';
import { InjectCallRepository } from './call.repository.js';
import {
  CALL_START_TIMEOUT_SECONDS,
  CUSTOMER_GRACE_SECONDS,
  CallDeadline,
  CallRole,
  deadlineAt,
} from './call.keys.js';

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
    private readonly recording: RecordingService,
    private readonly ai: AiAnalysisService,
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

    if (!bothPresent(present)) {
      // Somebody is in the room alone. Every other deadline in this module
      // hangs off a departure, which leaves this case with no clock at all: a
      // participant who never arrives never leaves, so nothing was ever armed
      // and the sweeper never looked. A session could sit `IN_CALL` forever
      // with an agent parked in an empty room, capacity consumed, no billing
      // row, and no way out but closing the tab.
      //
      // Armed on every lone arrival rather than only the first, so an agent
      // who reloads gives the customer a fresh window rather than inheriting
      // the remains of the last one. `ZADD` on an existing member re-scores it.
      await this.armCallStart(action.sessionId, session);
      return;
    }

    // Both are here, so the call has begun and the start clock is moot.
    // Disarmed before `CALL_STARTED` is appended: if the append fails, the
    // worst outcome is a call with no start event, not a live call the sweeper
    // is still counting down.
    await this.calls.disarmDeadline(action.sessionId, CallDeadline.START);

    // `CALL_STARTED` is once per session, and PostgreSQL is what says so —
    // Redis knows only who is in the room right now, and a room the customer
    // rejoins twice must not produce a second start.
    const firstArrival = !(await this.sessions.hasEvent(
      action.sessionId,
      SessionEventType.CALL_STARTED,
    ));

    if (firstArrival) await this.startCall(action, session);

    // T31: asked on **every** arrival, not only the first, and this is the
    // difference between the analysis and the recording.
    //
    // A room-composite egress survives a customer dropping out, because the
    // agent keeps the room alive and LiveKit goes on recording it — starting a
    // second one would open a second file. The analyzer has the opposite
    // property: it leaves when the customer does, deliberately, so it cannot
    // hold a room open past the call and stop the recording from ever ending.
    // Something therefore has to bring it back, and a customer who returns
    // inside `CUSTOMER_GRACE_SECONDS` resumes a call that would otherwise run
    // to its verdict with a HUD frozen at the moment they dropped.
    //
    // Safe to ask repeatedly: the AI service refuses to start a second
    // analysis for a session it is already analysing, and it is the only party
    // that knows whether one is still running.
    if (session.status === SessionStatus.IN_CALL) {
      await this.ai.start(action.sessionId, session.tenantId, session.roomName ?? null);
    }
  }

  /**
   * Start the clock on a call that has not begun.
   *
   * Only while the session is `IN_CALL`. A participant wandering into the room
   * of a session that has already ended — a customer reloading a tab after a
   * verdict, a stale token — must not arm a deadline against a terminal row;
   * the sweeper would find nothing, but the honest thing is not to arm it.
   */
  private async armCallStart(sessionId: string, session: CallSessionRow): Promise<void> {
    if (session.status !== SessionStatus.IN_CALL) return;

    const due = deadlineAt(this.now(), CALL_START_TIMEOUT_SECONDS);
    await this.calls.armDeadline(sessionId, CallDeadline.START, due);

    this.logger.info(
      {
        event: 'call.start.armed',
        session_id: sessionId,
        deadline: new Date(due).toISOString(),
      },
      'somebody is in the room alone; the call has to begin before this',
    );
  }

  /**
   * The first time both parties are in the room.
   *
   * Split out so `onJoined` reads as what it now is: two things that happen
   * once and one that happens on every arrival.
   */
  private async startCall(
    action: Extract<CallAction, { kind: 'JOINED' }>,
    session: CallSessionRow,
  ): Promise<void> {
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

    // T28: the evidence recording starts here and nowhere else. The plan calls
    // it "recording start on accept", but at accept nobody has joined and
    // LiveKit refuses room-composite egress on a room that does not exist —
    // design §21.2's "when the actual call begins" is this moment. It never
    // fails the call: a verification whose recording could not start is still a
    // verification, and the retry sweeper tries again for as long as the call
    // lasts.
    await this.recording.start(action.sessionId, session.tenantId, session.roomName ?? null);

    // T30's analysis wants the same instant and for the same reason — there is
    // no customer video to subscribe to until somebody is publishing it — but
    // it is asked for in `onJoined`, because unlike the recording it has to be
    // asked for again when a customer comes back.
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
