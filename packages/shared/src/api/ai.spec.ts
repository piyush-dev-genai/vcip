import { describe, expect, it } from 'vitest';
import {
  LIVENESS_STATUSES,
  LivenessStatus,
  OCR_STATUSES,
  OcrStatus,
  aiResultSchema,
  analyzeRequestSchema,
  LIVENESS_STATUS_VALUES,
  OCR_STATUS_VALUES,
} from '../index.js';

const SESSION = '11111111-2222-4333-8444-555555555555';

const healthy = {
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1', face_match: 'demo-v1', ocr: 'demo-v1' },
};

describe('the status vocabularies', () => {
  it('accepts exactly the liveness statuses the enum defines', () => {
    expect([...LIVENESS_STATUS_VALUES].sort()).toEqual([...LIVENESS_STATUSES].sort());
  });

  it('accepts exactly the OCR statuses the enum defines', () => {
    expect([...OCR_STATUS_VALUES].sort()).toEqual([...OCR_STATUSES].sort());
  });

  it('is the contract vocabulary, not the older system-design sketch', () => {
    // `05-api-contract.md` §23 stores `"ocr_status": "PASS"`.
    expect(OCR_STATUSES).toContain('PASS');
    expect(OCR_STATUSES).not.toContain('OCR_PASS');
    expect(OCR_STATUSES).not.toContain('DOCUMENT_DETECTED');
  });
});

describe('aiResultSchema', () => {
  it('accepts the payload from the API contract', () => {
    expect(aiResultSchema.parse(healthy)).toEqual(healthy);
  });

  it('accepts an entirely unavailable result', () => {
    // D6: AI failure degrades the HUD. The report still arrives.
    const degraded = {
      ...healthy,
      liveness_score: null,
      liveness_status: LivenessStatus.UNAVAILABLE,
      face_match_score: null,
      ocr_status: OcrStatus.UNAVAILABLE,
      model_versions: { liveness: 'unavailable', face_match: 'unavailable', ocr: 'unavailable' },
    };

    expect(aiResultSchema.parse(degraded)).toEqual(degraded);
  });

  it('keeps null distinct from zero', () => {
    // A zero renders on the HUD as a confident failure; null renders as absent.
    expect(aiResultSchema.parse({ ...healthy, liveness_score: 0 }).liveness_score).toBe(0);
    expect(aiResultSchema.parse({ ...healthy, liveness_score: null }).liveness_score).toBeNull();
  });

  it.each([-1, 101, 96.5])('rejects %s as a score', (liveness_score) => {
    expect(aiResultSchema.safeParse({ ...healthy, liveness_score }).success).toBe(false);
  });

  it('rejects a status outside the vocabulary', () => {
    expect(aiResultSchema.safeParse({ ...healthy, ocr_status: 'OCR_PASS' }).success).toBe(false);
  });

  it('rejects a session id that is not a uuid', () => {
    expect(aiResultSchema.safeParse({ ...healthy, session_id: 'session-1' }).success).toBe(false);
  });

  it('rejects an unknown key rather than stripping it', () => {
    // The Python service cannot be type-checked against this file, so a
    // misspelled field has to be an error rather than a silent omission.
    const misspelled = { ...healthy, livenes_score: 97 };

    expect(aiResultSchema.safeParse(misspelled).success).toBe(false);
  });

  it('requires model versions', () => {
    const { model_versions: _dropped, ...without } = healthy;

    expect(aiResultSchema.safeParse(without).success).toBe(false);
  });

  it('rejects an empty model version string', () => {
    expect(aiResultSchema.safeParse({ ...healthy, model_versions: { liveness: '' } }).success).toBe(
      false,
    );
  });

  it('carries no field a verdict could be read from', () => {
    // I7: the AI never decides. Nothing here names a verdict or an outcome.
    expect(Object.keys(aiResultSchema.shape)).toEqual([
      'session_id',
      'liveness_score',
      'liveness_status',
      'face_match_score',
      'ocr_status',
      'model_versions',
    ]);
  });
});

describe('analyzeRequestSchema', () => {
  const request = {
    room_name: `vcip_${SESSION}`,
    token: 'a.livekit.jwt',
    livekit_url: 'ws://localhost:7880',
  };

  it('accepts what the Control API sends', () => {
    expect(analyzeRequestSchema.parse(request)).toEqual(request);
  });

  it('requires the token, since the AI service mints none of its own', () => {
    expect(analyzeRequestSchema.safeParse({ ...request, token: '' }).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(analyzeRequestSchema.safeParse({ ...request, tenant_id: 't1' }).success).toBe(false);
  });

  it('does not carry the session id, which the path already names', () => {
    expect(Object.keys(analyzeRequestSchema.shape)).toEqual(['room_name', 'token', 'livekit_url']);
  });
});
