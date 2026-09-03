/**
 * What the agent's AI panel shows, as a pure function of what has arrived (T31).
 *
 * Separated from the component for the reason `call-state.ts` and `work-state.ts`
 * are: this is the part with rules in it, and the rules are worth testing
 * without React, a socket, or a clock that has to be waited on.
 *
 * The rule that matters is **staleness**. The AI reports every couple of
 * seconds while it is running, and when it stops running it does not say so —
 * a killed analyzer sends nothing at all. A panel that only rendered the last
 * message would therefore go on showing `LIVE 97` for the rest of the call,
 * which is worse than showing nothing: it is a confident signal, in front of
 * an agent deciding whether a person is who they claim to be, about a model
 * that stopped answering minutes ago.
 *
 * So there are two ways to reach "AI unavailable" and both are honest:
 *
 *   1. The AI service said so — `UNAVAILABLE` on a check it could not run.
 *      Shown immediately, because it is a real answer.
 *   2. The AI service has said nothing for `AI_HUD_STALE_AFTER_MS`. Shown
 *      because silence is all a dead analyzer ever produces.
 *
 * Nothing here decides anything about the verification. The AI is assistive
 * (D6) and never a verdict (I7); this is a display.
 */

import type {
  AiHudPayload,
  DocumentCheckStatus,
  DocumentType,
  LivenessStatus,
  OcrStatus,
} from '@vcip/shared';
import { AI_HUD_STALE_AFTER_MS } from '@vcip/shared';

/** What the panel is currently able to say. */
export const HudState = {
  /** No result has arrived for this session yet. */
  WAITING: 'WAITING',
  /** A result arrived recently and is worth reading. */
  LIVE: 'LIVE',
  /** Nothing has arrived for long enough that the last one cannot be trusted. */
  STALE: 'STALE',
} as const;

export type HudState = (typeof HudState)[keyof typeof HudState];

export interface AiHud {
  /** The last result for this session, or null if none has arrived. */
  readonly latest: AiHudPayload | null;
  /** Milliseconds since it arrived, or null if none has. */
  readonly ageMs: number | null;
  readonly state: HudState;
}

export const EMPTY_HUD: AiHud = { latest: null, ageMs: null, state: HudState.WAITING };

/**
 * Fold one `ai.updated` into what the panel holds.
 *
 * Keyed by session, because an agent may hold more than one call and the HUD
 * for one must never be rendered against the other. A payload for a session
 * this panel is not showing is dropped rather than displayed — the wrong
 * customer's liveness score is the worst thing this component could render.
 */
export function applyHudUpdate(
  current: Readonly<Record<string, AiHudPayload>>,
  payload: AiHudPayload,
): Record<string, AiHudPayload> {
  return { ...current, [payload.session_id]: payload };
}

/**
 * The panel's state for one session, at one instant.
 *
 * `now` is passed in rather than read, so the staleness boundary is testable
 * exactly rather than approximately, and so a component re-rendering on a
 * timer and a test asserting on a threshold run the same code.
 */
export function hudFor(
  updates: Readonly<Record<string, AiHudPayload>>,
  sessionId: string,
  now: number,
  staleAfterMs: number = AI_HUD_STALE_AFTER_MS,
): AiHud {
  const latest = updates[sessionId];
  if (latest === undefined) return EMPTY_HUD;

  const receivedAt = Date.parse(latest.updated_at);
  if (Number.isNaN(receivedAt)) {
    // An unreadable timestamp cannot be aged, and a HUD that cannot be aged
    // cannot be trusted to be current. Treated as stale rather than fresh:
    // the failure that matters is showing an old score as a new one.
    return { latest, ageMs: null, state: HudState.STALE };
  }

  // Clamped at zero: a server clock a little ahead of the browser's would
  // otherwise produce a negative age, which is not a thing to render.
  const ageMs = Math.max(0, now - receivedAt);

  return { latest, ageMs, state: ageMs >= staleAfterMs ? HudState.STALE : HudState.LIVE };
}

/** Whether the panel should read "AI unavailable" outright. */
export function isUnavailable(hud: AiHud): boolean {
  return hud.state !== HudState.LIVE;
}

/**
 * How a liveness result reads, or null when there is nothing to say.
 *
 * A stale HUD reports nothing at all rather than its last value: the panel
 * says the AI is unavailable, and printing "LIVE (97)" underneath that would
 * invite an agent to read the number and ignore the warning.
 */
