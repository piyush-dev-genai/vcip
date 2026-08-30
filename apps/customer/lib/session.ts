/**
 * The session as the customer app sees it.
 *
 * This mirrors the response body of `GET /v1/sessions/{id}` — API contract §12,
 * as narrowed by the Control API's own allow-list projection. It is declared
 * here rather than imported because that projection lives inside `apps/api` and
 * is not part of `@vcip/shared`; the request schemas the browser sends *are*
 * shared, and are imported from there rather than retyped.
 *
 * Only the fields this app reads are declared. `queue_position` is present and
 * unread until T15 — it is null in every T14 response.
 */

import type { SessionStatus } from '@vcip/shared';

export interface SessionView {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly language: string;
  readonly room_name: string | null;
  readonly consent_ok: boolean;
  readonly preflight_ok: boolean;
  readonly geo_ok: boolean;
  readonly queue_position: number | null;
  readonly agent_connected: boolean;
  readonly queued_at: string | null;
  readonly connected_at: string | null;
  readonly ended_at: string | null;
  readonly verdict: string | null;
  readonly export_status: string;
}

/** `POST /v1/sessions/{id}/consent`. */
export interface ConsentResult {
  readonly session_id: string;
  readonly consent_ok: boolean;
  readonly status: SessionStatus;
}

/** `POST /v1/sessions/{id}/preflight` — the server's verdict, not ours (D11). */
export interface PreflightResult {
  readonly session_id: string;
  readonly preflight_ok: boolean;
  readonly status: SessionStatus;
  readonly failed_checks?: readonly string[];
}

/** `POST /v1/sessions/{id}/location`. */
export interface LocationResult {
  readonly session_id: string;
  readonly geo_ok: boolean;
  readonly status: SessionStatus;
  readonly failed_checks?: readonly string[];
}

/**
 * `POST /v1/sessions/{id}/abort`.
 *
 * The billing fields are server-derived and rendered exactly as received. The
 * customer app holds no billing rules and computes no amount.
 */
export interface AbortResult {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly bill_category: string | null;
  readonly bill_amount_paise: number;
}

/**
 * `POST /v1/sessions/{id}/queue`.
 *
 * `queue_position` is null when Redis could not answer. It never means "not
 * queued" — `status` is the statement about that, and it comes from a committed
 * PostgreSQL transaction.
 */
export interface QueueResult {
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly queue_position: number | null;
}
