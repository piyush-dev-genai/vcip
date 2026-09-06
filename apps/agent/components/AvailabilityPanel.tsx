'use client';

import { describe, isSelectable, SELECTABLE } from '../lib/presence';
import type { PresenceStatus } from '../lib/presence';

/**
 * The availability control.
 *
 * The buttons are generated from `SELECTABLE`, which is the shared contract's
 * list of settable presences. There is no hand-written third button to forget
 * to remove, and adding one would mean changing the shared schema first — at
 * which point the server would have to accept it too.
 *
 * The status shown is always the one the *server* last reported, never a local
 * optimistic guess. The backend is authoritative: if a heartbeat comes back
 * saying the agent is in a verification, or saying the presence expired, the
 * control says so — and in the first case the segmented control is inert,
 * because that value is not one an agent may choose.
 *
 * It was a card at the top of every screen and is now a strip in the chrome.
 * Nothing about the rule changed; it stopped taking a third of the first
 * viewport to state a one-word fact. The error it used to render travels up to
 * `AppShell`, which shows session-wide failures in one place.
 */
export interface AvailabilityPanelProps {
  readonly status: PresenceStatus;
  readonly lastSeen: string | null;
  readonly busy: boolean;
  readonly onChange: (status: PresenceStatus) => Promise<void>;
  readonly onSignOut: () => void;
}

export function AvailabilityPanel({
  status,
  lastSeen,
  busy,
  onChange,
  onSignOut,
}: AvailabilityPanelProps) {
  const current = describe(status);
  const settable = isSelectable(status);

  return (
    <>
      <span
        className={`chip ${current.tone === 'muted' ? '' : current.tone}`}
        title={
          lastSeen === null
            ? current.detail
            : `${current.detail} Last confirmed ${new Date(lastSeen).toLocaleTimeString()}.`
        }
      >
        <span className={status === 'AVAILABLE' ? 'dot live' : 'dot'} aria-hidden="true" />
        {current.label}
      </span>

      <div className="segmented" role="group" aria-label="Availability">
        {SELECTABLE.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={candidate === status}
            // Inert while a change is in flight, and while the server reports a
            // presence this control does not set: the portal must be able to
            // show that state without offering a way to leave it.
            disabled={busy || !settable || candidate === status}
            onClick={() => void onChange(candidate)}
          >
            {describe(candidate).label}
          </button>
        ))}
      </div>

      <button type="button" className="quiet sm" onClick={onSignOut}>
        Sign out
      </button>
    </>
  );
}
