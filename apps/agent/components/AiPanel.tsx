'use client';

import type { AiHud } from '../lib/ai-hud';
import { faceMatchText, isUnavailable, livenessText, ocrText } from '../lib/ai-hud';

/**
 * What the AI has to say about the call in front of the agent (T31).
 *
 * A signal, and the wording is deliberate throughout: "suggests", not
 * "decides". The AI never determines an outcome (I7), the agent's verdict is
 * the only thing that does, and a panel that read like a verdict would invite
 * the one mistake this product cannot afford — an agent approving because the
 * machine said so. That is also why no row here is coloured green: a row that
 * looked like a pass would be doing exactly what the wording avoids.
 *
 * It is also allowed to say nothing. AI is off the video critical path (D6),
 * so "AI unavailable" is an ordinary state rather than an error screen: the
 * call continues, the checklist continues, and the verdict is still the
 * agent's to submit.
 *
 * The HUD arrives as a prop rather than being derived here. The tab that hides
 * this panel shows a badge summarising the same answer, and two components
 * ageing the same result against two different clocks would eventually
 * disagree — see `lib/use-hud.ts`.
 */
export interface AiPanelProps {
  /** The current result for this session, already aged. */
  readonly hud: AiHud;
}

export function AiPanel({ hud }: AiPanelProps) {
  const quiet = isUnavailable(hud);

  return (
    <section className="card ai">
      <div className="card-head">
        <h2>AI checks</h2>
        <span className={quiet ? 'chip' : 'chip accent'}>
          <span className={quiet ? 'dot' : 'dot live'} aria-hidden="true" />
          {quiet ? 'No signal' : 'Sampling'}
        </span>
      </div>

      {quiet ? (
        <div className="empty" aria-live="polite">
          <span className="empty-mark" aria-hidden="true">
            —
          </span>
          <p>AI unavailable</p>
          <p className="muted">
            Nothing is analysing this call just now. Carry on and decide on what you can see.
          </p>
        </div>
      ) : (
        <dl className="checks-grid">
          <Check label="Liveness" value={livenessText(hud)} />
          <Check label="Face match" value={faceMatchText(hud)} />
          <Check label="Document in frame" value={ocrText(hud)} />
        </dl>
      )}

      <p className="hint">Assistive only. The verdict is yours — these checks decide nothing.</p>
    </section>
  );
}

function Check({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="check-row">
      <dt>{label}</dt>
      {/* An em dash rather than a zero or a blank: a check with no result must
          not read as a check that failed. */}
      <dd>{value ?? '—'}</dd>
    </div>
  );
}
