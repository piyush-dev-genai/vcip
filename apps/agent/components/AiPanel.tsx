'use client';

import { AI_HUD_STALE_AFTER_MS } from '@vcip/shared';
import { useEffect, useState } from 'react';
import type { AiHud } from '../lib/ai-hud';
import { faceMatchText, hudFor, isUnavailable, livenessText, ocrText } from '../lib/ai-hud';
import type { AiHudPayload } from '@vcip/shared';

/**
 * What the AI has to say about the call in front of the agent (T31).
 *
 * A signal, and the wording is deliberate throughout: "suggests", not
 * "decides". The AI never determines an outcome (I7), the agent's verdict is
 * the only thing that does, and a panel that read like a verdict would invite
 * the one mistake this product cannot afford — an agent approving because the
 * machine said so.
 *
 * It is also allowed to say nothing. AI is off the video critical path (D6),
 * so "AI unavailable" is an ordinary state rather than an error screen: the
 * call continues, the checklist continues, and the verdict is still the
 * agent's to submit.
 */
export interface AiPanelProps {
  readonly sessionId: string;
  /** Every HUD the portal has received, keyed by session. */
  readonly updates: Readonly<Record<string, AiHudPayload>>;
}

export function AiPanel({ sessionId, updates }: AiPanelProps) {
  const hud = useFreshHud(updates, sessionId);

  return (
    <section className="card ai">
      <h2>AI checks</h2>

      {isUnavailable(hud) ? (
        <p className="notice" aria-live="polite">
          AI unavailable
        </p>
      ) : (
        <dl className="facts">
          <Check label="Liveness" value={livenessText(hud)} />
          <Check label="Face match" value={faceMatchText(hud)} />
          <Check label="Document" value={ocrText(hud)} />
        </dl>
      )}

      <p className="hint">Assistive only. The verdict is yours — these checks decide nothing.</p>
    </section>
  );
}

function Check({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      {/* An em dash rather than a zero or a blank: a check with no result must
          not read as a check that failed. */}
      <dd>{value ?? '—'}</dd>
    </div>
  );
}

/**
 * The HUD, re-evaluated as it ages.
 *
 * A component that rendered only on message would never notice the AI going
 * quiet: the last result would sit there looking current forever, which is
 * exactly the case T32 exists to catch. So a timer re-reads the same pure
 * function on an interval, and staleness arrives on its own.
 *
 * The interval is a fraction of the staleness window, so the panel flips
 * within a second of the deadline rather than up to ten seconds late.
 */
function useFreshHud(updates: Readonly<Record<string, AiHudPayload>>, sessionId: string): AiHud {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now());
    }, AI_HUD_STALE_AFTER_MS / 10);
    return () => {
      clearInterval(tick);
    };
  }, []);

  return hudFor(updates, sessionId, now);
}
