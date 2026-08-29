import { describe, expect, it } from 'vitest';
import { BillCategory, SESSION_STATUSES, SessionStatus } from './enums.js';
import {
  BILLING_BY_OUTCOME,
  BILL_AMOUNT_FAILED_PAISE,
  BILL_AMOUNT_SUCCESS_PAISE,
  BillingExemption,
  getBillingForOutcome,
  isBillableOutcome,
} from './billing.js';
import { TERMINAL_SESSION_STATUSES, isTerminalSessionStatus } from './state-machine.js';

describe('getBillingForOutcome - approved', () => {
  it('bills APPROVED as SUCCESS, 2500 paise', () => {
    const decision = getBillingForOutcome(SessionStatus.APPROVED);
    expect(decision).toEqual({
      billable: true,
      category: BillCategory.SUCCESS,
      amountPaise: 2500,
      exemption: null,
    });
  });

  it('is the only SUCCESS outcome in the whole enum', () => {
    const success = SESSION_STATUSES.filter(
      (status) => getBillingForOutcome(status).category === BillCategory.SUCCESS,
    );
    expect(success).toEqual([SessionStatus.APPROVED]);
  });
});

describe('getBillingForOutcome - failed post-queue outcomes', () => {
  const FAILED_OUTCOMES: readonly SessionStatus[] = [
    SessionStatus.REJECTED,
    SessionStatus.ABORTED,
    SessionStatus.DROPPED_QUEUED,
    SessionStatus.DROPPED_IN_CALL,
  ];

  it.each(FAILED_OUTCOMES)('bills %s as FAILED, 500 paise', (status) => {
    expect(getBillingForOutcome(status)).toEqual({
      billable: true,
      category: BillCategory.FAILED,
      amountPaise: 500,
      exemption: null,
    });
  });

  it('bills REJECTED the same as ABORTED - a verdict of no is still work done', () => {
    expect(getBillingForOutcome(SessionStatus.REJECTED)).toEqual(
      getBillingForOutcome(SessionStatus.ABORTED),
    );
  });

  it('bills ABORTED and DROPPED_IN_CALL identically, per R4', () => {
    expect(getBillingForOutcome(SessionStatus.ABORTED)).toEqual(
      getBillingForOutcome(SessionStatus.DROPPED_IN_CALL),
    );
  });

  it('covers exactly these four as the FAILED outcomes', () => {
    const failed = SESSION_STATUSES.filter(
      (status) => getBillingForOutcome(status).category === BillCategory.FAILED,
    );
    expect([...failed].sort()).toEqual([...FAILED_OUTCOMES].sort());
  });
});

describe('getBillingForOutcome - no billing before the queue', () => {
  it('produces no billing entry for PREFLIGHT_FAILED (invariant I5)', () => {
    const decision = getBillingForOutcome(SessionStatus.PREFLIGHT_FAILED);
    expect(decision).toEqual({
      billable: false,
      category: null,
      amountPaise: 0,
      exemption: BillingExemption.FAILED_BEFORE_QUEUE,
    });
  });

  it('distinguishes a pre-queue failure from a session merely still in flight', () => {
    expect(getBillingForOutcome(SessionStatus.PREFLIGHT_FAILED).exemption).toBe(
      BillingExemption.FAILED_BEFORE_QUEUE,
    );
    expect(getBillingForOutcome(SessionStatus.CREATED).exemption).toBe(
      BillingExemption.NOT_TERMINAL,
    );
  });
});

describe('getBillingForOutcome - sessions still in flight', () => {
  const IN_FLIGHT: readonly SessionStatus[] = [
    SessionStatus.CREATED,
    SessionStatus.QUEUED,
    SessionStatus.OFFERED,
    SessionStatus.IN_CALL,
  ];

  it.each(IN_FLIGHT)('does not bill %s', (status) => {
    expect(getBillingForOutcome(status)).toEqual({
      billable: false,
      category: null,
      amountPaise: 0,
      exemption: BillingExemption.NOT_TERMINAL,
    });
  });

  it('does not bill a session returned to QUEUED by an expired offer', () => {
    // OFFERED -> QUEUED is not an outcome. Neither end of that transition bills.
    expect(isBillableOutcome(SessionStatus.OFFERED)).toBe(false);
    expect(isBillableOutcome(SessionStatus.QUEUED)).toBe(false);
  });

  it('bills nothing extra when the same session is offered and expires repeatedly', () => {
    const cycle = [SessionStatus.QUEUED, SessionStatus.OFFERED, SessionStatus.QUEUED];
    const total = cycle.reduce((sum, status) => sum + getBillingForOutcome(status).amountPaise, 0);
    expect(total).toBe(0);
  });

  it('bills 500 once the same session is finally dropped from the queue', () => {
    expect(getBillingForOutcome(SessionStatus.DROPPED_QUEUED).amountPaise).toBe(500);
  });
});

describe('billing table integrity', () => {
  it('covers every session status', () => {
    expect(Object.keys(BILLING_BY_OUTCOME).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('bills every terminal status except PREFLIGHT_FAILED', () => {
    const billed = TERMINAL_SESSION_STATUSES.filter((status) => isBillableOutcome(status));
    const unbilled = TERMINAL_SESSION_STATUSES.filter((status) => !isBillableOutcome(status));
    expect(unbilled).toEqual([SessionStatus.PREFLIGHT_FAILED]);
    expect(billed).toHaveLength(5);
  });

  it('never bills a non-terminal status', () => {
    for (const status of SESSION_STATUSES) {
      if (!isTerminalSessionStatus(status)) expect(isBillableOutcome(status)).toBe(false);
    }
  });

  it('only ever uses the two approved amounts', () => {
    for (const status of SESSION_STATUSES) {
      expect([0, BILL_AMOUNT_FAILED_PAISE, BILL_AMOUNT_SUCCESS_PAISE]).toContain(
        getBillingForOutcome(status).amountPaise,
      );
    }
  });

  it('keeps every amount an integer number of paise', () => {
    for (const status of SESSION_STATUSES) {
      expect(Number.isInteger(getBillingForOutcome(status).amountPaise)).toBe(true);
    }
  });

  it('pairs a category with a non-zero amount, and no category with zero', () => {
    for (const status of SESSION_STATUSES) {
      const decision = getBillingForOutcome(status);
      if (decision.billable) {
        expect(decision.category).not.toBeNull();
        expect(decision.amountPaise).toBeGreaterThan(0);
        expect(decision.exemption).toBeNull();
      } else {
        expect(decision.category).toBeNull();
        expect(decision.amountPaise).toBe(0);
        expect(decision.exemption).not.toBeNull();
      }
    }
  });

  it('holds the approved amounts: Rs 25 and Rs 5 in paise', () => {
    expect(BILL_AMOUNT_SUCCESS_PAISE).toBe(2500);
    expect(BILL_AMOUNT_FAILED_PAISE).toBe(500);
  });

  it('is deterministic - the same status always yields the same decision', () => {
    for (const status of SESSION_STATUSES) {
      expect(getBillingForOutcome(status)).toBe(getBillingForOutcome(status));
    }
  });

  it('returns frozen decisions, so a caller cannot mutate the shared instance', () => {
    for (const status of SESSION_STATUSES) {
      expect(Object.isFrozen(getBillingForOutcome(status))).toBe(true);
    }
  });
});
