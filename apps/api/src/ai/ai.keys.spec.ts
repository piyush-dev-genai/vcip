import type { AiHudPayload } from '@vcip/shared';
import { LivenessStatus, OcrStatus } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import { fromHudFields, HudField, hudKey, HUD_TTL_SECONDS, toHudFields } from './ai.keys.js';

const SESSION = '11111111-2222-4333-8444-555555555555';

const hud: AiHudPayload = {
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1', face_match: 'demo-v1', ocr: 'demo-v1' },
  updated_at: '2026-09-02T12:00:00.000Z',
};

describe('the HUD key', () => {
  it('is the one `06-database-schema.md` §36 names', () => {
    expect(hudKey(SESSION)).toBe(`session:hud:${SESSION}`);
  });

  it('is per session, so no two calls can share one', () => {
    expect(hudKey('a')).not.toBe(hudKey('b'));
  });

  it('expires after 24 hours, per §36 and §39', () => {
    expect(HUD_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});

describe('writing a HUD', () => {
  it('stores every field the AI reported', () => {
    expect(toHudFields(hud)).toEqual({
      liveness_score: '97',
      liveness_status: 'LIVE',
      face_match_score: '95',
      ocr_status: 'PASS',
      model_versions: '{"liveness":"demo-v1","face_match":"demo-v1","ocr":"demo-v1"}',
      updated_at: '2026-09-02T12:00:00.000Z',
    });
  });

  it('carries the model versions T35 will snapshot', () => {
    // The HUD is the source of `session_ai_summaries.model_versions`, and §36's
    // example does not list the field. Dropping it would leave that column
    // fillable only by guessing.
    expect(toHudFields(hud)).toHaveProperty(HudField.MODEL_VERSIONS);
  });

  it('writes an absent score as empty rather than zero', () => {
    // Redis has no null, and a zero on the HUD reads as a confident failure.
    const fields = toHudFields({ ...hud, liveness_score: null });

    expect(fields[HudField.LIVENESS_SCORE]).toBe('');
  });
});

describe('reading a HUD back', () => {
  const roundTrip = (payload: AiHudPayload): AiHudPayload | null =>
    fromHudFields(payload.session_id, toHudFields(payload));

  it('round-trips a healthy result', () => {
    expect(roundTrip(hud)).toEqual(hud);
  });

  it('round-trips a wholly unavailable result', () => {
    const unavailable: AiHudPayload = {
      ...hud,
      liveness_score: null,
      liveness_status: LivenessStatus.UNAVAILABLE,
      face_match_score: null,
      ocr_status: OcrStatus.UNAVAILABLE,
      model_versions: { liveness: 'unavailable' },
    };

    expect(roundTrip(unavailable)).toEqual(unavailable);
  });

  it('keeps a genuine zero distinct from an absent score', () => {
    expect(roundTrip({ ...hud, liveness_score: 0 })?.liveness_score).toBe(0);
    expect(roundTrip({ ...hud, liveness_score: null })?.liveness_score).toBeNull();
  });

  describe('what it refuses to call a HUD', () => {
    it('an empty hash — the key does not exist', () => {
      expect(fromHudFields(SESSION, {})).toBeNull();
    });

    it('null — Redis was flushed (D2)', () => {
      expect(fromHudFields(SESSION, null)).toBeNull();
    });

    it('a hash with no liveness status', () => {
      const { liveness_status: _dropped, ...partial } = toHudFields(hud);

      expect(fromHudFields(SESSION, partial)).toBeNull();
    });

    it('a status outside the vocabulary, however it got there', () => {
      expect(fromHudFields(SESSION, { ...toHudFields(hud), ocr_status: 'OCR_PASS' })).toBeNull();
    });

    it('a hash with no timestamp, which the staleness rule depends on', () => {
      expect(fromHudFields(SESSION, { ...toHudFields(hud), updated_at: '' })).toBeNull();
    });
  });

  describe('what it repairs rather than refusing', () => {
    it('an unreadable score becomes absent, never zero', () => {
      const fields = { ...toHudFields(hud), liveness_score: 'nonsense' };

      expect(fromHudFields(SESSION, fields)?.liveness_score).toBeNull();
    });

    it('an out-of-range score becomes absent', () => {
      const fields = { ...toHudFields(hud), face_match_score: '900' };

      expect(fromHudFields(SESSION, fields)?.face_match_score).toBeNull();
    });

    it('malformed model versions become an empty map', () => {
      // The rest of the HUD is still worth showing, and `{}` says "we do not
      // know" rather than naming a model that never ran.
      const fields = { ...toHudFields(hud), model_versions: 'not json' };

      expect(fromHudFields(SESSION, fields)?.model_versions).toEqual({});
      expect(fromHudFields(SESSION, fields)?.liveness_status).toBe(LivenessStatus.LIVE);
    });

    it('model versions that are not strings are dropped', () => {
      const fields = { ...toHudFields(hud), model_versions: '{"liveness":1,"ocr":"demo-v1"}' };

      expect(fromHudFields(SESSION, fields)?.model_versions).toEqual({ ocr: 'demo-v1' });
    });

    it('a JSON array is not a version map', () => {
      const fields = { ...toHudFields(hud), model_versions: '["demo-v1"]' };

      expect(fromHudFields(SESSION, fields)?.model_versions).toEqual({});
    });
  });

  it('reports the session it was asked about, not one from the hash', () => {
    // The session id is the key, so it is never stored as a field — a hash
    // that claimed a different one would be the beginning of a cross-session
    // leak.
    expect(fromHudFields('other-session', toHudFields(hud))?.session_id).toBe('other-session');
    expect(toHudFields(hud)).not.toHaveProperty('session_id');
  });
});
