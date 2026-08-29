import { describe, expect, it } from 'vitest';
import { SESSION_STATUSES, EXPORT_STATUSES, SessionStatus, ExportStatus } from './enums.js';
import {
  BILLING_ELIGIBILITY_START,
  EXPORT_TRANSITIONS,
  SESSION_TRANSITIONS,
  TERMINAL_EXPORT_STATUSES,
  TERMINAL_SESSION_STATUSES,
  canExportTransition,
  canTransition,
  isTerminalExportStatus,
  isTerminalSessionStatus,
  transitionsFrom,
} from './state-machine.js';

/**
 * The approved transitions, written out longhand. This is deliberately a second
 * copy of the table rather than a loop over `SESSION_TRANSITIONS`: a test that
 * derives its expectations from the implementation cannot catch the
 * implementation being wrong.
 */
const LEGAL: ReadonlyArray<readonly [SessionStatus, SessionStatus]> = [
  [SessionStatus.CREATED, SessionStatus.PREFLIGHT_FAILED],
  [SessionStatus.CREATED, SessionStatus.QUEUED],
  [SessionStatus.QUEUED, SessionStatus.OFFERED],
  [SessionStatus.QUEUED, SessionStatus.DROPPED_QUEUED],
  [SessionStatus.OFFERED, SessionStatus.IN_CALL],
  [SessionStatus.OFFERED, SessionStatus.QUEUED],
  [SessionStatus.OFFERED, SessionStatus.DROPPED_QUEUED],
  [SessionStatus.IN_CALL, SessionStatus.APPROVED],
  [SessionStatus.IN_CALL, SessionStatus.REJECTED],
  [SessionStatus.IN_CALL, SessionStatus.ABORTED],
  [SessionStatus.IN_CALL, SessionStatus.DROPPED_IN_CALL],
];

const TERMINAL: readonly SessionStatus[] = [
  SessionStatus.PREFLIGHT_FAILED,
  SessionStatus.APPROVED,
  SessionStatus.REJECTED,
  SessionStatus.ABORTED,
  SessionStatus.DROPPED_QUEUED,
  SessionStatus.DROPPED_IN_CALL,
];

const IN_FLIGHT: readonly SessionStatus[] = [
  SessionStatus.CREATED,
  SessionStatus.QUEUED,
  SessionStatus.OFFERED,
  SessionStatus.IN_CALL,
];

const pair = (from: SessionStatus, to: SessionStatus): string => from + ' -> ' + to;

describe('canTransition - every legal session transition', () => {
  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('allows exactly those pairs and no others', () => {
    const allowed: string[] = [];
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (canTransition(from, to)) allowed.push(pair(from, to));
      }
    }
    expect(allowed.sort()).toEqual(LEGAL.map(([f, t]) => pair(f, t)).sort());
  });
});

describe('canTransition - illegal session transitions', () => {
  it('rejects QUEUED -> IN_CALL: D4 routes every session through OFFERED', () => {
    expect(canTransition(SessionStatus.QUEUED, SessionStatus.IN_CALL)).toBe(false);
  });

  it('rejects CREATED -> IN_CALL, skipping the queue entirely', () => {
    expect(canTransition(SessionStatus.CREATED, SessionStatus.IN_CALL)).toBe(false);
  });

  it('rejects CREATED -> APPROVED, an unverified approval', () => {
    expect(canTransition(SessionStatus.CREATED, SessionStatus.APPROVED)).toBe(false);
  });

  it('rejects QUEUED -> APPROVED: a verdict requires a call', () => {
    expect(canTransition(SessionStatus.QUEUED, SessionStatus.APPROVED)).toBe(false);
  });

  it('rejects OFFERED -> APPROVED: the offer must be accepted first', () => {
    expect(canTransition(SessionStatus.OFFERED, SessionStatus.APPROVED)).toBe(false);
  });

  it('rejects IN_CALL -> QUEUED: a call does not return to the queue', () => {
    expect(canTransition(SessionStatus.IN_CALL, SessionStatus.QUEUED)).toBe(false);
  });

  it('rejects IN_CALL -> OFFERED: an accepted session is not re-offered', () => {
    expect(canTransition(SessionStatus.IN_CALL, SessionStatus.OFFERED)).toBe(false);
  });

  it('rejects IN_CALL -> DROPPED_QUEUED, the wrong drop for the wrong phase', () => {
    expect(canTransition(SessionStatus.IN_CALL, SessionStatus.DROPPED_QUEUED)).toBe(false);
  });

  it('rejects QUEUED -> DROPPED_IN_CALL, the wrong drop for the wrong phase', () => {
    expect(canTransition(SessionStatus.QUEUED, SessionStatus.DROPPED_IN_CALL)).toBe(false);
  });

  it('rejects CREATED -> PREFLIGHT_FAILED being reversed', () => {
    expect(canTransition(SessionStatus.PREFLIGHT_FAILED, SessionStatus.CREATED)).toBe(false);
  });

  it('rejects QUEUED -> PREFLIGHT_FAILED: preflight is decided before the queue', () => {
    expect(canTransition(SessionStatus.QUEUED, SessionStatus.PREFLIGHT_FAILED)).toBe(false);
  });

  it.each(SESSION_STATUSES)('rejects the self-transition %s -> itself', (status) => {
    expect(canTransition(status, status)).toBe(false);
  });
});

