'use client';

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
 * so and nothing else: it does not hide the session, disable Accept, or report
 * it as lost. The portal re-reads the session and the server says what
 * happened, which is the only opinion that counts (D1).
 *
 * That distinction is not pedantry. A tab whose clock is a minute fast would
 * otherwise decide, on its own, that work the agent is still holding is gone —
 * and the agent would have no way to reach a session that is genuinely theirs.
 *
 * Accept sends the session id and nothing else. There is no field here through
 * which an agent could name a different session, a different agent, or a
 * different room.
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

  return (
    <section className="card offer">
      <h2>Offered to you</h2>

      <dl className="facts">
        <div>
          <dt>Session</dt>
          <dd title={sessionId}>{shortId(sessionId)}</dd>
        </div>
        <div>
          <dt>Time to accept</dt>
          <dd className={lapsed ? 'countdown out' : 'countdown'}>
            {offerExpiresAt === null ? 'unknown' : formatCountdown(left)}
          </dd>
        </div>
      </dl>

      <button type="button" className="primary" onClick={onAccept} disabled={accepting}>
        {accepting ? 'Accepting...' : 'Accept'}
      </button>

      {lapsed ? (
        <p className="muted">
          The window shown here has run out. Checking with the server — if it lapsed, the customer
          goes back to the queue for someone else.
        </p>
      ) : (
        <p className="ref">
          Accept before the timer runs out. If you do not, the customer returns to the queue and
          keeps their place.
        </p>
      )}

      {error === null ? null : (
        <div className="notice bad">
          <h3>{error.title}</h3>
          <p>{error.detail}</p>
          {error.requestId === null ? null : <p className="ref">Reference {error.requestId}</p>}
        </div>
      )}
    </section>
  );
}
