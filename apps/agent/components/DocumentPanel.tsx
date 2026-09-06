'use client';

import { DOCUMENT_TYPES, DocumentCheckRefusal, DocumentType } from '@vcip/shared';
import { useState } from 'react';
import type { AiHud } from '../lib/ai-hud';
import { DOCUMENT_TYPE_LABELS, documentSummary } from '../lib/ai-hud';
import type { AgentApi } from '../lib/api';
import { toAgentMessage } from '../lib/errors';
import type { AgentMessage } from '../lib/errors';

/**
 * Reading the document the customer is holding up (§19).
 *
 * `03-system-design.md` §19 asks for exactly this: *"OCR should be triggered
 * only when the agent/customer indicates that a document is being shown. Do not
 * run expensive OCR on every frame."* The continuous status on the AI panel
 * answers a different question — is a document visible at all — and this is the
 * deliberate, expensive read.
 *
 * **No image is captured here.** The button sends a session id and a document
 * type; the frames are already in the AI service (D23). Nothing in this
 * component, this browser, or the Control API ever holds a picture of a
 * customer's identity document, which is what makes §8.3 hold without anybody
 * having to remember it.
 *
 * **The answer arrives on the socket, not from the request.** A read decodes a
 * frame burst and calls an external registry, which is far too long to hold an
 * HTTP request open. So this shows "Checking…" until the result lands on the
 * HUD by the same route every other AI result takes — one panel, one source of
 * truth, rather than a second place for the agent to look.
 *
 * **It decides nothing (I7).** `VERIFIED` means a registry recognised the
 * document. Nothing here is wired to the checklist or the verdict, and the
 * approve button is not gated on it: an agent may approve a verification whose
 * document check came back `UNAVAILABLE`, because a third-party registry being
 * down is not the customer's fault.
 *
 * **It keeps working while its tab is closed.** The rail hides this panel
 * rather than unmounting it, so a check started before switching to the
 * checklist is still running, and its answer is waiting on return — with the
 * tab's own badge saying so in the meantime.
 */
export interface DocumentPanelProps {
  readonly sessionId: string;
  readonly api: AgentApi;
  /** The current AI result for this session, already aged. */
  readonly hud: AiHud;
}

export function DocumentPanel({ sessionId, api, hud }: DocumentPanelProps) {
  const [documentType, setDocumentType] = useState<DocumentType>(DocumentType.PAN);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<AgentMessage | null>(null);
  /** Whether `message` describes a fault, or is merely informative. */
  const [alarming, setAlarming] = useState(true);
  /**
   * Which check we are waiting for, or null.
   *
   * Compared against the HUD rather than cleared on a timer: the request
   * resolving means "accepted", not "answered", so the spinner has to end when
   * a *result* arrives. Holding the type asked for is what lets a stale answer
   * about a different document be told apart from the one being awaited.
   */
  const [awaiting, setAwaiting] = useState<DocumentType | null>(null);

  const summary = documentSummary(hud);
  const answered = awaiting !== null && summary.type === awaiting && summary.checkedAt !== null;
  const pending = checking || (awaiting !== null && !answered);

  const run = async (): Promise<void> => {
    setChecking(true);
    setMessage(null);
    setAwaiting(documentType);

    try {
      const result = await api.documentCheck(sessionId, documentType);
      if (!result.accepted) {
        // Not run. Which of the four reasons it was decides what the agent is
        // told — they used to share one sentence, and "No AI on this call" for
        // a double-press was actively misleading: it named the wrong problem
        // while the previous answer sat on screen contradicting it.
        const reason = result.reason ?? DocumentCheckRefusal.NO_ANALYSIS;
        setAwaiting(null);
        setMessage(REFUSALS[reason]);
        setAlarming(ALARMING[reason]);
      }
    } catch (error) {
      setAwaiting(null);
      setMessage(toAgentMessage(error));
      setAlarming(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="card document">
      <div className="card-head">
        <h2>Document check</h2>
        {summary.status === null ? null : (
          <span className={`chip ${TONES[summary.status] ?? 'warn'}`}>{summary.label}</span>
        )}
      </div>

      <p className="hint">
        Ask the customer to hold the card still and fill the frame, then check it.
      </p>

      <div className="actions">
        <label>
          <span className="visually-hidden">Document type</span>
          <select
            value={documentType}
            disabled={pending}
            onChange={(event) => {
              setDocumentType(event.target.value as DocumentType);
            }}
          >
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type] ?? type}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={() => {
            void run();
          }}
        >
          {pending ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Checking…
            </>
          ) : (
            'Check document'
          )}
        </button>
      </div>

      {message === null ? null : (
        <div className={alarming ? 'notice warn' : 'notice muted'} aria-live="polite">
          <h3>{message.title}</h3>
          <p>{message.detail}</p>
        </div>
      )}

      {/* Shown whether or not a previous result is on screen. It used to appear
          only when there was nothing else there, so a retry looked like nothing
          had happened -- which is what makes an agent press the button again. */}
      {pending ? (
        <p className="muted" aria-live="polite">
          Reading the document…
        </p>
      ) : null}

      {summary.status === null ? (
        pending ? null : (
          <div className="empty">
            <span className="empty-mark" aria-hidden="true">
              ?
            </span>
            <p className="muted">No document has been checked yet.</p>
          </div>
        )
      ) : (
        <div className={`notice ${TONES[summary.status] ?? 'warn'}`} aria-live="polite">
          <h3>
            {DOCUMENT_TYPE_LABELS[summary.type ?? ''] ?? summary.type}: {summary.label}
          </h3>
          {summary.advice === null ? null : <p>{summary.advice}</p>}
          {/* Labelled as the previous answer while a new check is running, so
              the two can never be read as one contradictory statement. */}
          {pending ? <p className="ref">(previous result)</p> : null}
        </div>
      )}

      <p className="hint">
        Assistive only. The verdict is yours — this check decides nothing, and a verification can be
        approved without it.
      </p>
    </section>
  );
}

