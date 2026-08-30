'use client';

import type { AgentMessage } from '../lib/errors';
import { describe, SELECTABLE } from '../lib/presence';
import type { PresenceStatus } from '../lib/presence';

/**
 * The availability control.
 *
 * The buttons are generated from `SELECTABLE`, which is the shared contract's
 * list of settable presences. There is no hand-written `BUSY` button to forget
 * to remove, and adding one would mean changing the shared schema first — at
 * which point the server would have to accept it too.
 *
 * The status shown is always the one the *server* last reported, never a local
 * optimistic guess. The backend is authoritative: if a heartbeat comes back
 * saying `BUSY`, or saying the presence expired, the panel says so.
 */
export interface AvailabilityPanelProps {
  readonly status: PresenceStatus;
  readonly lastSeen: string | null;
  readonly busy: boolean;
  readonly error: AgentMessage | null;
  readonly onChange: (status: PresenceStatus) => Promise<void>;
  readonly onSignOut: () => void;
}

export function AvailabilityPanel({
  status,
  lastSeen,
  busy,
  error,
  onChange,
  onSignOut,
}: AvailabilityPanelProps) {
  const current = describe(status);

  return (
    <section className="card">
      <p className="step">Agent portal</p>
      <h1>Availability</h1>

      <div className={`notice ${current.tone === 'muted' ? '' : current.tone}`}>
        <h3>{current.label}</h3>
        <p>{current.detail}</p>
      </div>

      <div className="actions">
        {SELECTABLE.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={candidate === status ? '' : 'primary'}
            disabled={busy || candidate === status}
            onClick={() => void onChange(candidate)}
          >
            {describe(candidate).label}
          </button>
        ))}
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>

      <p className="muted">
        {status === 'UNAVAILABLE'
          ? 'Your presence is not being kept alive.'
          : 'Your presence is refreshed automatically while this page is open.'}
      </p>
      {lastSeen === null ? null : (
        <p className="ref">Last confirmed {new Date(lastSeen).toLocaleTimeString()}</p>
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
