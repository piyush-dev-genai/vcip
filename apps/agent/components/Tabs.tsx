'use client';

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * One thing at a time, in the rail beside the call.
 *
 * The reason this exists: the call screen used to stack the AI panel, the
 * document check and the checklist one under the other, and an agent talking
 * to a customer had to scroll a page to reach any of them. Tabs put the same
 * three panels in the same space and let the agent choose.
 *
 * The risk of tabs is that they hide something the agent needed to see, so
 * every tab carries a badge and the badge is the point of the API: a tab may
 * be closed, but what it would have told you is still on its face. A document
 * check that came back `NOT_VERIFIED` shows an amber dot whether or not that
 * panel is open.
 *
 * Keyboard behaviour is the WAI-ARIA tabs pattern: arrows move between tabs,
 * Home and End jump to the ends, and only the selected tab is in the tab order
 * so a keyboard user tabs *into* the panel rather than through three buttons.
 *
 * It holds which tab is open and nothing else. No panel's state lives here —
 * the panels stay mounted, so a document check running behind a closed tab
 * keeps running and its result is there when the agent comes back.
 */
export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  /** A count, a short word, or nothing. Rendered on the tab itself. */
  readonly badge?: string | null;
  /** How the badge reads: a plain count, or a coloured state. */
  readonly tone?: 'ok' | 'warn' | 'bad' | 'plain';
  readonly panel: ReactNode;
}

export interface TabsProps {
  readonly tabs: readonly TabDefinition[];
  /** Which tab opens first. Falls back to the first one. */
  readonly initial?: string;
  /** Names the tab strip for assistive technology. */
  readonly label: string;
}

export function Tabs({ tabs, initial, label }: TabsProps) {
  const base = useId();
  const [openId, setOpenId] = useState<string>(() => initial ?? tabs[0]?.id ?? '');
  const strip = useRef<HTMLDivElement | null>(null);

  const current = tabs.some((tab) => tab.id === openId) ? openId : (tabs[0]?.id ?? '');

  /**
   * Arrow keys move the selection, as the pattern requires.
   *
   * Focus is moved with it rather than left behind: a tab strip where the
   * arrow key changes the panel but not the focus ring leaves a keyboard user
   * unable to tell which tab they are on.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let target: number | null = null;

    if (step !== 0) {
      const at = tabs.findIndex((tab) => tab.id === current);
      target = (at + step + tabs.length) % tabs.length;
    } else if (event.key === 'Home') {
      target = 0;
    } else if (event.key === 'End') {
      target = tabs.length - 1;
    }

    if (target === null) return;
    const next = tabs[target];
    if (next === undefined) return;

    event.preventDefault();
    setOpenId(next.id);
    strip.current?.querySelector<HTMLButtonElement>(`#${cssId(base, next.id, 'tab')}`)?.focus();
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} ref={strip} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              id={cssId(base, tab.id, 'tab')}
              type="button"
              role="tab"
              className="tab"
              aria-selected={selected}
              aria-controls={cssId(base, tab.id, 'panel')}
              // Only the open tab is reachable by Tab; the arrows do the rest.
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setOpenId(tab.id);
              }}
            >
              {tab.label}
              <Badge badge={tab.badge ?? null} tone={tab.tone ?? 'plain'} />
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={cssId(base, tab.id, 'panel')}
          className="tabpanel"
          role="tabpanel"
          aria-labelledby={cssId(base, tab.id, 'tab')}
          // Hidden, not unmounted. A check running behind a closed tab must
          // keep running, and its answer must be there on return.
          hidden={tab.id !== current}
          tabIndex={0}
        >
          {tab.panel}
        </div>
      ))}
    </>
  );
}

/**
 * The badge, which is what makes a closed tab honest.
 *
 * A dot when there is a state but no number worth showing; the number itself
 * when there is one. Never empty markup: an element with no content still
 * takes space and would nudge the labels out of line.
 */
function Badge({ badge, tone }: { readonly badge: string | null; readonly tone: string }) {
  if (badge === null) return null;
  const shape = badge === '' ? 'tab-badge dot-only' : 'tab-badge';
  const colour = tone === 'plain' ? '' : ` ${tone}`;
  return (
    <span className={`${shape}${colour}`} aria-hidden="true">
      {badge}
    </span>
  );
}

/** A DOM id that is safe in a `querySelector`. Ids from `useId` contain colons. */
function cssId(base: string, id: string, kind: string): string {
  return `t${base.replace(/[^a-zA-Z0-9]/g, '')}-${id}-${kind}`;
}
