import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESENCES,
  AGENT_SETTABLE_PRESENCES,
  AgentPresence,
  BILL_CATEGORIES,
  BillCategory,
  EXPORT_STATUSES,
  ExportStatus,
  SESSION_STATUSES,
  SessionStatus,
  isAgentPresence,
  isBillCategory,
  isExportStatus,
  isSessionStatus,
} from './enums.js';

describe('SessionStatus', () => {
  it('holds exactly the ten approved values', () => {
    expect([...SESSION_STATUSES].sort()).toEqual(
      [
        'ABORTED',
        'APPROVED',
        'CREATED',
        'DROPPED_IN_CALL',
        'DROPPED_QUEUED',
        'IN_CALL',
        'OFFERED',
        'PREFLIGHT_FAILED',
        'QUEUED',
        'REJECTED',
      ].sort(),
    );
  });

  it('carries no evidence state - that axis is export_status (D3)', () => {
    for (const leaked of ['EXPORTING', 'EXPORTED', 'EXPORT_FAILED', 'PURGED', 'NOT_STARTED']) {
      expect(SESSION_STATUSES).not.toContain(leaked);
    }
  });

  it('serialises each member to its own name', () => {
    for (const [key, value] of Object.entries(SessionStatus)) {
      expect(value).toBe(key);
    }
  });
});

describe('ExportStatus', () => {
  it('holds exactly the five approved values', () => {
    expect([...EXPORT_STATUSES].sort()).toEqual(
      ['EXPORTED', 'EXPORTING', 'FAILED', 'NOT_STARTED', 'PURGED'].sort(),
    );
  });

  it('uses FAILED, not EXPORT_FAILED - the superseded name is gone', () => {
    expect(EXPORT_STATUSES).toContain(ExportStatus.FAILED);
    expect(EXPORT_STATUSES).not.toContain('EXPORT_FAILED');
  });
});

describe('AgentPresence', () => {
  it('holds exactly the three approved values', () => {
    expect([...AGENT_PRESENCES].sort()).toEqual(['AVAILABLE', 'BUSY', 'UNAVAILABLE'].sort());
  });

  it('excludes BUSY from what an agent may set on itself (R5)', () => {
    expect([...AGENT_SETTABLE_PRESENCES].sort()).toEqual(
      [AgentPresence.AVAILABLE, AgentPresence.UNAVAILABLE].sort(),
    );
    expect(AGENT_SETTABLE_PRESENCES).not.toContain(AgentPresence.BUSY);
  });
});

describe('BillCategory', () => {
  it('holds exactly SUCCESS and FAILED', () => {
    expect([...BILL_CATEGORIES].sort()).toEqual([BillCategory.FAILED, BillCategory.SUCCESS].sort());
  });
});

describe('type guards', () => {
  it('accepts every member of its own enum', () => {
    for (const status of SESSION_STATUSES) expect(isSessionStatus(status)).toBe(true);
    for (const status of EXPORT_STATUSES) expect(isExportStatus(status)).toBe(true);
    for (const presence of AGENT_PRESENCES) expect(isAgentPresence(presence)).toBe(true);
    for (const category of BILL_CATEGORIES) expect(isBillCategory(category)).toBe(true);
  });

  it.each([undefined, null, 0, 1, '', 'created', 'Approved', {}, [], true])(
    'rejects %p',
    (value) => {
      expect(isSessionStatus(value)).toBe(false);
      expect(isExportStatus(value)).toBe(false);
      expect(isAgentPresence(value)).toBe(false);
      expect(isBillCategory(value)).toBe(false);
    },
  );

  it('does not confuse the two status axes', () => {
    // FAILED is a valid ExportStatus and not a valid SessionStatus.
    expect(isExportStatus(ExportStatus.FAILED)).toBe(true);
    expect(isSessionStatus(ExportStatus.FAILED)).toBe(false);
  });

  it('is case sensitive - the database stores these values verbatim', () => {
    expect(isSessionStatus('in_call')).toBe(false);
    expect(isSessionStatus(SessionStatus.IN_CALL)).toBe(true);
  });
});

describe('immutability', () => {
  it.each([
    ['SESSION_STATUSES', SESSION_STATUSES],
    ['EXPORT_STATUSES', EXPORT_STATUSES],
    ['AGENT_PRESENCES', AGENT_PRESENCES],
    ['AGENT_SETTABLE_PRESENCES', AGENT_SETTABLE_PRESENCES],
    ['BILL_CATEGORIES', BILL_CATEGORIES],
  ])('freezes %s', (_name, values) => {
    expect(Object.isFrozen(values)).toBe(true);
  });
});
