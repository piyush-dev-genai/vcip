'use client';

import type { AiHudPayload } from '@vcip/shared';
import { DOCUMENT_TYPES, DocumentType } from '@vcip/shared';
import { useState } from 'react';
import { DOCUMENT_TYPE_LABELS, documentSummary, hudFor } from '../lib/ai-hud';
import type { AgentApi } from '../lib/api';
import { toAgentMessage } from '../lib/errors';
import type { AgentMessage } from '../lib/errors';

/**
 * Reading the document the customer is holding up (§19).
 *
 * `03-system-design.md` §19 asks for exactly this: *"OCR should be triggered
 * only when the agent/customer indicates that a document is being shown. Do not
 * run expensive OCR on every frame."* The continuous `ocr_status` on the AI
 * panel answers a different question — is a document visible at all — and this
 * is the deliberate, expensive read.
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
 */
export interface DocumentPanelProps {
  readonly sessionId: string;
  readonly api: AgentApi;
  /** Every HUD the portal has received, keyed by session — as `AiPanel` takes. */
  readonly updates: Readonly<Record<string, AiHudPayload>>;
}

export function DocumentPanel({ sessionId, api, updates }: DocumentPanelProps) {
  // No staleness timer, unlike `AiPanel`, and the absence is deliberate: a
  // document check is a one-off answer that stays true for the rest of the call,
  // so `documentSummary` reads it whether or not the sampling loop is still
  // running. `Date.now()` here only feeds a freshness rule this panel ignores.
  const hud = hudFor(updates, sessionId, Date.now());
  const [documentType, setDocumentType] = useState<DocumentType>(DocumentType.PAN);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<AgentMessage | null>(null);
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
        // No analysis attached to this call. An ordinary answer, not an error
        // (D6): the verification carries on without AI.
        setAwaiting(null);
        setMessage(NO_ANALYSIS);
      }
    } catch (error) {
      setAwaiting(null);
      setMessage(toAgentMessage(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="card document">
      <h2>Document check</h2>

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
          {pending ? 'Checking…' : 'Check document'}
        </button>
      </div>

      {message === null ? null : (
        <p className="notice warn" aria-live="polite">
          <strong>{message.title}</strong> {message.detail}
        </p>
      )}

      {summary.status === null ? (
        <p className="muted" aria-live="polite">
          {pending ? 'Reading the document…' : 'No document has been checked yet.'}
        </p>
      ) : (
        <div className={`notice ${TONES[summary.status] ?? 'warn'}`} aria-live="polite">
          <h3>
            {DOCUMENT_TYPE_LABELS[summary.type ?? ''] ?? summary.type}: {summary.label}
          </h3>
          {summary.advice === null ? null : <p className="muted">{summary.advice}</p>}
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
 * No analyzer on this call.
 *
 * Shaped as an `AgentMessage` so it renders through the same notice a real
 * failure does, but it is not one: the request succeeded, and the honest answer
 * was that there was nothing to ask. Retryable, because an analyzer may be
 * attached by the time the agent tries again.
 */
const NO_ANALYSIS: AgentMessage = {
  title: 'No AI on this call.',
  detail: 'The document check could not run. Decide on what you can see.',
  retryable: true,
  reauthenticate: false,
  requestId: null,
};

/** How each outcome is coloured. `UNAVAILABLE` is not a failure of the customer. */
const TONES: Record<string, string> = {
  VERIFIED: 'ok',
  NOT_VERIFIED: 'warn',
  UNREADABLE: 'warn',
  UNAVAILABLE: 'muted',
};
