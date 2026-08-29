/**
 * Billing derivation. See the billing table in `docs/00-decisions.md` and
 * `docs/06-database-schema.md` §22.
 *
 * The amount is always derived here from the terminal status. A client can
 * supply `{"amount_paise": 2500}` all it likes; nothing in this module reads it.
 * Money is an integer number of paise — never a float, never rupees.
 */

import type { BillCategory, SessionStatus } from './enums.js';
import { BillCategory as Category, SessionStatus as Status } from './enums.js';

/** Rs 25. */
export const BILL_AMOUNT_SUCCESS_PAISE = 2500;

/** Rs 5. */
export const BILL_AMOUNT_FAILED_PAISE = 500;

/**
 * Why a session produced no billing entry.
 *
 * - `NOT_TERMINAL` — the session is still in flight. Billing is derived once, at
 *   the terminal status, inside the same transaction as the status write.
 * - `FAILED_BEFORE_QUEUE` — preflight, location, or consent failed before the
 *   session ever reached `QUEUED`, where billing eligibility starts. Invariant I5.
 */
export const BillingExemption = {
  NOT_TERMINAL: 'NOT_TERMINAL',
  FAILED_BEFORE_QUEUE: 'FAILED_BEFORE_QUEUE',
} as const;

export type BillingExemption = (typeof BillingExemption)[keyof typeof BillingExemption];

export interface BillableDecision {
  /** A `billing_entries` row must exist for this session. */
  readonly billable: true;
  readonly category: BillCategory;
  readonly amountPaise: number;
  readonly exemption: null;
}

export interface NonBillableDecision {
  /** No `billing_entries` row may exist for this session. */
  readonly billable: false;
  readonly category: null;
  readonly amountPaise: 0;
  readonly exemption: BillingExemption;
}

export type BillingDecision = BillableDecision | NonBillableDecision;

const NOT_TERMINAL: NonBillableDecision = Object.freeze({
  billable: false,
  category: null,
  amountPaise: 0,
  exemption: BillingExemption.NOT_TERMINAL,
});

const FAILED_BEFORE_QUEUE: NonBillableDecision = Object.freeze({
  billable: false,
  category: null,
  amountPaise: 0,
  exemption: BillingExemption.FAILED_BEFORE_QUEUE,
});

const SUCCESS: BillableDecision = Object.freeze({
  billable: true,
  category: Category.SUCCESS,
  amountPaise: BILL_AMOUNT_SUCCESS_PAISE,
  exemption: null,
});

const FAILED: BillableDecision = Object.freeze({
  billable: true,
  category: Category.FAILED,
  amountPaise: BILL_AMOUNT_FAILED_PAISE,
  exemption: null,
});

/**
 * Every session status mapped to its billing consequence.
 *
 * | Terminal outcome   | category  | paise | row  |
 * | ------------------ | --------- | ----: | ---- |
 * | `PREFLIGHT_FAILED` | —         |     0 | none |
 * | `APPROVED`         | `SUCCESS` |  2500 | yes  |
 * | `REJECTED`         | `FAILED`  |   500 | yes  |
 * | `ABORTED`          | `FAILED`  |   500 | yes  |
 * | `DROPPED_QUEUED`   | `FAILED`  |   500 | yes  |
 * | `DROPPED_IN_CALL`  | `FAILED`  |   500 | yes  |
 *
 * A `Record` keyed by the full enum rather than a `switch`: adding a status to
 * `SessionStatus` without deciding its billing rule stops the build, which is
 * exactly the failure we want.
 */
export const BILLING_BY_OUTCOME: Readonly<Record<SessionStatus, BillingDecision>> = Object.freeze({
  // In flight — billing is not derived yet.
  [Status.CREATED]: NOT_TERMINAL,
  [Status.QUEUED]: NOT_TERMINAL,
  [Status.OFFERED]: NOT_TERMINAL,
  [Status.IN_CALL]: NOT_TERMINAL,

  // Terminal, but failed before billing eligibility began.
  [Status.PREFLIGHT_FAILED]: FAILED_BEFORE_QUEUE,

  // Terminal outcomes after the session reached the queue.
  [Status.APPROVED]: SUCCESS,
  [Status.REJECTED]: FAILED,
  [Status.ABORTED]: FAILED,
  [Status.DROPPED_QUEUED]: FAILED,
  [Status.DROPPED_IN_CALL]: FAILED,
});

/**
 * The billing consequence of a session outcome.
 *
 * Non-terminal statuses return a non-billable decision carrying `NOT_TERMINAL`,
 * so a caller that asks too early gets a distinguishable answer rather than one
 * that looks like a genuine exemption.
 *
 * `OFFERED -> QUEUED` on offer timeout is not an outcome at all, so it never
 * reaches this function; the session is back in `QUEUED` and still in flight.
 */
export function getBillingForOutcome(status: SessionStatus): BillingDecision {
  return BILLING_BY_OUTCOME[status];
}

/** Does this outcome require a `billing_entries` row? */
export function isBillableOutcome(status: SessionStatus): boolean {
  return BILLING_BY_OUTCOME[status].billable;
}
