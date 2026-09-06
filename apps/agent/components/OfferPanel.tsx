'use client';

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { AgentMessage } from '../lib/errors';
import { formatCountdown, remainingSeconds } from '../lib/offer';
import { shortId } from '../lib/queue';

/**
 * A session this agent is holding, and the window to take it up.
 *
 * The countdown is the part worth reading carefully. `offer_expires_at` comes
 * from the server, and the number rendered here is derived from it and the
 * browser's clock — so it is a **hint about how long is left**, never a
 * statement that the offer has ended. When it reaches zero this component says
 * so and nothing else: it does not hide the session, disable the button, or
 * report the work as lost. The portal re-reads the session and the server says
 * what happened, which is the only opinion that counts (D1).
 *
 * That distinction is not pedantry. A tab whose clock is a minute fast would
 * otherwise decide, on its own, that work the agent is still holding is gone —
 * and the agent would have no way to reach a session that is genuinely theirs.
 *
 * The ring is the same hint drawn twice. Its scale is the largest remaining
 * value this component has seen for this session, which is the window as the
 * server issued it — not a duration this app knows or hard-codes. It is
 * decoration over the number, and like the number it decides nothing.
 *
 * Accepting sends the session id and nothing else. There is no field here
 * through which an agent could name a different session, a different agent, or
 * a different room.
 */
export interface OfferPanelProps {
  readonly sessionId: string;
  /** Server-issued. Null when a reload recovered the offer without it. */
  readonly offerExpiresAt: string | null;
  /** Injected so the countdown is testable and the component stays pure. */
  readonly nowMs: number;
  readonly onAccept: () => void;
  readonly accepting: boolean;
  readonly error: AgentMessage | null;
}

export function OfferPanel({
  sessionId,
  offerExpiresAt,
  nowMs,
  onAccept,
  accepting,
  error,
}: OfferPanelProps) {
  const left = remainingSeconds(offerExpiresAt, nowMs);
  const lapsed = offerExpiresAt !== null && left === 0;
  const fraction = useFractionLeft(sessionId, left);

  return (
    <section className="card offer offer-card">
      <p className="eyebrow">Offered to you</p>
      <h1>A customer is waiting</h1>

      <div
        className={lapsed ? 'ring out' : 'ring'}
        style={{ '--pct': fraction } as CSSProperties}
        aria-hidden="true"
      >
        <div className="ring-face">
          <span className="countdown">{offerExpiresAt === null ? '—' : formatCountdown(left)}</span>
          <span className="countdown-unit">{offerExpiresAt === null ? 'unknown' : 'left'}</span>
        </div>
      </div>

      <p className="visually-hidden" aria-live="off">
        {offerExpiresAt === null
          ? 'Time remaining is unknown.'
          : `${formatCountdown(left)} left to take this up.`}
      </p>

      <div className="actions">
        <button type="button" className="primary" onClick={onAccept} disabled={accepting}>
          {accepting ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Accepting…
            </>
          ) : (
            'Accept'
          )}
        </button>
      </div>

      {lapsed ? (
        <p className="muted">
          The window shown here has run out. Checking with the server — if it lapsed, the customer
          goes back to the queue for someone else.
        </p>
      ) : (
        <p className="hint">
          Accept before the timer runs out. If you do not, the customer returns to the queue and
          keeps their place.
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>Session</dt>
          <dd title={sessionId}>{shortId(sessionId)}</dd>
        </div>
      </dl>

      {error === null ? null : (
        <div className="notice bad" role="alert">
          <h3>{error.title}</h3>
          <p>{error.detail}</p>
          {error.requestId === null ? null : <p className="ref">Reference {error.requestId}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * How full the ring is, from 1 down to 0.
 *
 * The denominator is observed rather than configured: the first render of an
 * offer sees very nearly the whole window, so the largest value seen is the
 * window. That keeps the tenant's timeout where it belongs — on the server —
 * and means a tenant who lengthens it gets a ring that still empties evenly,
 * with nothing in this app to update.
 *
 * Reset when the session changes, so a second offer does not inherit the
 * first one's scale.
 */
function useFractionLeft(sessionId: string, left: number): number {
  const seen = useRef<{ id: string; widest: number }>({ id: sessionId, widest: 0 });
  if (seen.current.id !== sessionId) seen.current = { id: sessionId, widest: 0 };
  if (left > seen.current.widest) seen.current.widest = left;

  const { widest } = seen.current;
  return widest === 0 ? 0 : Math.min(1, left / widest);
}
