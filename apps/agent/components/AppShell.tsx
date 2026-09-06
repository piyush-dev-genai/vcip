'use client';

import type { ReactNode } from 'react';
import type { AgentMessage } from '../lib/errors';

/**
 * The chrome every signed-in screen sits inside.
 *
 * The portal used to open with a full-width Availability card, so the first
 * thing an agent saw — on the queue, during an offer, and in the middle of a
 * call — was a control they touch twice a shift. It is now a strip: a presence
 * chip, the toggle, and the way out, in a bar that is the same height on every
 * screen and never competes with the work below it.
 *
 * The session-wide alert lives here too, and that is the point of the slot.
 * A heartbeat failure or a refused availability change is not the queue's
 * problem or the call's; it belongs to the whole session, and it used to be
 * rendered inside whichever panel happened to own the state. Here it is always
 * in the same place, directly under the control it is about.
 *
 * It renders no state of its own and decides nothing. Everything on it is
 * passed in.
 */
export interface AppShellProps {
  /** The presence controls, rendered at the right of the bar. */
  readonly controls: ReactNode;
  /** A session-wide failure, shown under the bar. Null when all is well. */
  readonly alert: AgentMessage | null;
  /** Narrow column for the focused screens; wide for the workspace. */
  readonly narrow?: boolean;
  readonly children: ReactNode;
}

export function AppShell({ controls, alert, narrow = false, children }: AppShellProps) {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            VC
          </span>
          <span className="brand-name">
            V-CIP
            <small>Agent console</small>
          </span>
        </div>

        <span className="topbar-spacer" />

        <div className="topbar-group">{controls}</div>
      </header>

      {alert === null ? null : (
        <div className="topbar-alert" role="status">
          <strong>{alert.title}</strong>
          <span>{alert.detail}</span>
          {alert.requestId === null ? null : (
            <span className="ref">Reference {alert.requestId}</span>
          )}
        </div>
      )}

      <main className={narrow ? 'shell narrow' : 'shell'}>{children}</main>
    </>
  );
}

/** The page's own heading, above whatever the screen is. */
export function PageHead({
  eyebrow,
  title,
  aside,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly aside?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {aside === undefined ? null : <div className="topbar-group">{aside}</div>}
    </div>
  );
}
