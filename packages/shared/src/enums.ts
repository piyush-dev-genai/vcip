/**
 * Approved MVP enums. See `docs/00-decisions.md` D3 and `docs/03-system-design.md` §13.
 *
 * These are const objects plus string-literal union types rather than TypeScript
 * `enum`s. The values are persisted verbatim in PostgreSQL and cross the API
 * boundary as JSON strings, so the runtime representation must be the string
 * itself and nothing else.
 */

/**
 * `sessions.status` — the business lifecycle axis.
 *
 * Deliberately separate from {@link ExportStatus}. A terminal business status is
 * final and is never overwritten by evidence processing.
 */
export const SessionStatus = {
  CREATED: 'CREATED',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  QUEUED: 'QUEUED',
  OFFERED: 'OFFERED',
  IN_CALL: 'IN_CALL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  ABORTED: 'ABORTED',
  DROPPED_QUEUED: 'DROPPED_QUEUED',
  DROPPED_IN_CALL: 'DROPPED_IN_CALL',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const SESSION_STATUSES: readonly SessionStatus[] = Object.freeze(
  Object.values(SessionStatus),
);

/**
 * `sessions.export_status` — the evidence lifecycle axis.
 *
 * `EXPORTING` covers the whole retry loop; `FAILED` means retries are exhausted
 * and is therefore terminal. See D22.
 */
export const ExportStatus = {
  NOT_STARTED: 'NOT_STARTED',
  EXPORTING: 'EXPORTING',
  EXPORTED: 'EXPORTED',
  FAILED: 'FAILED',
  PURGED: 'PURGED',
} as const;

export type ExportStatus = (typeof ExportStatus)[keyof typeof ExportStatus];

export const EXPORT_STATUSES: readonly ExportStatus[] = Object.freeze(Object.values(ExportStatus));

/**
 * Agent availability. See R5: `AVAILABLE` and `UNAVAILABLE` are settable by the
 * agent; `BUSY` is internal — set on claim, cleared on session end.
 */
export const AgentPresence = {
  AVAILABLE: 'AVAILABLE',
  BUSY: 'BUSY',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type AgentPresence = (typeof AgentPresence)[keyof typeof AgentPresence];

export const AGENT_PRESENCES: readonly AgentPresence[] = Object.freeze(
  Object.values(AgentPresence),
);

/**
 * Presence values an agent may set on itself. `BUSY` is excluded: it is derived
 * from claim state, never client-supplied.
 */
export const AGENT_SETTABLE_PRESENCES: readonly AgentPresence[] = Object.freeze([
  AgentPresence.AVAILABLE,
  AgentPresence.UNAVAILABLE,
]);

/**
 * `billing_entries.bill_category`. See the billing table in `docs/00-decisions.md`.
 */
export const BillCategory = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export type BillCategory = (typeof BillCategory)[keyof typeof BillCategory];

export const BILL_CATEGORIES: readonly BillCategory[] = Object.freeze(Object.values(BillCategory));

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isExportStatus(value: unknown): value is ExportStatus {
  return typeof value === 'string' && (EXPORT_STATUSES as readonly string[]).includes(value);
}

export function isAgentPresence(value: unknown): value is AgentPresence {
  return typeof value === 'string' && (AGENT_PRESENCES as readonly string[]).includes(value);
}

export function isBillCategory(value: unknown): value is BillCategory {
  return typeof value === 'string' && (BILL_CATEGORIES as readonly string[]).includes(value);
}
