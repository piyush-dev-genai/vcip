'use client';

import type { ChecklistItem, ChecklistResult } from '@vcip/shared';
import { approvalReady } from '@vcip/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentApi } from '../lib/api';
import type { Ticks } from '../lib/checklist';
import {
  browserChecklistHost,
  forgetTicks,
  rememberTicks,
  restoreTicks,
  toAnswers,
} from '../lib/checklist';

/**
 * The verification checklist, in front of the agent (T33, T34).
 *
 * What the agent is attesting to, and the only part of this screen that is
 * theirs to fill in — the AI panel beside it decides nothing (I7), and this
 * does. Each tick is a statement a named person made about a named
 * verification, which is why the wording is plain and why nothing here is
 * pre-ticked.
 *
 * **The template is fetched once.** It is pinned to the session at creation
 * (D8), so it cannot change under the agent mid-call and there is nothing to
 * poll for.
 *
 * **The ticks survive a reload.** `lib/checklist.ts` keeps them in
 * `sessionStorage` and explains the choice; the effect of it here is that a
 * refresh mid-call restores what the agent had already confirmed rather than
 * blanking it.
 *
 * **Nothing is submitted from here.** The answers travel with the verdict
 * (contract §18) and are recorded in that transaction (T35). This component
 * reports readiness upward so the verdict control can be enabled, and holds
 * the answers until then.
 */
export interface ChecklistPanelProps {
  readonly sessionId: string;
  readonly api: AgentApi;
  /**
   * Called whenever the answers change.
   *
   * `ready` is `approvalReady` from `@vcip/shared` — the same rule the server
   * applies on submit, asked rather than reimplemented, so the approve control
   * cannot promise what the API will refuse.
   */
  readonly onChange?: (state: {
    readonly answers: ReturnType<typeof toAnswers>;
    readonly ready: boolean;
  }) => void;
}

/** A stable empty template, so the effect below is not re-run by a new [].  */
const EMPTY_TEMPLATE: readonly ChecklistItem[] = Object.freeze([]);

type Load =
  | { readonly kind: 'LOADING' }
  | { readonly kind: 'READY'; readonly checklist: ChecklistResult }
  | { readonly kind: 'FAILED' };

export function ChecklistPanel({ sessionId, api, onChange }: ChecklistPanelProps) {
  const [load, setLoad] = useState<Load>({ kind: 'LOADING' });
  const [ticks, setTicks] = useState<Ticks>({});

  useEffect(() => {
    let live = true;
    setLoad({ kind: 'LOADING' });

    void api
      .checklist(sessionId)
      .then((checklist) => {
        if (!live) return;
        setLoad({ kind: 'READY', checklist });
        // Restored against the template, so a remembered answer to an item the
        // template no longer has is dropped rather than resurrected.
        setTicks(restoreTicks(browserChecklistHost(), sessionId, checklist.items));
      })
      .catch(() => {
        if (live) setLoad({ kind: 'FAILED' });
      });

    return () => {
      live = false;
    };
  }, [api, sessionId]);

  const toggle = useCallback(
    (key: string) => {
      setTicks((current) => {
        const next = { ...current, [key]: current[key] !== true };
        rememberTicks(browserChecklistHost(), sessionId, next);
        return next;
      });
    },
    [sessionId],
  );

  const items = load.kind === 'READY' ? load.checklist.items : EMPTY_TEMPLATE;

  // The callback is held in a ref rather than listed as a dependency. A parent
  // passing an inline arrow gives a new identity on every render, and an effect
  // that both depended on it and caused the parent to re-render would loop.
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    if (load.kind !== 'READY') return;
    const answers = toAnswers(items, ticks);
    notify.current?.({ answers, ready: approvalReady(items, answers) });
  }, [items, ticks, load.kind]);

  return (
    <section className="card checklist">
      <h2>Verification checklist</h2>

      {load.kind === 'LOADING' ? <p className="muted">Loading the checklist...</p> : null}

      {load.kind === 'FAILED' ? (
        <p className="notice" aria-live="polite">
          The checklist could not be loaded. A verdict cannot be submitted without it.
        </p>
      ) : null}

      {load.kind === 'READY' ? (
        <>
          <ul className="checks">
            {items.map((item) => (
              <Check
                key={item.key}
                item={item}
                checked={ticks[item.key] === true}
                onToggle={() => {
                  toggle(item.key);
                }}
              />
            ))}
          </ul>
          <p className="hint">
            Every required item must be checked to approve. A rejection records the checklist as it
            stands.
          </p>
        </>
      ) : null}
    </section>
  );
}

function Check({
  item,
  checked,
  onToggle,
}: {
  readonly item: ChecklistItem;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li>
      <label>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span>{item.label}</span>
        {/* Marked rather than hidden: an agent deciding what to confirm should
            be able to see which items the tenant made mandatory. */}
        {item.required ? <span className="required"> (required)</span> : null}
      </label>
    </li>
  );
}

/** Forget one session's ticks. Called by the portal once a verdict is in. */
export function clearChecklist(sessionId: string): void {
  forgetTicks(browserChecklistHost(), sessionId);
}
