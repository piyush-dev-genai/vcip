/**
 * Canonical `session_events.event_type` values.
 *
 * `session_events` is the append-only explanation of how a session reached its
 * current state (invariant I10). `sessions.status` says where it is; this table
 * says how it got there, and these are the only names that may appear in it.
 *
 * The catalogue is `docs/06-database-schema.md` §15. That list is headed
 * "Example Events" and does not cover every transition the MVP performs, so two
 * names are added here and marked below. Nothing else is invented: a writer
 * needing a name that is not in this object should have the name added here
 * rather than passing a string literal, which is what keeps the vocabulary
 * closed and greppable.
 *
 * A const object rather than a TypeScript `enum`, for the same reason as
 * `SessionStatus`: these values are persisted verbatim and cross the JSON
 * boundary, so the runtime value must be the string itself.
 */

export const SessionEventType = {
  // --- creation and customer gates ---------------------------------------
  SESSION_CREATED: 'SESSION_CREATED',
  CONSENT_ACCEPTED: 'CONSENT_ACCEPTED',
  /**
   * Added beyond §15's catalogue.
   *
   * A customer declining consent is a material audit fact for a KYC product,
   * and the session stays `CREATED` rather than transitioning, so no status
   * change would record it. Without this name the decline leaves no trace.
   */
  CONSENT_REJECTED: 'CONSENT_REJECTED',
  PREFLIGHT_PASSED: 'PREFLIGHT_PASSED',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  LOCATION_PASSED: 'LOCATION_PASSED',
  LOCATION_FAILED: 'LOCATION_FAILED',

  // --- queue and assignment ----------------------------------------------
  SESSION_QUEUED: 'SESSION_QUEUED',
  SESSION_ASSIGNED: 'SESSION_ASSIGNED',
  AGENT_ACCEPTED: 'AGENT_ACCEPTED',

  /**
   * Added beyond §15's catalogue.
   *
   * An offer that lapses returns the session to `QUEUED` (D4, §17.3), which is
   * a status the session has already held. Recording that with
   * `SESSION_QUEUED` would make the audit trail unable to distinguish "the
   * customer joined the queue" from "an agent was offered this and let it
   * lapse" — exactly the distinction that explains why a customer waited
   * twice, and exactly what R15 and the billing table care about when asking
   * whether a wait was the product's fault.
   *
   * It is also not a terminal outcome and produces no billing row.
   */
  OFFER_EXPIRED: 'OFFER_EXPIRED',

  /**
   * Added beyond §15's catalogue.
   *
   * Covers customer-initiated termination on both paths — `QUEUED`/`OFFERED ->
   * DROPPED_QUEUED` and `IN_CALL -> ABORTED`. One name with the `from`/`to`
   * statuses in the payload, rather than one name per edge: the payload already
   * distinguishes them, and a name per edge would grow with the state machine.
   */
  SESSION_ABORTED: 'SESSION_ABORTED',

  // --- call --------------------------------------------------------------
  CALL_STARTED: 'CALL_STARTED',
  CALL_ENDED: 'CALL_ENDED',
  AGENT_DISCONNECTED: 'AGENT_DISCONNECTED',
  AGENT_RECONNECTED: 'AGENT_RECONNECTED',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',

  // --- outcome -----------------------------------------------------------
  VERDICT_SUBMITTED: 'VERDICT_SUBMITTED',
  BILLING_CREATED: 'BILLING_CREATED',

  // --- evidence ----------------------------------------------------------
  EGRESS_STARTED: 'EGRESS_STARTED',
  EGRESS_COMPLETED: 'EGRESS_COMPLETED',
  EXPORT_STARTED: 'EXPORT_STARTED',
  EXPORTED: 'EXPORTED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  PURGED: 'PURGED',
  WEBHOOK_CREATED: 'WEBHOOK_CREATED',
} as const;

export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = Object.freeze(
  Object.values(SessionEventType),
);

export function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === 'string' && (SESSION_EVENT_TYPES as readonly string[]).includes(value);
}
