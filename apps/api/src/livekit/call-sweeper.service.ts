/**
 * Ending calls whose participant never came back (T26, D18).
 *
 * The counterpart to `OfferSweeper`, and the same shape for the same reasons: a
 * timer nobody calls, a bounded batch per pass, and one guarded UPDATE per row
 * so several instances can run it at once without a lock.
 *
 * It exists because a departure is not immediately a decision. A page reload
 * and a closed tab arrive identically — `participant_left`, reason
 * `CLIENT_INITIATED` — and T25's apps rejoin automatically, so acting on the
 * event itself would end a session because someone pressed F5. The webhook arms
 * a window; this decides, on the server's own clock, whether it lapsed.
 *
 * Two outcomes, and they are not interchangeable (R4):
 *
 *   - the **customer** did not return -> `DROPPED_IN_CALL`, Rs 5
 *   - the **agent** did not return -> `ABORTED`, Rs 5 (D18)
 *
 * Both are unexpected ends with no verdict, both are billed, and the billing
 * row is written in the same transaction as the transition. `billing_entries`
 * is keyed by session id, so "exactly once" is the database's guarantee rather
 * than this file's care (I3).
 *
 * What it never does: overwrite a terminal status. The UPDATE is guarded on
 * `status = 'IN_CALL'`, so a verdict that committed first (T35), a customer
 * abort, or a second pass all match nothing (I11).
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { SessionEventType, SessionStatus, getBillingForOutcome } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { Notifications } from '../realtime/notifications.js';
import { InjectNotifications } from '../realtime/notifications.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { PresenceService } from '../agents/presence.service.js';
import type { CallRepository } from './call.repository.js';
import { InjectCallRepository } from './call.repository.js';
import { CallDeadline, parseDeadlineMember } from './call.keys.js';

/**
 * Why each terminal transition happened, for the session history.
 *
 * Three deadlines, three different facts. `customer_never_joined` and
 * `customer_disconnected` both end as `DROPPED_IN_CALL` and both cost Rs 5, so
 * this string is the only place the record says which one it was.
 */
const SWEEP_REASONS: Readonly<Record<CallDeadline, string>> = Object.freeze({
  [CallDeadline.CUSTOMER]: 'customer_disconnected',
  [CallDeadline.AGENT]: 'agent_disconnect_timeout',
  [CallDeadline.START]: 'call_never_started',
});

/** What one pass did. Counts only — no identifiers (D10's routes are not a directory). */
export interface CallSweepResult {
  /** Deadlines that had fallen due and were taken by this pass. */
  readonly due: number;
  /** Sessions moved to `DROPPED_IN_CALL`. */
  readonly dropped: number;
  /** Sessions moved to `ABORTED`. */
  readonly aborted: number;
  /** Due deadlines whose session had already ended. Nothing to do. */
  readonly stale: number;
}

export type SweepClock = () => Date;

/** How many deadlines one pass takes. Bounded, like the offer sweeper's. */
export const CALL_SWEEP_BATCH = 50;

/** Milliseconds between passes. */
export const CALL_SWEEP_INTERVAL_MS = 5000;

/** Whether the interval runs. Off in tests, which trigger passes explicitly. */
export const CALL_SWEEP_ENABLED = Symbol('CALL_SWEEP_ENABLED');

export const CALL_SWEEP_CLOCK = Symbol('CALL_SWEEP_CLOCK');

