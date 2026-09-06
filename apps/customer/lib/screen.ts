/**
 * Which screen the customer should be on.
 *
 * A pure function of the server's answer. That is the point: PostgreSQL owns
 * business state (D1), so the browser must never hold a second state machine
 * that can disagree with it. This module does not *decide* anything about the
 * session — it reads what the server already decided and picks a view.
 *
 * The consequence is that a refresh is not a special case. There is no restore
 * logic, no resumption token, and no local progress record: the page fetches
 * `GET /v1/sessions/{id}` and asks this function, and lands where the session
 * actually is. See `docs/05-development-plan.md` T14 §13.
 *
 * One thing the server's projection cannot express, noted honestly: a customer
 * who *rejected* consent leaves the session `CREATED` with `consent_ok = false`,
 * which is indistinguishable here from "has not consented yet". So a refresh
 * after a rejection routes back to the consent screen, and pressing Accept then
 * returns `409 SESSION_INVALID_STATE` from T12, which the UI renders as a
 * blocked state. That is the server refusing, not the client inventing — which
 * is the correct side for the refusal to come from, even though the extra round
 * trip is not elegant.
 */

import { SessionStatus, isTerminalSessionStatus } from '@vcip/shared';
import type { SessionView } from './session';

export const Screen = {
  /** Waiting for the first `GET /v1/sessions/{id}`. */
  LOADING: 'loading',
  CONSENT: 'consent',
  PREFLIGHT: 'preflight',
  LOCATION: 'location',
  /** All three gates passed. T14 stops here; T15 adds the queue. */
  READY_FOR_QUEUE: 'ready_for_queue',
  /**
   * `IN_CALL` — an agent accepted and both parties belong in the room (T25).
   *
   * Its own screen rather than a branch of the status view, because it is the
   * only screen that holds a camera. Leaving it has to tear that down, and a
   * conditional inside the status screen would make "when does the camera
   * stop" a question about render order.
   */
  CALL: 'call',
  /** `PREFLIGHT_FAILED` — terminal, unbilled (I5). Preflight or location. */
  CHECKS_FAILED: 'checks_failed',
  /**
   * The verification is over: approved, rejected, stopped, or dropped.
   *
   * Its own screen rather than a branch of the status view, for the same
   * reason `CALL` is: it is not a state the customer is waiting in, it is the
   * answer they came for. The status screen exists to say "here is how far
   * along you are and here is what you can do next", and a finished
   * verification has no next — every control on that screen was either
   * inapplicable or, in the case of Join Queue, actively wrong.
   */
  FINISHED: 'finished',
  /** A session already past the customer gates and still running: queued or offered. */
  SESSION_STATE: 'session_state',
} as const;

export type Screen = (typeof Screen)[keyof typeof Screen];

/**
 * Choose the screen for a session.
 *
 * The gate order is the product flow's order (§5): consent, then preflight,
 * then location. Each gate is read from its own server flag rather than from a
 * step counter, so a session that somehow passed them out of order still lands
 * on the first one that is genuinely incomplete.
 */
export function screenFor(session: SessionView): Screen {
  if (session.status === SessionStatus.PREFLIGHT_FAILED) return Screen.CHECKS_FAILED;

  // Terminal for any other reason — aborted, dropped, or decided. This is the
  // end of the verification and gets the screen that says so.
  if (isTerminalSessionStatus(session.status)) return Screen.FINISHED;

  // An agent has accepted: the customer belongs in the room (T25). Checked
  // before the general "past the gates" case below, which would otherwise
  // route a live call to the status screen.
  if (session.status === SessionStatus.IN_CALL) return Screen.CALL;

  // Past the customer's own gates: queued or offered. T15 onward.
  if (session.status !== SessionStatus.CREATED) return Screen.SESSION_STATE;

  if (!session.consent_ok) return Screen.CONSENT;
  if (!session.preflight_ok) return Screen.PREFLIGHT;
  if (!session.geo_ok) return Screen.LOCATION;
  return Screen.READY_FOR_QUEUE;
}

/**
 * Whether the join-queue action may be offered.
 *
 * Defined *as* the routing decision rather than as a second rule that agrees
 * with it. The status screen used to compute its own — all three gates passed
 * and the session not `QUEUED` — which is true of every terminal session too:
 * an approved, rejected or aborted verification passed its gates and is
 * certainly not queued. So a finished session rendered a live "Join Queue"
 * button under the heading "Ready for an agent", and pressing it earned a 409
 * from a server that was right to refuse.
 *
 * The bug was not the predicate being wrong so much as it existing twice.
 * `READY_FOR_QUEUE` already meant exactly this, and asking for it is what makes
 * the two impossible to disagree.
 */
