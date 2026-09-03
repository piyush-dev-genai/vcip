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

/**
 * `session_ai_summaries.liveness_status` (`06-database-schema.md` §19,
 * `03-system-design.md` §17).
 *
 * `UNKNOWN` and `UNAVAILABLE` are both undecided and are not the same fact.
 * `UNKNOWN` means the check ran and could not tell; `UNAVAILABLE` means it
 * never ran. The agent HUD renders those differently — one is a signal about
 * the customer, the other a signal about us — so they stay distinct all the way
 * from the AI service to the column.
 *
 * `apps/ai` mirrors this list in Python. The dependency graph in
 * `05-development-plan.md` §4 makes that mirroring the contract between them:
 * the Python service cannot import this package, so this file and
 * `apps/ai/app/providers/results.py` are two statements of one vocabulary, each
 * with a test that pins the strings.
 */
export const LivenessStatus = {
  LIVE: 'LIVE',
  NOT_LIVE: 'NOT_LIVE',
  UNKNOWN: 'UNKNOWN',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type LivenessStatus = (typeof LivenessStatus)[keyof typeof LivenessStatus];

export const LIVENESS_STATUSES: readonly LivenessStatus[] = Object.freeze(
  Object.values(LivenessStatus),
);

/**
 * `session_ai_summaries.ocr_status`.
 *
 * The vocabulary is `05-api-contract.md` §23's (`"ocr_status": "PASS"`), not
 * the `DOCUMENT_DETECTED`/`OCR_PASS`/`OCR_FAILED` sketch in
 * `03-system-design.md` §19, which predates the contract the Control API
 * stores and is introduced there as what the output "can be".
 *
 * `NO_DOCUMENT` is an answer rather than a failure: OCR runs against a frame
 * the customer was asked to produce, and "nothing was being held up" is the
 * honest result. Reporting it as `FAIL` would put a red mark on the HUD for a
 * customer who has done nothing wrong.
 */
export const OcrStatus = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NO_DOCUMENT: 'NO_DOCUMENT',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type OcrStatus = (typeof OcrStatus)[keyof typeof OcrStatus];

export const OCR_STATUSES: readonly OcrStatus[] = Object.freeze(Object.values(OcrStatus));

export function isLivenessStatus(value: unknown): value is LivenessStatus {
  return typeof value === 'string' && (LIVENESS_STATUSES as readonly string[]).includes(value);
}

export function isOcrStatus(value: unknown): value is OcrStatus {
  return typeof value === 'string' && (OCR_STATUSES as readonly string[]).includes(value);
}

/**
 * Which identity document an agent asked to have read.
 *
 * A closed set, because each one has its own reader and its own registry: a PAN
 * is ten characters checked against one, an Aadhaar twelve digits checked
 * against another, and "whatever the customer held up" is not something either
 * can be asked about.
 *
 * The agent chooses this before the capture rather than the reader inferring it
 * afterwards. Inference is a second thing that can be wrong, and a document read
 * as the wrong type fails verification in a way that looks like a bad customer
 * rather than a bad guess.
 */
export const DocumentType = {
  AADHAAR: 'AADHAAR',
  PAN: 'PAN',
} as const;

export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

export const DOCUMENT_TYPES: readonly DocumentType[] = Object.freeze(Object.values(DocumentType));

/**
 * What came back from checking one document against its registry.
 *
 * Four outcomes, and the three that are not `VERIFIED` are deliberately not one
 * value. The agent needs to know whether to ask the customer to hold the card
 * still (`UNREADABLE`), to treat the document as suspect (`NOT_VERIFIED`), or to
 * disregard the panel and decide on what they can see (`UNAVAILABLE`).
 * Collapsing them leaves a red mark that carries no instruction.
 *
 *   - `VERIFIED` — the registry recognised the document.
 *   - `NOT_VERIFIED` — the registry was asked and did not recognise it.
 *   - `UNREADABLE` — the frames could not be read, so nothing was ever asked.
 *   - `UNAVAILABLE` — the check could not run at all: the verifier was
 *     unreachable, or no analysis was attached to the call.
 *
 * The last two draw the same distinction `OcrStatus` draws between
 * `NO_DOCUMENT` and `UNAVAILABLE`: one says the check ran and found nothing,
 * the other says it never ran.
 *
 * None of these decides anything (I7). The agent decides.
 */
export const DocumentCheckStatus = {
  VERIFIED: 'VERIFIED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  UNREADABLE: 'UNREADABLE',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type DocumentCheckStatus = (typeof DocumentCheckStatus)[keyof typeof DocumentCheckStatus];

export const DOCUMENT_CHECK_STATUSES: readonly DocumentCheckStatus[] = Object.freeze(
  Object.values(DocumentCheckStatus),
);

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function isDocumentCheckStatus(value: unknown): value is DocumentCheckStatus {
  return (
    typeof value === 'string' && (DOCUMENT_CHECK_STATUSES as readonly string[]).includes(value)
  );
}