/**
 * What each refusal is called on screen.
 *
 * Four situations, four sentences. They shared one — "No AI on this call." —
 * and the first real use showed why that was wrong: an agent pressing the
 * button twice was told the AI was missing while it was working perfectly, with
 * the previous result still displayed underneath saying otherwise.
 *
 * `IN_PROGRESS` is not a failure and does not read like one. It is the panel
 * saying "the answer you asked for is on its way".
 */
const REFUSALS: Record<DocumentCheckRefusal, AgentMessage> = {
  [DocumentCheckRefusal.NO_ANALYSIS]: {
    title: 'No AI on this call.',
    detail: 'Nothing is analysing this call, so the document could not be read.',
    retryable: true,
    reauthenticate: false,
    requestId: null,
  },
  [DocumentCheckRefusal.AI_DISABLED]: {
    title: 'AI is switched off.',
    detail: 'This deployment runs without document checks. Decide on what you can see.',
    retryable: false,
    reauthenticate: false,
    requestId: null,
  },
  [DocumentCheckRefusal.UNREACHABLE]: {
    title: 'The AI service did not answer.',
    detail: 'The check could not be run just now. You can try again.',
    retryable: true,
    reauthenticate: false,
    requestId: null,
  },
  [DocumentCheckRefusal.IN_PROGRESS]: {
    title: 'Still checking.',
    detail: 'A check for this call is already running. Wait for it to finish.',
    retryable: true,
    reauthenticate: false,
    requestId: null,
  },
};

/**
 * Which refusals are worth a warning, and which are just information.
 *
 * `IN_PROGRESS` is neither a fault nor anything the agent should act on — the
 * answer is on its way. Rendering it in the same alarming box as an unreachable
 * AI service is how a working system comes to look broken.
 */
const ALARMING: Record<DocumentCheckRefusal, boolean> = {
  [DocumentCheckRefusal.NO_ANALYSIS]: true,
  [DocumentCheckRefusal.AI_DISABLED]: true,
  [DocumentCheckRefusal.UNREACHABLE]: true,
  [DocumentCheckRefusal.IN_PROGRESS]: false,
};

/**
 * How each outcome is coloured, and the same table the rail's tab badge reads.
 *
 * `UNAVAILABLE` is not a failure of the customer, so it stays neutral.
 */
export const TONES: Record<string, string> = {
  VERIFIED: 'ok',
  NOT_VERIFIED: 'warn',
  UNREADABLE: 'warn',
  UNAVAILABLE: 'muted',
};