export function canJoinQueue(session: SessionView): boolean {
  return screenFor(session) === Screen.READY_FOR_QUEUE;
}

/**
 * Whether the abort action may be offered.
 *
 * Mirrors T12's `ABORT_TARGET`: `QUEUED` and `OFFERED` abort to
 * `DROPPED_QUEUED`, `IN_CALL` to `ABORTED`, and everything else is a `409`.
 * `CREATED` is deliberately not abortable — a session that never queued stays
 * `CREATED` and unbilled (D19), so there is nothing to abort.
 *
 * In the T14 flow the customer never leaves `CREATED`, so this is false
 * throughout. It is implemented against the real rule rather than hardcoded to
 * false so that T15 gets a working button by moving the session, not by
 * revisiting this file.
 */
export function canAbort(session: SessionView): boolean {
  return (
    session.status === SessionStatus.QUEUED ||
    session.status === SessionStatus.OFFERED ||
    session.status === SessionStatus.IN_CALL
  );
}

/** The three customer gates, for the progress summary on the status screen. */
export interface GateSummary {
  readonly consent: boolean;
  readonly preflight: boolean;
  readonly location: boolean;
}

export function gatesOf(session: SessionView): GateSummary {
  return {
    consent: session.consent_ok,
    preflight: session.preflight_ok,
    location: session.geo_ok,
  };
}

/**
 * What a finished verification is told, in words a customer can read.
 *
 * A status code is the server's vocabulary, not a sentence: `DROPPED_IN_CALL`
 * means nothing to the person it happened to. The raw status is still shown
 * beside this — support asks for it — but it is not the explanation.
 *
 * Null for anything not terminal, so a caller cannot render a conclusion about
 * a verification that is still running. `PREFLIGHT_FAILED` is terminal and gets
 * no message here: it has its own screen, which explains which check failed.
 */
export function outcomeMessage(session: SessionView): string | null {
  switch (session.status) {
    case SessionStatus.APPROVED:
      return 'Your verification is complete and was approved.';
    case SessionStatus.REJECTED:
      return 'Your verification is complete. It was not approved.';
    case SessionStatus.ABORTED:
      return 'This verification was stopped before it could be completed.';
    case SessionStatus.DROPPED_QUEUED:
    case SessionStatus.DROPPED_IN_CALL:
      return 'This verification ended because the connection was lost.';
    default:
      return null;
  }
}

/**
 * The three shapes a finished verification can take, for the screen.
 *
 * Three and not five: `ABORTED` and both `DROPPED_*` statuses differ in *why*
 * the verification stopped, which matters to billing and to support, but not
 * to the customer's next move. All three mean "it did not finish, start again
 * when you are ready", and giving them three near-identical treatments would
 * be dressing an implementation detail up as a distinction.
 *
 * The tone is what the screen draws and colours by. It is deliberately not a
 * colour name: `approved` is green today and the meaning is not.
 */
export type OutcomeTone = 'approved' | 'rejected' | 'stopped';

export interface Outcome {
  readonly tone: OutcomeTone;
  /** The answer, in three or four words. */
  readonly headline: string;
  /** The same answer as a sentence — `outcomeMessage`, not a second wording. */
  readonly detail: string;
  /** What the customer does now. Never an instruction this app can act on. */
  readonly next: string;
}

/**
 * Describe a finished verification.
 *
 * Null for anything still running, and null for `PREFLIGHT_FAILED`, which is
 * terminal but has its own screen naming the check that failed — a customer
 * whose camera was too dark needs to be told that, not "stopped".
 *
 * Nothing here is a decision. Every branch reads `status`, which the server
 * set, and turns it into words; the raw status is still shown beside it,
 * because support asks for that and a customer should be able to read it out.
 */
export function outcomeOf(session: SessionView): Outcome | null {
  const detail = outcomeMessage(session);
  if (detail === null) return null;

  switch (session.status) {
    case SessionStatus.APPROVED:
      return {
        tone: 'approved',
        headline: 'You are verified',
        detail,
        next: 'Nothing further is needed from you. You can close this page — your bank or provider has already been told.',
      };
    case SessionStatus.REJECTED:
      return {
        tone: 'rejected',
        headline: 'Not approved',
        detail,
        next: 'Your bank or provider will be in touch about what happens next. They can tell you why and whether you can try again.',
      };
    default:
      // `ABORTED`, `DROPPED_QUEUED`, `DROPPED_IN_CALL`. The sentence above
      // already distinguishes a deliberate stop from a lost connection.
      return {
        tone: 'stopped',
        headline: 'Verification stopped',
        detail,
        next: 'Nothing has been decided about your application. To try again, start a new verification from your bank or provider.',
      };
  }
}
