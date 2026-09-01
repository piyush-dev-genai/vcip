'use client';

import { shortId } from '../lib/queue';

/**
 * The session this agent has accepted.
 *
 * A placeholder, and honestly labelled as one. The session is genuinely
 * `IN_CALL` in PostgreSQL and the room name is genuinely the one the row has
 * carried since creation — but there is no video here, because joining a
 * LiveKit room, the AI panel, the checklist and the verdict are later tasks.
 * Showing a fake video frame or a dead "End call" button would be claiming
 * capability the system does not have.
 *
 * What it does prove, and what Day 2 needs it to prove, is that an agent can
 * get from a queued customer to an assigned call through the browser, and back
 * again after a reload.
 *
 * There is no control here that ends the session or hands it to someone else.
 * Every one of those is a state transition, and none of them exists yet.
 */
export interface CallPanelProps {
  readonly sessionId: string;
  /** From the server. Null only if the column was somehow unset. */
  readonly roomName: string | null;
}

export function CallPanel({ sessionId, roomName }: CallPanelProps) {
  return (
    <section className="card call">
      <h2>In call</h2>

      <dl className="facts">
        <div>
          <dt>Session</dt>
          <dd title={sessionId}>{shortId(sessionId)}</dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd className="room">{roomName ?? 'none'}</dd>
        </div>
      </dl>

      <p className="muted">
        This session is yours. Video, the AI panel, the checklist and the verdict arrive in later
        steps; nothing on this screen is live yet.
      </p>

      <p className="ref">
        Reloading this page brings you back here. The session stays yours until it is completed.
      </p>
    </section>
  );
}
