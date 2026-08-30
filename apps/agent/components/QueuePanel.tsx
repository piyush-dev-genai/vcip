'use client';

import type { QueuedSession } from '../lib/api';
import type { AgentMessage } from '../lib/errors';
import { formatWait, shortId } from '../lib/queue';

/**
 * The waiting customers, read-only.
 *
 * Read-only is the whole design of this component and not merely its current
 * state: there is no button, no link, and no callback on a row. Claiming a
 * session is T18's, and a portal that shipped a disabled "Claim" control would
 * be shipping half of it.
 *
 * The list is rendered in the order the API returned it. It is not sorted,
 * filtered, or grouped here — the Control API already merged the agent's
 * language queues into one FIFO list, and re-ordering in the browser would put
 * a second, disagreeing answer on the screen.
 *
 * `wait_seconds` comes from the server on every read rather than being ticked
 * up locally between reads. A locally incremented timer would keep counting
 * through a network outage and show a confident number that nothing had
 * confirmed.
 */
export interface QueuePanelProps {
  readonly sessions: readonly QueuedSession[];
  /** Null until the first successful read: "not asked yet" is not "empty". */
  readonly loadedAt: number | null;
  readonly error: AgentMessage | null;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

export function QueuePanel({ sessions, loadedAt, error, onRefresh, refreshing }: QueuePanelProps) {
  return (
    <section className="card">
      <div className="queue-head">
        <h2>Waiting</h2>
        <button type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {loadedAt === null && error === null ? <p className="muted">Loading the queue...</p> : null}

      {loadedAt !== null && sessions.length === 0 ? (
        <p className="muted">No customers are waiting in your languages.</p>
      ) : null}

      {sessions.length === 0 ? null : (
        <ul className="queue">
          {sessions.map((session, index) => (
            <li key={session.session_id} className="queue-row">
              <span className="queue-rank">{index + 1}</span>
              <span className="queue-id" title={session.session_id}>
                {shortId(session.session_id)}
              </span>
              <span className="queue-lang">{session.language}</span>
              <span className="queue-wait">{formatWait(session.wait_seconds)}</span>
            </li>
          ))}
        </ul>
      )}

      {sessions.length === 0 ? null : (
        <p className="ref">
          {sessions.length} waiting, oldest first. Looking at this list changes nothing.
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
