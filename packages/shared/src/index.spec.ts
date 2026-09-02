import { describe, expect, it } from 'vitest';
import * as shared from './index.js';

/**
 * The public surface of `@vcip/shared`. `apps/api` and the browser apps import
 * from the package root, so anything missing here is a break for a consumer
 * even when the module it lives in still compiles.
 */
const PUBLIC_SURFACE: readonly string[] = [
  // enums
  'SessionStatus',
  'SESSION_STATUSES',
  'ExportStatus',
  'EXPORT_STATUSES',
  'AgentPresence',
  'AGENT_PRESENCES',
  'AGENT_SETTABLE_PRESENCES',
  'BillCategory',
  'BILL_CATEGORIES',
  'isSessionStatus',
  'isExportStatus',
  'isAgentPresence',
  'isBillCategory',

  // AI vocabulary (T30). Persisted in `session_ai_summaries` and mirrored by
  // hand in `apps/ai`, which cannot import this package.
  'LivenessStatus',
  'LIVENESS_STATUSES',
  'OcrStatus',
  'OCR_STATUSES',
  'isLivenessStatus',
  'isOcrStatus',

  // state machine
  'SESSION_TRANSITIONS',
  'TERMINAL_SESSION_STATUSES',
  'BILLING_ELIGIBILITY_START',
  'canTransition',
  'transitionsFrom',
  'isTerminalSessionStatus',
  'EXPORT_TRANSITIONS',
  'TERMINAL_EXPORT_STATUSES',
  'canExportTransition',
  'isTerminalExportStatus',

  // billing
  'BILL_AMOUNT_SUCCESS_PAISE',
  'BILL_AMOUNT_FAILED_PAISE',
  'BillingExemption',
  'BILLING_BY_OUTCOME',
  'getBillingForOutcome',
  'isBillableOutcome',

  // errors
  'ErrorCode',
  'ERROR_CODES',
  'ERROR_HTTP_STATUS',
  'httpStatusForErrorCode',
  'isErrorCode',
  'DomainError',
  'isDomainError',
  'toApiErrorBody',

  // realtime notification vocabulary (T27, R3) — deliberately separate from
  // the session-event names above: one is an append-only audit record, the
  // other a best-effort push.
  'CustomerEvent',
  'CUSTOMER_EVENTS',
  'AgentEvent',
  'AGENT_EVENTS',
  'REALTIME_EVENTS',
  'RealtimeAudience',
  'isCustomerEvent',
  'isAgentEvent',
  'mayReceive',
  'realtimeMessage',

  // session events
  'SessionEventType',
  'SESSION_EVENT_TYPES',
  'isSessionEventType',

  // wire-contract schemas
  'createSessionSchema',
  'consentSchema',
  'preflightSchema',
  'locationSchema',
  'PREFLIGHT_MEASUREMENTS',
  'LOCATION_CHECKS',
  'agentLoginSchema',
  'agentAvailabilitySchema',
  'agentAcceptSchema',
  'agentClaimSchema',
  'agentHeartbeatSchema',
  'AGENT_AVAILABILITY_VALUES',
  'aiResultSchema',
  'analyzeRequestSchema',
  'AI_HUD_STALE_AFTER_MS',
  'LIVENESS_STATUS_VALUES',
  'OCR_STATUS_VALUES',
  'checklistItemSchema',
  'checklistItemsSchema',
  'CHECKLIST_ITEM_KEY_PATTERN',
];

describe('package entry point', () => {
  it.each(PUBLIC_SURFACE)('re-exports %s', (name) => {
    expect(shared).toHaveProperty(name);
  });

  it('exports nothing beyond the declared surface', () => {
    expect(Object.keys(shared).sort()).toEqual([...PUBLIC_SURFACE].sort());
  });
});

describe('purity', () => {
  it('resolves the whole domain without any runtime configuration', () => {
    // No connection string, no Redis client, no Nest container. If any module
    // in the package needed one, importing the entry point would already have
    // thrown before this assertion ran.
    expect(shared.canTransition(shared.SessionStatus.QUEUED, shared.SessionStatus.OFFERED)).toBe(
      true,
    );
    expect(shared.getBillingForOutcome(shared.SessionStatus.APPROVED).amountPaise).toBe(2500);
  });

  it('agrees between the state machine and the billing table', () => {
    // The two modules are independent, but a status that bills must be one the
    // machine can actually reach and stop at.
    for (const status of shared.SESSION_STATUSES) {
      if (shared.isBillableOutcome(status)) {
        expect(shared.isTerminalSessionStatus(status)).toBe(true);
      }
    }
  });

  it('models the documented happy path end to end', () => {
    const path = [
      shared.SessionStatus.CREATED,
      shared.SessionStatus.QUEUED,
      shared.SessionStatus.OFFERED,
      shared.SessionStatus.IN_CALL,
      shared.SessionStatus.APPROVED,
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(
        shared.canTransition(path[i] as shared.SessionStatus, path[i + 1] as shared.SessionStatus),
      ).toBe(true);
    }
    const final = shared.getBillingForOutcome(path[path.length - 1] as shared.SessionStatus);
    expect(final.billable).toBe(true);
    expect(final.amountPaise).toBe(shared.BILL_AMOUNT_SUCCESS_PAISE);
    expect(shared.isTerminalSessionStatus(shared.SessionStatus.APPROVED)).toBe(true);
  });

  it('models the documented preflight-failure path end to end', () => {
    expect(
      shared.canTransition(shared.SessionStatus.CREATED, shared.SessionStatus.PREFLIGHT_FAILED),
    ).toBe(true);
    const decision = shared.getBillingForOutcome(shared.SessionStatus.PREFLIGHT_FAILED);
    expect(decision.billable).toBe(false);
    expect(decision.amountPaise).toBe(0);
  });
});
