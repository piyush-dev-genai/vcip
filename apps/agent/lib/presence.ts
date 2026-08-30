/**
 * What the portal may offer, and how it names what the server reports.
 *
 * Two lists, deliberately not one:
 *
 *   - `SELECTABLE` is what a control may set. It is `AGENT_AVAILABILITY_VALUES`
 *     from `@vcip/shared` — the same list the request schema is built from — so
 *     a button for `BUSY` cannot exist without the shared contract growing one
 *     first. This is the client half of R5; the server half is the schema
 *     rejecting it and the service never writing it.
 *   - `LABELS` covers everything the server can *report*, `BUSY` included. The
 *     portal must be able to show an agent that they are in a call; it must not
 *     be able to put them there.
 *
 * Kept out of the components so the rule is one exported constant a test can
 * read, rather than a claim about JSX somewhere.
 */

import { AGENT_AVAILABILITY_VALUES } from '@vcip/shared';

/** Every presence the server may report. */
export type PresenceStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'BUSY';

/** The statuses the agent may choose. Never includes BUSY. */
export const SELECTABLE: readonly PresenceStatus[] = Object.freeze([...AGENT_AVAILABILITY_VALUES]);

export function isSelectable(status: PresenceStatus): boolean {
  return SELECTABLE.includes(status);
}

interface PresenceLabel {
  readonly label: string;
  readonly detail: string;
  /** Maps onto the shared stylesheet's notice variants. */
  readonly tone: 'ok' | 'warn' | 'muted';
}

export const LABELS: Readonly<Record<PresenceStatus, PresenceLabel>> = Object.freeze({
  AVAILABLE: {
    label: 'Available',
    detail: 'You are in the pool for new verifications.',
    tone: 'ok',
  },
  UNAVAILABLE: {
    label: 'Unavailable',
    detail: 'You will not be offered new verifications.',
    tone: 'muted',
  },
  BUSY: {
    // Reported, never chosen. The server sets this when the agent is holding
    // an active verification.
    label: 'In a verification',
    detail: 'Set by the system while you are holding a verification.',
    tone: 'warn',
  },
});

export function describe(status: PresenceStatus): PresenceLabel {
  return LABELS[status];
}
