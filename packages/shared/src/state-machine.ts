/**
 * Session state machine — the two axes of `docs/00-decisions.md` D3, kept apart.
 *
 * Pure data plus pure predicates. Nothing here reads the clock, the database, or
 * the network; whether an offer has actually expired is the caller's business,
 * and only the resulting transition is validated here.
 */

import type { ExportStatus, SessionStatus } from './enums.js';
import { ExportStatus as Export, SessionStatus as Status } from './enums.js';

/**
 * Legal `sessions.status` transitions.
 *
 * ```text
 * CREATED
 *    |
 *    +----> PREFLIGHT_FAILED        terminal, Rs 0, no billing row
 *    |
 *    v
 * QUEUED <-------------------+
 *    |                       |
 *    +----> DROPPED_QUEUED   | offer timeout
 *    |                       |
 *    v                       |
 * OFFERED --------------------+
 *    |
 *    v
 * IN_CALL
 *    |
 *    +----> APPROVED               terminal, Rs 25
 *    +----> REJECTED               terminal, Rs 5
 *    +----> ABORTED                terminal, Rs 5
 *    +----> DROPPED_IN_CALL        terminal, Rs 5
 * ```
 *
 * `QUEUED -> IN_CALL` is deliberately absent: D4 replaced push-assignment with
 * pull-claim, so a session always passes through `OFFERED`.
 *
 * `OFFERED -> DROPPED_QUEUED` exists per R15 — a customer aborting while offered
 * is treated exactly like aborting while queued.
 *
 * Every terminal status maps to an empty set, which is what makes
 * "no transition out of a terminal state" a property of the table rather than a
 * special case in the code.
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> =
  Object.freeze({
    [Status.CREATED]: Object.freeze([Status.PREFLIGHT_FAILED, Status.QUEUED]),
    [Status.QUEUED]: Object.freeze([Status.OFFERED, Status.DROPPED_QUEUED]),
    [Status.OFFERED]: Object.freeze([Status.IN_CALL, Status.QUEUED, Status.DROPPED_QUEUED]),
    [Status.IN_CALL]: Object.freeze([
      Status.APPROVED,
      Status.REJECTED,
      Status.ABORTED,
      Status.DROPPED_IN_CALL,
    ]),

    // Terminal.
    [Status.PREFLIGHT_FAILED]: Object.freeze([]),
    [Status.APPROVED]: Object.freeze([]),
    [Status.REJECTED]: Object.freeze([]),
    [Status.ABORTED]: Object.freeze([]),
    [Status.DROPPED_QUEUED]: Object.freeze([]),
    [Status.DROPPED_IN_CALL]: Object.freeze([]),
  });

/**
 * Statuses from which no further business transition is legal.
 *
 * Derived from {@link SESSION_TRANSITIONS} rather than listed again, so the two
 * can never disagree.
 */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze(
  (Object.keys(SESSION_TRANSITIONS) as SessionStatus[]).filter(
    (status) => SESSION_TRANSITIONS[status].length === 0,
  ),
);

/**
 * The point after which a session becomes billable. Reaching `QUEUED` starts
 * billing eligibility; failing before it costs the tenant nothing.
 */
export const BILLING_ELIGIBILITY_START: SessionStatus = Status.QUEUED;

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return SESSION_TRANSITIONS[status].length === 0;
}

/** The legal successors of `from`. Empty for a terminal status. */
export function transitionsFrom(from: SessionStatus): readonly SessionStatus[] {
  return SESSION_TRANSITIONS[from];
}

/**
 * Is `from -> to` a legal session transition?
 *
 * A self-transition is not legal: re-applying a status is an idempotency concern
 * for the caller, not a state change.
 */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/**
 * Legal `sessions.export_status` transitions — the evidence axis of D3.
 *
 * ```text
 * NOT_STARTED -> EXPORTING -> EXPORTED -> PURGED
 *                     |
 *                     +-----> FAILED (retries exhausted; terminal)
 * ```
 *
 * `FAILED` is terminal because `EXPORTING` already covers the retry loop. This
 * axis moves independently of {@link SESSION_TRANSITIONS}; export failure never
 * touches the business status and never reverses billing.
 */
export const EXPORT_TRANSITIONS: Readonly<Record<ExportStatus, readonly ExportStatus[]>> =
  Object.freeze({
    [Export.NOT_STARTED]: Object.freeze([Export.EXPORTING]),
    [Export.EXPORTING]: Object.freeze([Export.EXPORTED, Export.FAILED]),
    [Export.EXPORTED]: Object.freeze([Export.PURGED]),

    // Terminal.
    [Export.FAILED]: Object.freeze([]),
    [Export.PURGED]: Object.freeze([]),
  });

export const TERMINAL_EXPORT_STATUSES: readonly ExportStatus[] = Object.freeze(
  (Object.keys(EXPORT_TRANSITIONS) as ExportStatus[]).filter(
    (status) => EXPORT_TRANSITIONS[status].length === 0,
  ),
);

export function isTerminalExportStatus(status: ExportStatus): boolean {
  return EXPORT_TRANSITIONS[status].length === 0;
}

export function canExportTransition(from: ExportStatus, to: ExportStatus): boolean {
  return EXPORT_TRANSITIONS[from].includes(to);
}
