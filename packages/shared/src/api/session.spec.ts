import { describe, expect, it } from 'vitest';
import { consentSchema, createSessionSchema, locationSchema, preflightSchema } from './session.js';

/** A payload that must always pass, so each test can vary one field. */
const VALID_PREFLIGHT = {
  camera_width: 1280,
  camera_height: 720,
  microphone_level: 62.5,
  network_rtt_ms: 48,
  downlink_kbps: 4200,
  lighting_score: 71.0,
  stability_score: 88.0,
};

const VALID_LOCATION = {
  latitude: 28.6139,
  longitude: 77.209,
  accuracy_m: 25,
  captured_at: '2026-08-27T10:30:00Z',
};

const failedPaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe('createSessionSchema', () => {
  it('accepts the documented request', () => {
    expect(createSessionSchema.parse({ external_ref: 'loan-12345', language: 'en' })).toEqual({
      external_ref: 'loan-12345',
      language: 'en',
    });
  });

  it('accepts a regional language tag', () => {
    expect(createSessionSchema.safeParse({ external_ref: 'r', language: 'hi-IN' }).success).toBe(
      true,
    );
  });

  it('requires a non-empty external_ref', () => {
    expect(createSessionSchema.safeParse({ external_ref: '', language: 'en' }).success).toBe(false);
    expect(createSessionSchema.safeParse({ language: 'en' }).success).toBe(false);
  });

  it('rejects a language that is not a tag', () => {
    for (const language of ['e', 'english!', '12', '']) {
      expect(createSessionSchema.safeParse({ external_ref: 'r', language }).success).toBe(false);
    }
  });

  it('rejects a client-supplied tenant_id rather than stripping it', () => {
    // The tenant guard rejects this first at the HTTP boundary; the schema
    // refusing it too means the value can never reach a handler by any route.
    const result = createSessionSchema.safeParse({
      external_ref: 'r',
      language: 'en',
      tenant_id: 'some-other-tenant',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a client-supplied status or session_id', () => {
    expect(
      createSessionSchema.safeParse({ external_ref: 'r', language: 'en', status: 'APPROVED' })
        .success,
    ).toBe(false);
    expect(
      createSessionSchema.safeParse({ external_ref: 'r', language: 'en', session_id: 'x' }).success,
    ).toBe(false);
  });
});

describe('consentSchema', () => {
  it('accepts an explicit acceptance', () => {
    expect(consentSchema.parse({ accepted: true, consent_version: 'v1' })).toEqual({
      accepted: true,
      consent_version: 'v1',
    });
  });

  it('accepts an explicit refusal', () => {
    expect(consentSchema.safeParse({ accepted: false, consent_version: 'v1' }).success).toBe(true);
  });

  it('requires accepted to be a real boolean, never a coerced string', () => {
    // "true" arriving from a form-encoded client must not become consent.
    for (const accepted of ['true', 'false', 1, 0, null, undefined]) {
      expect(consentSchema.safeParse({ accepted, consent_version: 'v1' }).success).toBe(false);
    }
  });

  it('requires a non-empty consent_version', () => {
    expect(consentSchema.safeParse({ accepted: true, consent_version: '' }).success).toBe(false);
    expect(consentSchema.safeParse({ accepted: true }).success).toBe(false);
  });
});

describe('preflightSchema', () => {
  it('accepts the documented measurements', () => {
    expect(preflightSchema.parse(VALID_PREFLIGHT)).toEqual(VALID_PREFLIGHT);
  });

  it('requires positive camera dimensions', () => {
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, camera_width: 0 }).success).toBe(false);
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, camera_height: -1 }).success).toBe(
      false,
    );
  });

  it('requires integer camera dimensions and integer network values', () => {
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, camera_width: 1280.5 }).success).toBe(
      false,
    );
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, network_rtt_ms: 48.5 }).success).toBe(
      false,
    );
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, downlink_kbps: 0.5 }).success).toBe(
      false,
    );
  });

  it('allows zero rtt and zero downlink', () => {
    expect(
      preflightSchema.safeParse({ ...VALID_PREFLIGHT, network_rtt_ms: 0, downlink_kbps: 0 })
        .success,
    ).toBe(true);
  });

  it('rejects negative rtt or downlink', () => {
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, network_rtt_ms: -1 }).success).toBe(
      false,
    );
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, downlink_kbps: -1 }).success).toBe(
      false,
    );
  });

  it('holds the three scores to 0..100 inclusive', () => {
    for (const field of ['microphone_level', 'lighting_score', 'stability_score'] as const) {
      expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, [field]: 0 }).success).toBe(true);
      expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, [field]: 100 }).success).toBe(true);
      expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, [field]: -0.1 }).success).toBe(false);
      expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, [field]: 100.1 }).success).toBe(false);
    }
  });

  it('requires every measurement; a missing one cannot default to a pass', () => {
    for (const field of Object.keys(VALID_PREFLIGHT)) {
      const partial: Record<string, unknown> = { ...VALID_PREFLIGHT };
      delete partial[field];
      const result = preflightSchema.safeParse(partial);
      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain(field);
    }
  });

  it('refuses a client-asserted preflight_ok (D11)', () => {
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, preflight_ok: true }).success).toBe(
      false,
    );
  });

  it('refuses client-asserted thresholds', () => {
    expect(preflightSchema.safeParse({ ...VALID_PREFLIGHT, min_video_px: 1 }).success).toBe(false);
  });
});

