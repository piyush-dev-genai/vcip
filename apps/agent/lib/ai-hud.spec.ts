import type { AiHudPayload } from '@vcip/shared';
import { AI_HUD_STALE_AFTER_MS, LivenessStatus, OcrStatus } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import {
  applyHudUpdate,
  EMPTY_HUD,
  HudState,
  faceMatchText,
  hudFor,
  isUnavailable,
  livenessText,
  ocrText,
} from './ai-hud';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-02T12:00:00.000Z');

const hud = (overrides: Partial<AiHudPayload> = {}): AiHudPayload => ({
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1' },
  updated_at: new Date(NOW).toISOString(),
  document_type: null,
  document_status: null,
  document_checked_at: null,
  ...overrides,
});

const at = (msAgo: number): AiHudPayload =>
  hud({ updated_at: new Date(NOW - msAgo).toISOString() });

describe('collecting updates', () => {
  it('keeps the latest per session', () => {
    const first = applyHudUpdate({}, hud({ liveness_score: 50 }));
    const second = applyHudUpdate(first, hud({ liveness_score: 90 }));

    expect(second[SESSION]?.liveness_score).toBe(90);
  });

  it('keeps two calls apart', () => {
    // An agent may hold a second call, and the wrong customer's liveness score
    // on screen is the worst thing this panel could render.
    const updates = applyHudUpdate(applyHudUpdate({}, hud()), hud({ session_id: OTHER }));

    expect(Object.keys(updates).sort()).toEqual([SESSION, OTHER].sort());
  });

  it('does not mutate what it was given', () => {
    const before = {};
    applyHudUpdate(before, hud());

    expect(before).toEqual({});
  });
});

describe('before anything has arrived', () => {
  it('is waiting, not unavailable-with-a-value', () => {
    expect(hudFor({}, SESSION, NOW)).toEqual(EMPTY_HUD);
  });

  it('reads as unavailable on the panel', () => {
    // An agent must not be shown a panel that looks live and is empty.
    expect(isUnavailable(hudFor({}, SESSION, NOW))).toBe(true);
  });

  it('shows nothing for a session it has no update for', () => {
    const updates = applyHudUpdate({}, hud({ session_id: OTHER }));

    expect(hudFor(updates, SESSION, NOW).latest).toBeNull();
  });
});

describe('a fresh result', () => {
  const fresh = () => hudFor(applyHudUpdate({}, at(1_000)), SESSION, NOW);

  it('is live', () => {
    expect(fresh().state).toBe(HudState.LIVE);
    expect(isUnavailable(fresh())).toBe(false);
  });

  it('reports its age', () => {
    expect(fresh().ageMs).toBe(1_000);
  });

  it('renders each check', () => {
    expect(livenessText(fresh())).toBe('Live person (97)');
    expect(faceMatchText(fresh())).toBe('95');
    expect(ocrText(fresh())).toBe('Document read');
  });

  it('renders a zero score as a zero, not as nothing', () => {
    const zero = hudFor(applyHudUpdate({}, hud({ liveness_score: 0 })), SESSION, NOW);

    expect(livenessText(zero)).toBe('Live person (0)');
  });

  it('renders an absent score without inventing one', () => {
    // `null` and `0` mean opposite things, and this is the last place the
    // distinction could be lost.
    const undecided = hudFor(
      applyHudUpdate({}, hud({ liveness_status: LivenessStatus.UNKNOWN, liveness_score: null })),
      SESSION,
      NOW,
    );

    expect(livenessText(undecided)).toBe('Undecided');
    expect(livenessText(undecided)).not.toContain('0');
  });

  it('renders an absent face match as no result rather than zero', () => {
    const none = hudFor(applyHudUpdate({}, hud({ face_match_score: null })), SESSION, NOW);

    expect(faceMatchText(none)).toBe('No result');
  });
});

describe('an explicit UNAVAILABLE from the AI service', () => {
  const unavailable = () =>
    hudFor(
      applyHudUpdate(
        {},
        hud({
          liveness_status: LivenessStatus.UNAVAILABLE,
          liveness_score: null,
          ocr_status: OcrStatus.UNAVAILABLE,
        }),
      ),
      SESSION,
      NOW,
    );

  it('is still a live, recent result', () => {
    // The AI is running and saying it could not run a check. That is data.
    expect(unavailable().state).toBe(HudState.LIVE);
  });

  it('says so on the check itself', () => {
    expect(livenessText(unavailable())).toBe('Unavailable');
    expect(ocrText(unavailable())).toBe('Unavailable');
  });
});