describe('OFFERED -> QUEUED (offer expiry)', () => {
  it('is legal - an unaccepted offer returns the session to the queue', () => {
    expect(canTransition(SessionStatus.OFFERED, SessionStatus.QUEUED)).toBe(true);
  });

  it('leaves the session non-terminal, so it can be offered again', () => {
    expect(isTerminalSessionStatus(SessionStatus.QUEUED)).toBe(false);
    expect(canTransition(SessionStatus.QUEUED, SessionStatus.OFFERED)).toBe(true);
  });

  it('survives a full expire / re-offer / accept round trip', () => {
    let status: SessionStatus = SessionStatus.QUEUED;
    for (const next of [SessionStatus.OFFERED, SessionStatus.QUEUED, SessionStatus.OFFERED]) {
      expect(canTransition(status, next)).toBe(true);
      status = next;
    }
    expect(canTransition(status, SessionStatus.IN_CALL)).toBe(true);
  });

  it('is distinct from OFFERED -> DROPPED_QUEUED, which R15 also allows', () => {
    expect(canTransition(SessionStatus.OFFERED, SessionStatus.DROPPED_QUEUED)).toBe(true);
  });
});

describe('terminal-state behaviour', () => {
  it('reports exactly the six documented terminal statuses', () => {
    expect([...TERMINAL_SESSION_STATUSES].sort()).toEqual([...TERMINAL].sort());
  });

  it.each(TERMINAL)('%s has no legal successor at all', (status) => {
    expect(isTerminalSessionStatus(status)).toBe(true);
    expect(transitionsFrom(status)).toEqual([]);
    for (const to of SESSION_STATUSES) {
      expect(canTransition(status, to)).toBe(false);
    }
  });

  it.each(IN_FLIGHT)('%s is not terminal', (status) => {
    expect(isTerminalSessionStatus(status)).toBe(false);
    expect(transitionsFrom(status).length).toBeGreaterThan(0);
  });

  it('never lets a terminal status be reopened by any other status', () => {
    for (const status of TERMINAL) {
      expect(transitionsFrom(status)).toHaveLength(0);
    }
  });
});

describe('table integrity', () => {
  it('covers every session status as a key', () => {
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('only ever targets known statuses', () => {
    for (const targets of Object.values(SESSION_TRANSITIONS)) {
      for (const to of targets) expect(SESSION_STATUSES).toContain(to);
    }
  });

  it('lists no duplicate targets', () => {
    for (const targets of Object.values(SESSION_TRANSITIONS)) {
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('is frozen, so no caller can widen the machine at runtime', () => {
    expect(Object.isFrozen(SESSION_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(SESSION_TRANSITIONS[SessionStatus.IN_CALL])).toBe(true);
  });

  it('makes every status reachable from CREATED', () => {
    const seen = new Set<SessionStatus>([SessionStatus.CREATED]);
    const stack: SessionStatus[] = [SessionStatus.CREATED];
    while (stack.length > 0) {
      const current = stack.pop() as SessionStatus;
      for (const next of transitionsFrom(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('starts billing eligibility at QUEUED', () => {
    expect(BILLING_ELIGIBILITY_START).toBe(SessionStatus.QUEUED);
  });
});

describe('export status is a separate axis', () => {
  const LEGAL_EXPORT: ReadonlyArray<readonly [ExportStatus, ExportStatus]> = [
    [ExportStatus.NOT_STARTED, ExportStatus.EXPORTING],
    [ExportStatus.EXPORTING, ExportStatus.EXPORTED],
    [ExportStatus.EXPORTING, ExportStatus.FAILED],
    [ExportStatus.EXPORTED, ExportStatus.PURGED],
  ];

  it.each(LEGAL_EXPORT)('allows %s -> %s', (from, to) => {
    expect(canExportTransition(from, to)).toBe(true);
  });

  it('allows exactly those four pairs', () => {
    const allowed: string[] = [];
    for (const from of EXPORT_STATUSES) {
      for (const to of EXPORT_STATUSES) {
        if (canExportTransition(from, to)) allowed.push(from + ' -> ' + to);
      }
    }
    expect(allowed.sort()).toEqual(LEGAL_EXPORT.map(([f, t]) => f + ' -> ' + t).sort());
  });

  it('treats FAILED as terminal - EXPORTING already covers the retry loop', () => {
    expect(isTerminalExportStatus(ExportStatus.FAILED)).toBe(true);
    expect(canExportTransition(ExportStatus.FAILED, ExportStatus.EXPORTING)).toBe(false);
  });

  it('treats PURGED as terminal', () => {
    expect(isTerminalExportStatus(ExportStatus.PURGED)).toBe(true);
  });

  it('reports FAILED and PURGED as the terminal export statuses', () => {
    expect([...TERMINAL_EXPORT_STATUSES].sort()).toEqual(
      [ExportStatus.FAILED, ExportStatus.PURGED].sort(),
    );
  });

  it('cannot purge evidence that was never exported', () => {
    expect(canExportTransition(ExportStatus.NOT_STARTED, ExportStatus.PURGED)).toBe(false);
    expect(canExportTransition(ExportStatus.EXPORTING, ExportStatus.PURGED)).toBe(false);
  });

  it('covers every export status and shares no key with the session table', () => {
    expect(Object.keys(EXPORT_TRANSITIONS).sort()).toEqual([...EXPORT_STATUSES].sort());
    const overlap = Object.keys(EXPORT_TRANSITIONS).filter((key) =>
      (SESSION_STATUSES as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });
});
