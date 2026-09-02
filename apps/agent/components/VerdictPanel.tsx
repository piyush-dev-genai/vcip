'use client';

import type { AgentVerdictRequest, ChecklistAnswer } from '@vcip/shared';
import { SessionStatus } from '@vcip/shared';
import { useState } from 'react';
import type { AgentApi } from '../lib/api';
import { toAgentMessage } from '../lib/errors';
import type { AgentMessage } from '../lib/errors';

/**
 * Submitting the verdict (T35, contract §18).
 *
 * The end of the agent's work, and the only control in this portal that
 * charges money. Three buttons, because there are exactly three verdicts a
 * person may submit — the other terminal statuses are things that *happen* to
 * a session, and no request may name them.
 *
 * **Approve is gated on the checklist; reject and abort are not.** The rule
 * comes from `approvalReady` in `@vcip/shared`, which is the same function the
 * Control API applies on submit — asked rather than reimplemented, so this
 * button cannot promise what the server will refuse. Rejection is deliberately
 * ungated: an agent rejects *because* a required check failed, and demanding
 * every box first would make the only submittable rejection one where nothing
 * was wrong.
 *
 * **Two presses cannot become two verdicts.** The button disables while the
 * request is in flight, but that is courtesy rather than protection: the
 * `Idempotency-Key` comes from `lib/work.ts`, which mints one key per
 * (intent, session) and returns the same string on every retry, so a
 * double-click, a reload mid-request, or a flaky network all land on the reply
 * the first press produced rather than on the single-winner guard.
 */
export interface VerdictPanelProps {
  readonly sessionId: string;
  readonly api: AgentApi;
  /** The checklist as it stands, from `ChecklistPanel`. */
  readonly answers: readonly ChecklistAnswer[];
  /** Whether every required item is checked — `approvalReady`, computed upstream. */
  readonly approvable: boolean;
  /** The idempotency key for this session's verdict. Stable across retries. */
  readonly idempotencyKey: string;
  /** Called once a verdict has committed, so the portal can release the work. */
  readonly onSubmitted: (verdict: string) => void;
}

/** The three verdicts, with the words an agent reads. */
const CHOICES = [
  {
    verdict: SessionStatus.APPROVED,
    label: 'Approve',
    hint: 'The customer is who they claim to be.',
    tone: 'approve',
  },
  {
    verdict: SessionStatus.REJECTED,
    label: 'Reject',
    hint: 'A check failed. The checklist is recorded as it stands.',
    tone: 'reject',
  },
  {
    verdict: SessionStatus.ABORTED,
    label: 'Abort',
    hint: 'The verification could not be completed.',
    tone: 'abort',
  },
] as const;

export function VerdictPanel({
  sessionId,
  api,
  answers,
  approvable,
  idempotencyKey,
  onSubmitted,
}: VerdictPanelProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<AgentMessage | null>(null);

  const submit = (verdict: AgentVerdictRequest['verdict']): void => {
    setPending(verdict);
    setError(null);

    void api
      .verdict(sessionId, { verdict, checklist: [...answers] }, idempotencyKey)
      .then((result) => {
        onSubmitted(result.verdict);
      })
      .catch((caught: unknown) => {
        // The server is the authority on whether this committed. A 409 means
        // somebody else reached a terminal outcome first (D17) — the customer
        // dropped, or the sweeper timed the call out — and the agent needs to
        // be told that rather than left pressing a button that will never work.
        setError(toAgentMessage(caught));
      })
      .finally(() => {
        setPending(null);
      });
  };

  const busy = pending !== null;

  return (
    <section className="card verdict">
      <h2>Verdict</h2>

      <div className="verdicts">
        {CHOICES.map((choice) => {
          // Only approval is gated. See the note at the top of this file.
          const blocked = choice.verdict === SessionStatus.APPROVED && !approvable;
          return (
            <button
              key={choice.verdict}
              type="button"
              className={`verdict-button ${choice.tone}`}
              disabled={busy || blocked}
              onClick={() => {
                submit(choice.verdict);
              }}
            >
              {pending === choice.verdict ? 'Submitting...' : choice.label}
              <span className="verdict-hint">{choice.hint}</span>
            </button>
          );
        })}
      </div>

      {!approvable ? (
        <p className="hint">
          Check every required item above to approve. Reject and abort do not require it.
        </p>
      ) : null}

      {error !== null ? (
        <p className="notice bad" aria-live="polite">
          <strong>{error.title}</strong> {error.detail}
        </p>
      ) : null}
    </section>
  );
}
