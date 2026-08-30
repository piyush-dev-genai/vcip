/**
 * What `GET /v1/sessions/:id` returns.
 *
 * An explicit allow-list, not a filtered row. A projection built by removing
 * fields fails open: add a column later and it ships to the customer until
 * someone notices. This one fails closed — a new column is invisible until it
 * is named here.
 *
 * Deliberately absent, and why:
 *
 *   - `gps_accuracy_m`, `ip_country` — location detail. The customer submitted
 *     it; echoing it back serves nothing and widens the sensitive surface.
 *   - `external_ref` — the enterprise's own reference. It reaches the customer
 *     browser through no other channel, and it should not start here.
 *   - `checklist_template_id`, `agent_id`, `version`, `tenant_id` — internal
 *     identifiers with no client use.
 *   - `bill_category`, `bill_amount_paise` — billing is T35's, and a customer
 *     is not the party being billed.
 *   - the customer token — never re-issued in a response body.
 */

import type { SessionRow } from './session.repository.js';

export interface SessionView {
  readonly session_id: string;
  readonly status: string;
  readonly language: string;
  readonly room_name: string | null;
  readonly consent_ok: boolean;
  readonly preflight_ok: boolean;
  readonly geo_ok: boolean;
  /**
   * Position in the Redis queue, or null.
   *
   * Null means "not available": either the session is not queued, or Redis
   * could not answer. It never means "position zero", and it never contradicts
   * `status` — `status` is the statement about whether the session is queued,
   * and it comes from PostgreSQL (D1).
   */
  readonly queue_position: number | null;
  readonly agent_connected: boolean;
  readonly queued_at: string | null;
  readonly connected_at: string | null;
  readonly ended_at: string | null;
  readonly verdict: string | null;
  readonly export_status: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * Project a session row for the customer or agent reading it.
 *
 * The row comes from PostgreSQL, which is authoritative (D1). The queue
 * position is the one field that does not, so it arrives as an **argument**
 * rather than being fetched here: this function stays pure and synchronous,
 * testable without Redis, and incapable of deciding anything about the queue.
 * `SessionsService` asks `QueueService` and passes the answer in.
 *
 * It defaults to null so every caller that has no queue context — and every
 * test written before T15 — still produces a valid view.
 */
export function toSessionView(row: SessionRow, queuePosition: number | null = null): SessionView {
  return {
    session_id: row.id,
    status: row.status,
    language: row.language,
    room_name: row.roomName,
    consent_ok: row.consentOk,
    preflight_ok: row.preflightOk,
    geo_ok: row.geoOk,
    queue_position: queuePosition,
    // Derived from the timestamp the LiveKit webhook sets, not from Redis.
    agent_connected: row.connectedAt !== null && row.endedAt === null,
    queued_at: iso(row.queuedAt),
    connected_at: iso(row.connectedAt),
    ended_at: iso(row.endedAt),
    verdict: row.verdict,
    export_status: row.exportStatus,
  };
}

/** The exact key set of a `SessionView`, for the leak test to assert against. */
export const SESSION_VIEW_KEYS: readonly string[] = Object.freeze([
  'session_id',
  'status',
  'language',
  'room_name',
  'consent_ok',
  'preflight_ok',
  'geo_ok',
  'queue_position',
  'agent_connected',
  'queued_at',
  'connected_at',
  'ended_at',
  'verdict',
  'export_status',
]);