describe('staleness — the T32 case', () => {
  it('goes unavailable once nothing has arrived for the window', () => {
    // A killed analyzer sends nothing at all. Without this the panel would go
    // on showing a confident score for the rest of the call.
    const stale = hudFor(applyHudUpdate({}, at(AI_HUD_STALE_AFTER_MS)), SESSION, NOW);

    expect(stale.state).toBe(HudState.STALE);
    expect(isUnavailable(stale)).toBe(true);
  });

  it('tolerates an ordinary late result', () => {
    // T30 publishes every two seconds; five missed cycles is the threshold, so
    // one slow cycle never trips it.
    const late = hudFor(applyHudUpdate({}, at(AI_HUD_STALE_AFTER_MS - 1)), SESSION, NOW);

    expect(late.state).toBe(HudState.LIVE);
  });

  it('hides the last values rather than showing them under the warning', () => {
    // "AI unavailable" above "Live person (97)" invites reading the number and
    // ignoring the warning.
    const stale = hudFor(applyHudUpdate({}, at(60_000)), SESSION, NOW);

    expect(livenessText(stale)).toBeNull();
    expect(faceMatchText(stale)).toBeNull();
    expect(ocrText(stale)).toBeNull();
  });

  it('recovers when the AI comes back', () => {
    const updates = applyHudUpdate(applyHudUpdate({}, at(60_000)), at(0));

    expect(hudFor(updates, SESSION, NOW).state).toBe(HudState.LIVE);
  });

  it('treats an unreadable timestamp as stale, never as current', () => {
    const broken = hudFor(applyHudUpdate({}, hud({ updated_at: 'not a date' })), SESSION, NOW);

    expect(broken.state).toBe(HudState.STALE);
  });

  it('does not go negative when the server clock is ahead', () => {
    const ahead = hudFor(applyHudUpdate({}, at(-5_000)), SESSION, NOW);

    expect(ahead.ageMs).toBe(0);
    expect(ahead.state).toBe(HudState.LIVE);
  });

  it('uses the shared threshold, so both sides agree what stale means', () => {
    expect(AI_HUD_STALE_AFTER_MS).toBe(10_000);
  });
});

describe('the AI dying mid-call, from the portal (T32)', () => {
  it('reads unavailable for the rest of the call, not just for a moment', () => {
    // A killed analyzer never comes back on its own. The panel has to stay
    // honest for the whole remaining call, not flicker and settle.
    const dead = applyHudUpdate({}, at(30_000));

    for (const laterMs of [0, 60_000, 600_000]) {
      expect(isUnavailable(hudFor(dead, SESSION, NOW + laterMs))).toBe(true);
    }
  });

  it('does not trust a HUD handed to a portal that reconnected', () => {
    // The gateway primes a new connection with whatever Redis holds (T31), and
    // Redis holds it for 24 hours. So an agent who reloads after the AI died
    // is handed a result that *arrives* now and was *taken* minutes ago. Age is
    // read from `updated_at` and never from arrival, which is the only reason
    // this reads as unavailable rather than as a confident 97.
    const primed = applyHudUpdate({}, at(5 * 60_000));

    expect(hudFor(primed, SESSION, NOW).state).toBe(HudState.STALE);
    expect(livenessText(hudFor(primed, SESSION, NOW))).toBeNull();
  });

  it('says the same thing whether the AI died or never started', () => {
    // `AI_UNAVAILABLE` in the session history distinguishes the two for an
    // auditor. In front of an agent mid-call they are one fact: there is no
    // signal, and the verdict is theirs either way.
    const died = hudFor(applyHudUpdate({}, at(30_000)), SESSION, NOW);
    const neverStarted = hudFor({}, SESSION, NOW);

    expect(isUnavailable(died)).toBe(isUnavailable(neverStarted));
    expect(livenessText(died)).toBe(livenessText(neverStarted));
  });
});
