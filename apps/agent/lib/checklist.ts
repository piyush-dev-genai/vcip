/**
 * The agent's ticks, across a page reload (T34).
 *
 * A verification takes minutes and an agent works through the checklist while
 * talking to someone. A refresh — a stray F5, a crashed tab, a Next dev-server
 * reload — would otherwise blank every box they had already ticked, mid-call,
 * with no way to tell which ones they had confirmed. So the answers are kept.
 *
 * **`sessionStorage`, never `localStorage`**, for exactly the reason
 * `token.ts` gives: the agent portal may be a shared operations machine, and
 * the tab is the session. A reload keeps the ticks; closing the tab discards
 * them, which is the right side to err on — a half-finished attestation must
 * not be waiting for whoever sits down next.
 *
 * **Nothing here is authoritative.** These are notes an agent has not submitted
 * yet. The record is written by the verdict transaction (T35), the rule about
 * what counts as complete is `validateSubmission` in `@vcip/shared`, and the
 * server checks it again on submit regardless of what was on screen.
 *
 * **Keyed by session.** An agent may hold more than one call, and the wrong
 * customer's answers restored into the wrong checklist is the worst thing this
 * module could do.
 *
 * The storage surface is injected as a host rather than reached for directly,
 * so every rule above is testable under plain Node and `window` never leaks
 * into a module Next may render on the server.
 */

import type { ChecklistAnswer, ChecklistItem } from '@vcip/shared';
import type { StorageLike } from './token';

export interface ChecklistHost {
  /** `window.sessionStorage`, or null when storage is unavailable. */
  readonly storage: StorageLike | null;
}

const TICKS_PREFIX = 'vcip.agent.checklist.';

/** What is on screen: every template item, and whether it is ticked. */
export type Ticks = Readonly<Record<string, boolean>>;

/** Never throws. Storage that rejects a write must not break a live call. */
const safely = <T>(operation: () => T, fallback: T): T => {
  try {
    return operation();
  } catch {
    return fallback;
  }
};

const keyName = (sessionId: string): string => `${TICKS_PREFIX}${sessionId}`;

/**
 * Ticks for a template, starting from what was remembered.
 *
 * The template is the authority on which items exist. A remembered key the
 * template no longer has is dropped, and an item the memory has no answer for
 * starts unticked — so a checklist that changed between the reload and the
 * restore cannot resurrect an answer to a question that is no longer asked.
 */
export function restoreTicks(
  host: ChecklistHost,
  sessionId: string,
  template: readonly ChecklistItem[],
): Ticks {
  const remembered = read(host, sessionId);
  const ticks: Record<string, boolean> = {};

  for (const item of template) {
    ticks[item.key] = remembered[item.key] === true;
  }

  return ticks;
}

/** Remember the current ticks for this session. */
export function rememberTicks(host: ChecklistHost, sessionId: string, ticks: Ticks): void {
  if (host.storage === null) return;
  safely(() => host.storage?.setItem(keyName(sessionId), JSON.stringify(ticks)), undefined);
}

/**
 * Forget one session's ticks.
 *
 * Called once the verdict is in. The answers are in PostgreSQL by then, and
 * leaving them in the tab would restore a stale checklist onto the next
 * session that happened to reuse the screen.
 */
export function forgetTicks(host: ChecklistHost, sessionId: string): void {
  if (host.storage === null) return;
  safely(() => host.storage?.removeItem(keyName(sessionId)), undefined);
}

/** Turn what is on screen into what the verdict request carries. */
export function toAnswers(template: readonly ChecklistItem[], ticks: Ticks): ChecklistAnswer[] {
  // Template order, and every item answered. The server refuses a submission
  // that skips one rather than reading it as unticked, because "left blank" and
  // "running against an older template" arrive looking identical.
  return template.map((item) => ({ key: item.key, checked: ticks[item.key] === true }));
}

/**
 * What was remembered, shape-checked.
 *
 * Anything that is not a flat object of booleans reads as nothing remembered.
 * A stale format, another app's key, or a hand-edited value must not become a
 * tick the agent did not make.
 */
function read(host: ChecklistHost, sessionId: string): Readonly<Record<string, boolean>> {
  if (host.storage === null) return {};

  const raw = safely(() => host.storage?.getItem(keyName(sessionId)) ?? null, null);
  if (raw === null) return {};

  const parsed = safely<unknown>(() => JSON.parse(raw), null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const remembered: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') remembered[key] = value;
  }

  return remembered;
}

/** The live browser host. Null storage anywhere `window` is absent. */
export function browserChecklistHost(): ChecklistHost {
  if (typeof window === 'undefined') return { storage: null };
  return { storage: safely(() => window.sessionStorage, null) };
}
