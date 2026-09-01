'use client';

import type { QueuedSession } from '../lib/api';
import type { AgentMessage } from '../lib/errors';
import { formatWait, shortId } from '../lib/queue';

/**
 * The waiting customers, and the one action a row offers.
 *
 * Until T21 this list was strictly read-only, because the claim endpoint did
 * not exist yet and a disabled button would have been half a feature. It now
 * takes a session, and the row's button is the whole of that: it names a
 * session id and nothing else. There is no agent id, no tenant id, and no
 * status here for a caller to influence — the server reads all three from the
 * JWT and from the row it already holds.
 *
 * Only one claim can be in flight at a time, and every row is disabled while it
 * is. An agent double-clicking should not fire a second operation, and an agent
 * who is already holding work should not be offered a second session the API
 * would refuse on `max_concurrent` anyway.
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
  /** The session id, and only the session id. */
  readonly onClaim: (sessionId: string) => void;
  /** The session currently being claimed, or null. */
  readonly claiming: string | null;
}

export function QueuePanel({
  sessions,
  loadedAt,
  error,
  onRefresh,
  refreshing,
  onClaim,
  claiming,
}: QueuePanelProps) {
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
              <button
                type="button"
                className="claim"
                onClick={() => {
                  onClaim(session.session_id);
                }}
                disabled={claiming !== null}
              >
                {claiming === session.session_id ? 'Claiming...' : 'Claim'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {sessions.length === 0 ? null : (
        <p className="ref">
          {sessions.length} waiting, oldest first. Claiming holds one for you briefly; it is yours
          only once the server says so.
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