describe('locationSchema', () => {
  it('accepts the documented request', () => {
    expect(locationSchema.parse(VALID_LOCATION)).toEqual(VALID_LOCATION);
  });

  it('holds latitude to -90..90 and longitude to -180..180', () => {
    expect(locationSchema.safeParse({ ...VALID_LOCATION, latitude: 90 }).success).toBe(true);
    expect(locationSchema.safeParse({ ...VALID_LOCATION, latitude: -90 }).success).toBe(true);
    expect(locationSchema.safeParse({ ...VALID_LOCATION, latitude: 90.1 }).success).toBe(false);
    expect(locationSchema.safeParse({ ...VALID_LOCATION, longitude: 180.1 }).success).toBe(false);
    expect(locationSchema.safeParse({ ...VALID_LOCATION, longitude: -180.1 }).success).toBe(false);
  });

  it('rejects a negative accuracy', () => {
    expect(locationSchema.safeParse({ ...VALID_LOCATION, accuracy_m: -1 }).success).toBe(false);
  });

  it('accepts zero accuracy and a large but bounded accuracy', () => {
    expect(locationSchema.safeParse({ ...VALID_LOCATION, accuracy_m: 0 }).success).toBe(true);
    expect(locationSchema.safeParse({ ...VALID_LOCATION, accuracy_m: 100_000 }).success).toBe(true);
    expect(locationSchema.safeParse({ ...VALID_LOCATION, accuracy_m: 100_001 }).success).toBe(
      false,
    );
  });

  it('requires an ISO timestamp carrying an offset', () => {
    expect(locationSchema.safeParse({ ...VALID_LOCATION, captured_at: 'yesterday' }).success).toBe(
      false,
    );
    expect(
      locationSchema.safeParse({ ...VALID_LOCATION, captured_at: '2026-08-27T10:30:00' }).success,
    ).toBe(false);
    expect(
      locationSchema.safeParse({ ...VALID_LOCATION, captured_at: '2026-08-27T10:30:00+05:30' })
        .success,
    ).toBe(true);
  });

  it('refuses a client-asserted geo_ok', () => {
    expect(locationSchema.safeParse({ ...VALID_LOCATION, geo_ok: true }).success).toBe(false);
  });

  it('refuses a client-supplied ip_country', () => {
    // The country is resolved from the connection, never claimed by the client.
    expect(locationSchema.safeParse({ ...VALID_LOCATION, ip_country: 'IN' }).success).toBe(false);
  });
});
