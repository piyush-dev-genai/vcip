'use client';

import { SessionStatus, isTerminalSessionStatus } from '@vcip/shared';
import type { AbortResult, SessionView } from '@/lib/session';
import { canAbort, canJoinQueue, gatesOf, outcomeMessage } from '@/lib/screen';

/**
 * Screen 4 — status.
 *
 * A view of what the server says, and nothing else. Every value on this screen
 * comes from `GET /v1/sessions/{id}`; none of it is remembered from the steps
 * that produced it, which is what makes a refresh land in the right place.
 *
 * Where it stops: T15 ends in the queue. The customer joins it here and then
 * waits; being offered to an agent is T18, and live position updates over a
 * WebSocket are T27. Until then the position moves when the customer refreshes.
 *
 * A queued session with `queue_position: null` is still queued. The null means
 * Redis could not answer, and the screen says exactly that — `status` is what
 * states the session is in the queue, and it comes from PostgreSQL (D1).
 *
 * The abort button appears only where T12 actually permits the transition:
 * `QUEUED`, `OFFERED`, and `IN_CALL`. A session that never queued stays
 * `CREATED` and unbilled (D19), so there is nothing to abort and no button. In
 * the T14 flow that means it does not appear at all — the state that would show
 * it arrives with the queue.
 */
export function Status({
  session,
  busy,
  refreshing,
  lastCheckedAt,
  aborted,
  onJoinQueue,
  onAbort,
  onRefresh,
}: {
  session: SessionView;
  busy: boolean;
  /** A status re-read is in flight. Distinct from `busy`, which guards mutations. */
  refreshing: boolean;
  /**
   * When the session was last read from the server.
   *
   * This is the screen's proof that the refresh button did something. A re-read
   * that returns an unchanged session renders identically, so without a value
   * that moves, the button looks broken — which is how it was first reported.
   */
  lastCheckedAt: Date | null;
  /** The server's own answer to an abort, rendered verbatim. */
  aborted: AbortResult | null;
  /** Joins the queue. Only offered while the session is pre-queue and eligible. */
  onJoinQueue: () => void;
  onAbort: () => void;
  onRefresh: () => void;
}) {
  const gates = gatesOf(session);
  const queued = session.status === SessionStatus.QUEUED;
  // Asked, not recomputed. This screen used to decide for itself that a
  // session with its gates passed and no queue place was "ready" — which is
  // true of every finished verification, so an approved or rejected session
  // offered a live "Join Queue" button. `canJoinQueue` is the routing
  // decision itself, so the button and the screen cannot disagree.
  const ready = canJoinQueue(session);
  const finished = isTerminalSessionStatus(session.status);
  const outcome = outcomeMessage(session);

  return (
    <section className="card">
      <p className="step">Verification status</p>
      <h1>
        {finished
          ? 'Verification complete'
          : queued
            ? 'In the queue'
            : ready
              ? 'Ready for an agent'
              : 'Verification status'}
      </h1>

      {finished ? (
        <p>{outcome ?? 'This verification has ended.'}</p>
      ) : queued ? (
        <p>
          You are in the queue. An agent will join your call shortly — please keep this page open.
        </p>
      ) : ready ? (
        <p>Your checks are complete. Join the queue when you are ready to speak to an agent.</p>
      ) : (
        <p>Here is where your verification currently stands.</p>
      )}

      {queued ? (
        <div className="notice ok" aria-live="polite">
          <h3>Waiting for an agent</h3>
          {session.queue_position === null ? (
            // Null is "we cannot tell right now", never "not queued". The
            // status above is the statement about being queued, and it comes
            // from PostgreSQL.
            <p className="muted">
              Your place in the queue is temporarily unavailable. You are still in the queue —
              refresh in a moment to see your position.
            </p>
          ) : (
            <p className="muted">
              Queue position: <strong>{session.queue_position}</strong>
            </p>
          )}
        </div>
      ) : null}

      <ul className="gates">
        <li>
          <span className={gates.consent ? 'mark done' : 'mark todo'}>
            {gates.consent ? '✓' : '·'}
          </span>
          <span>Consent</span>
        </li>
        <li>
          <span className={gates.preflight ? 'mark done' : 'mark todo'}>
            {gates.preflight ? '✓' : '·'}
          </span>
          <span>Camera, microphone, and connection</span>
        </li>
        <li>
          <span className={gates.location ? 'mark done' : 'mark todo'}>
            {gates.location ? '✓' : '·'}
          </span>
          <span>Location</span>
        </li>
      </ul>

      <p className="muted">
        Current state: <span className="state">{session.status}</span>
        {session.verdict === null ? null : (
          <>
            {' · '}Outcome: <span className="state">{session.verdict}</span>
          </>
        )}
      </p>

      {aborted === null ? null : (
        <div className="notice warn">
          <h3>Verification stopped</h3>
          <p className="muted">
            The session ended as <span className="state">{aborted.status}</span>.
            {aborted.bill_category === null
              ? ''
              : ` Charge category: ${aborted.bill_category} (${String(aborted.bill_amount_paise)} paise).`}
          </p>
        </div>
      )}

      {lastCheckedAt === null ? null : (
        <p className="muted" aria-live="polite">
          Last checked at {lastCheckedAt.toLocaleTimeString()}
        </p>
      )}

      <div className="actions">
        {ready ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              onJoinQueue();
            }}
          >
            {busy ? 'Joining…' : 'Join Queue'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || refreshing}
          onClick={() => {
            onRefresh();
          }}
        >
          {refreshing ? 'Checking…' : 'Refresh status'}
        </button>
        {canAbort(session) ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onAbort();
            }}
          >
            Stop verification
          </button>
        ) : null}
      </div>
    </section>
  );
}
