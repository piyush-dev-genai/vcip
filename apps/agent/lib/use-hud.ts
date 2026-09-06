'use client';

import { AI_HUD_STALE_AFTER_MS } from '@vcip/shared';
import type { AiHudPayload } from '@vcip/shared';
import { useEffect, useState } from 'react';
import type { AiHud } from './ai-hud';
import { hudFor } from './ai-hud';

/**
 * The AI result for one session, re-evaluated as it ages.
 *
 * A component that rendered only on message would never notice the AI going
 * quiet: the last result would sit there looking current forever, which is
 * exactly the case T32 exists to catch. So a timer re-reads the same pure
 * function on an interval, and staleness arrives on its own.
 *
 * It lives here rather than inside the panel because the call screen now has
 * three readers of the same answer — the panel that shows it, the tab badge
 * that summarises it while that panel is closed, and the document check that
 * waits on it. Three timers would give three slightly different "now"s and,
 * with them, a tab badge that disagreed with the panel it labels.
 *
 * The interval is a fraction of the staleness window, so a reader flips within
 * a second of the deadline rather than up to ten seconds late.
 */
export function useFreshHud(
  updates: Readonly<Record<string, AiHudPayload>>,
  sessionId: string,
): AiHud {
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