@Injectable()
export class CallSweeper {
  private readonly now: SweepClock;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectCallRepository() private readonly calls: CallRepository,
    private readonly presence: PresenceService,
    @InjectNotifications() private readonly notify: Notifications,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(CALL_SWEEP_ENABLED) enabled?: boolean,
    @Optional() @Inject(CALL_SWEEP_CLOCK) now?: SweepClock,
  ) {
    this.now = now ?? ((): Date => new Date());
    if (enabled === true) this.start();
  }

  private start(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error({ event: 'call.sweep.failed', err: error }, 'a call sweep pass failed');
      });
    }, CALL_SWEEP_INTERVAL_MS);
    // Never hold the process open for a recovery pass.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<CallSweepResult> {
    const now = this.now();
    const due = await this.calls.dueDeadlines(now.getTime(), CALL_SWEEP_BATCH);

    let dropped = 0;
    let aborted = 0;
    let stale = 0;

    for (const deadline of due) {
      const parsed = parseDeadlineMember(deadline.member);
      if (parsed === null) {
        // Unparseable, so unresolvable. Dropped rather than acted on: ending a
        // call on the strength of a corrupt string is worse than forgetting it.
        this.logger.warn(
          { event: 'call.sweep.bad_member', member: deadline.member },
          'discarding an unreadable deadline',
        );
        await this.calls.disarmAll(deadline.member);
        continue;
      }

      const outcome = await this.terminate(parsed.sessionId, parsed.reason, now);
      if (outcome === SessionStatus.DROPPED_IN_CALL) dropped += 1;
      else if (outcome === SessionStatus.ABORTED) aborted += 1;
      else stale += 1;

      // Taken either way. A deadline that resolved to nothing is a deadline
      // that will resolve to nothing forever.
      await this.calls.disarmDeadline(parsed.sessionId, parsed.reason);
    }

    if (due.length > 0) {
      this.logger.info(
        { event: 'call.sweep.pass', due: due.length, dropped, aborted, stale },
        'call sweep pass complete',
      );
    }

    return { due: due.length, dropped, aborted, stale };
  }

  /**
   * End one session, or find there is nothing to end.
   *
   * Returns the status written, or null when the guarded UPDATE matched
   * nothing — which is the ordinary outcome when a verdict, an abort, or the
   * participant's own return got there first.
   */
  private async terminate(
    sessionId: string,
    reason: CallDeadline,
    now: Date,
  ): Promise<SessionStatus | null> {
    const session = await this.sessions.findForCallEvent(sessionId);
    if (session === null || session.status !== SessionStatus.IN_CALL) return null;

    // A call-start deadline that fires on a call which did start is not a
    // timeout — the customer arrived, both clocks were disarmed, and this is a
    // member that outlived its meaning. PostgreSQL is asked rather than Redis
    // because "did this call ever begin" is durable history (D1).
    if (reason === CallDeadline.START) {
      const started = await this.sessions.hasEvent(sessionId, SessionEventType.CALL_STARTED);
      if (started) return null;
    }

    // R4: which side vanished decides the outcome, and the two are different
    // facts about the verification even though both cost Rs 5. A call that
    // never began is the customer failing to appear — the agent accepted and
    // was in the room — so it lands where a customer who vanishes mid-call
    // lands. `talk_ms` stays null, which is what tells the two apart in the
    // record, along with the reason on the event.
    const status =
      reason === CallDeadline.AGENT ? SessionStatus.ABORTED : SessionStatus.DROPPED_IN_CALL;

    // The amount comes from the shared billing table and from nowhere else.
    const billing = getBillingForOutcome(status);
    if (billing.category === null || billing.amountPaise <= 0) {
      // Unreachable for these two statuses; a guard rather than a branch, so a
      // future change to the table cannot silently write a zero-amount row that
      // the CHECK constraint would then reject mid-transaction.
      this.logger.error(
        { event: 'call.sweep.unbillable', session_id: sessionId, status },
        'refusing to end a call with no billing decision',
      );
      return null;
    }

    const ended = await this.sessions.endCall({
      sessionId,
      tenantId: session.tenantId,
      status,
      now,
      billCategory: billing.category,
      billAmountPaise: billing.amountPaise,
      event: {
        type: SessionEventType.CALL_ENDED,
        actorType: 'SYSTEM',
        actorId: null,
        payload: {
          from: SessionStatus.IN_CALL,
          to: status,
          reason: SWEEP_REASONS[reason],
        },
      },
    });

    if (ended === null) return null;

    // R5: BUSY is cleared on session end. Never fails the transition — the
    // transaction has committed, and a presence key is not authoritative (D2).
    await this.freeAgent(ended.agentId, sessionId);

    // Both screens have somewhere else to be: the customer sees the outcome,
    // the agent's portal releases the work. The sweeper decided; this reports.
    await this.notify.sessionCompleted(
      sessionId,
      status,
      null,
      ended.agentId === null ? null : { tenantId: session.tenantId, userId: ended.agentId },
    );

    this.logger.info(
      {
        event: 'call.ended',
        session_id: sessionId,
        status,
        reason,
        talk_ms: ended.talkMs,
      },
      'call ended without a verdict',
    );

    return status;
  }

  private async freeAgent(agentId: string | null, sessionId: string): Promise<void> {
    if (agentId === null) return;
    try {
      await this.presence.markAvailable(agentId);
    } catch (error) {
      this.logger.error(
        { event: 'call.sweep.presence_failed', session_id: sessionId, err: error },
        'the session ended but the agent could not be freed',
      );
    }
  }
}
