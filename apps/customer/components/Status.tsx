'use client';

import type { AbortResult, SessionView } from '@/lib/session';
import { canAbort, gatesOf } from '@/lib/screen';

/**
 * Screen 4 — status.
 *
 * A view of what the server says, and nothing else. Every value on this screen
 * comes from `GET /v1/sessions/{id}`; none of it is remembered from the steps
 * that produced it, which is what makes a refresh land in the right place.
 *
 * Where it stops: T14 ends at "ready to join the queue". The queue endpoint is
 * T15 and is not called from here — the customer is told they are ready, and
 * that is the end of the implemented flow.
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
  onAbort: () => void;
  onRefresh: () => void;
}) {
  const gates = gatesOf(session);
  const ready = gates.consent && gates.preflight && gates.location;

  return (
    <section className="card">
      <p className="step">Verification status</p>
      <h1>{ready ? 'Ready for an agent' : 'Verification status'}</h1>

      {ready ? (
        <p>
          Your checks are complete. The next step is joining the queue for an agent, which is not
          part of this build yet.
        </p>
      ) : (
        <p>Here is where your verification currently stands.</p>
      )}

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