export function livenessText(hud: AiHud): string | null {
  if (hud.latest === null || isUnavailable(hud)) return null;
  return statusText(hud.latest.liveness_status, hud.latest.liveness_score);
}

export function faceMatchText(hud: AiHud): string | null {
  if (hud.latest === null || isUnavailable(hud)) return null;
  return hud.latest.face_match_score === null ? 'No result' : `${hud.latest.face_match_score}`;
}

export function ocrText(hud: AiHud): string | null {
  if (hud.latest === null || isUnavailable(hud)) return null;
  return OCR_LABELS[hud.latest.ocr_status] ?? hud.latest.ocr_status;
}

/**
 * The last document check, if the agent has run one.
 *
 * **Deliberately readable through a stale HUD**, unlike every accessor above.
 * The three continuous checks are a live signal that goes stale in ten seconds,
 * because a dead analyzer produces silence and the panel must not keep showing
 * a confident score. A document check is not like that: it is a one-off answer
 * about a card the customer held up, and it stays true for the rest of the call
 * whether or not the analyzer is still sampling.
 *
 * Hiding it when the sampling loop went quiet would be actively unhelpful —
 * that is precisely the moment an agent needs the answer they already got.
 */
export interface DocumentSummary {
  readonly type: DocumentType | null;
  readonly status: DocumentCheckStatus | null;
  /** How the status reads, or null when no check has run. */
  readonly label: string | null;
  /** What the agent should do about it, or null when there is nothing to do. */
  readonly advice: string | null;
  readonly checkedAt: string | null;
}

export const NO_DOCUMENT_CHECK: DocumentSummary = {
  type: null,
  status: null,
  label: null,
  advice: null,
  checkedAt: null,
};

export function documentSummary(hud: AiHud): DocumentSummary {
  const latest = hud.latest;
  if (latest === null) return NO_DOCUMENT_CHECK;

  const { document_type: type, document_status: status } = latest;
  // All three or none, matching how the server writes and reads them: a status
  // with no type could not be labelled, and one with no timestamp could not be
  // shown as "checked at".
  if (type === null || status === null || latest.document_checked_at === null) {
    return NO_DOCUMENT_CHECK;
  }

  return {
    type,
    status,
    label: DOCUMENT_STATUS_LABELS[status] ?? status,
    advice: DOCUMENT_ADVICE[status] ?? null,
    checkedAt: latest.document_checked_at,
  };
}

/** How each document type reads on the panel. */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  AADHAAR: 'Aadhaar',
  PAN: 'PAN',
};

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  VERIFIED: 'Verified',
  NOT_VERIFIED: 'Not verified',
  UNREADABLE: 'Could not read',
  UNAVAILABLE: 'Check unavailable',
};

/**
 * What to do next, per outcome.
 *
 * The reason the four statuses are four and not two: each one asks something
 * different of the agent. Without this the panel would show a red mark and no
 * instruction, and an agent would have to guess whether the problem was the
 * customer, the camera, or the registry.
 *
 * Note that none of these says approve or reject. The AI decides nothing (I7),
 * and even `VERIFIED` only says the registry recognised the document.
 */
const DOCUMENT_ADVICE: Record<string, string> = {
  VERIFIED: 'The registry recognised this document.',
  NOT_VERIFIED: 'The registry did not recognise it. Ask the customer about the document.',
  UNREADABLE: 'Ask the customer to hold the card still, fill the frame, and check again.',
  UNAVAILABLE: 'The check could not run. Decide on what you can see.',
};

const LIVENESS_LABELS: Record<string, string> = {
  LIVE: 'Live person',
  NOT_LIVE: 'Not live',
  UNKNOWN: 'Undecided',
  UNAVAILABLE: 'Unavailable',
};

const OCR_LABELS: Record<string, string> = {
  PASS: 'Document read',
  FAIL: 'Could not read',
  NO_DOCUMENT: 'No document shown',
  UNAVAILABLE: 'Unavailable',
};

/**
 * A status with its score, when it has one.
 *
 * An absent score prints nothing rather than a zero. `null` and `0` mean
 * opposite things all the way from the provider to here, and this is the last
 * place that distinction could be lost.
 */
function statusText(status: LivenessStatus | OcrStatus, score: number | null): string {
  const label = LIVENESS_LABELS[status] ?? status;
  return score === null ? label : `${label} (${score})`;
}
