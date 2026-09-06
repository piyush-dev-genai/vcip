'use client';

import { SessionStatus } from '@vcip/shared';
import type { SessionView } from '@/lib/session';
import { canAbort, canJoinQueue, gatesOf } from '@/lib/screen';

/**
 * Screen 4 — where a running verification stands.
 *
 * A view of what the server says, and nothing else. Every value on this screen
 * comes from `GET /v1/sessions/{id}`; none of it is remembered from the steps
 * that produced it, which is what makes a refresh land in the right place.
 *
 * It no longer renders finished verifications. Approved, rejected, aborted and
 * dropped sessions route to `Outcome` instead — this screen exists to say how
 * far along a verification is and what the customer may do next, and a session
 * that has ended has no next. Everything on it was either inapplicable to a
 * finished session or, in the case of the Join Queue button, actively wrong.
 *
 * A queued session with `queue_position: null` is still queued. The null means
 * Redis could not answer, and the screen says exactly that — `status` is what
 * states the session is in the queue, and it comes from PostgreSQL (D1).
 *
 * The abort button appears only where T12 actually permits the transition:
 * `QUEUED`, `OFFERED`, and `IN_CALL`. A session that never queued stays
 * `CREATED` and unbilled (D19), so there is nothing to abort and no button.
 */
export function Status({
  session,
  busy,
  refreshing,
  lastCheckedAt,
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
  /** Joins the queue. Only offered while the session is pre-queue and eligible. */
  onJoinQueue: () => void;
  onAbort: () => void;
  onRefresh: () => void;
}) {
  const gates = gatesOf(session);
  const queued = session.status === SessionStatus.QUEUED;
  const offered = session.status === SessionStatus.OFFERED;
  // Asked, not recomputed. This screen used to decide for itself that a
  // session with its gates passed and no queue place was "ready" — which is
  // true of every finished verification too. `canJoinQueue` is the routing
  // decision itself, so the button and the screen cannot disagree.
  const ready = canJoinQueue(session);

  return (
    <section className="card">
      <p className="step">Verification status</p>
      <h1>
        {queued
          ? 'Waiting for an agent'
          : offered
            ? 'An agent is joining'
            : ready
              ? 'Ready when you are'
              : 'Your verification'}
      </h1>

      <p className="muted">
        {queued
          ? 'You are in the queue. Please keep this page open — the call starts on its own.'
          : offered
            ? 'An agent has picked up your verification and is about to join the call.'
            : ready
              ? 'Your checks are done. Join the queue when you are ready to speak to an agent.'
              : 'Here is where your verification currently stands.'}
      </p>

      {queued ? (
        <div className="notice ok" aria-live="polite">
          <h3>
            <span className="dot live" aria-hidden="true" /> In the queue
          </h3>
          {session.queue_position === null ? (
            // Null is "we cannot tell right now", never "not queued". The
            // status above is the statement about being queued, and it comes
            // from PostgreSQL.
            <p>
              Your place in the queue is temporarily unavailable. You are still in the queue — it
              will reappear in a moment.
            </p>
          ) : (
            <p>
              You are number <strong>{session.queue_position}</strong> in line.
            </p>
          )}
        </div>
      ) : null}

      <ul className="gates">
        <Gate done={gates.consent} label="Consent" />
        <Gate done={gates.preflight} label="Camera, microphone, and connection" />
        <Gate done={gates.location} label="Location" />
      </ul>

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
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Joining…
              </>
            ) : (
              'Join the queue'
            )}
          </button>
        ) : null}

        <div className="actions inline">
          <button
            type="button"
            disabled={busy || refreshing}
            onClick={() => {
              onRefresh();
            }}
          >
            {refreshing ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Checking…
              </>
            ) : (
              'Refresh'
            )}
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
      </div>

      <p className="hint" aria-live="polite">
        Current state <span className="state">{session.status}</span>
        {lastCheckedAt === null ? null : <> · checked at {lastCheckedAt.toLocaleTimeString()}</>}
      </p>
    </section>
  );
}

function Gate({ done, label }: { done: boolean; label: string }) {
  return (
    <li>
      <span className={done ? 'mark done' : 'mark todo'} aria-hidden="true">
        {done ? '✓' : '·'}
      </span>
      <span>{label}</span>
      <span className="visually-hidden">{done ? ' done' : ' not done'}</span>
    </li>
  );
}
