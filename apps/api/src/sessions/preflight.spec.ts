import { describe, expect, it } from 'vitest';
import type { PreflightRequest } from '@vcip/shared';
import type { PreflightThresholds } from './preflight.js';
import { evaluatePreflight } from './preflight.js';

/** The schema defaults from `docs/06-database-schema.md` §6a. */
const THRESHOLDS: PreflightThresholds = {
  minVideoPx: 480,
  minMicLevel: 10,
  maxRttMs: 300,
  minDownlinkKbps: 500,
  minLightingScore: 30,
  minStabilityScore: 30,
};

/** Comfortably above every threshold, so each test varies one field. */
const GOOD: PreflightRequest = {
  camera_width: 1280,
  camera_height: 720,
  microphone_level: 62.5,
  network_rtt_ms: 48,
  downlink_kbps: 4200,
  lighting_score: 71,
  stability_score: 88,
};

const evaluate = (overrides: Partial<PreflightRequest>, thresholds = THRESHOLDS) =>
  evaluatePreflight({ ...GOOD, ...overrides }, thresholds);

describe('passing measurements', () => {
  it('passes a good device with no failed checks', () => {
    const result = evaluatePreflight(GOOD, THRESHOLDS);
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });

  it('passes when every measurement sits exactly on its threshold', () => {
    // Inclusive comparisons: a tenant configuring min_downlink_kbps = 500 means
    // 500 is acceptable, not "just below acceptable".
    const result = evaluatePreflight(
      {
        camera_width: 480,
        camera_height: 480,
        microphone_level: 10,
        network_rtt_ms: 300,
        downlink_kbps: 500,
        lighting_score: 30,
        stability_score: 30,
      },
      THRESHOLDS,
    );
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });
});

describe('each threshold is applied independently', () => {
  it('applies min_video_px to the SHORTER dimension', () => {
    // A wide but short frame is not a usable camera, however large the width.
    const result = evaluate({ camera_width: 1920, camera_height: 200 });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('camera_height');
    expect(result.failedChecks).toContain('camera_width');
  });

  it('applies min_video_px when the width is the shorter dimension', () => {
    const result = evaluate({ camera_width: 240, camera_height: 1080 });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('camera_width');
  });

  it('applies min_mic_level', () => {
    expect(evaluate({ microphone_level: 9.99 }).failedChecks).toEqual(['microphone_level']);
    expect(evaluate({ microphone_level: 10 }).ok).toBe(true);
  });

  it('applies max_rtt_ms as a ceiling, not a floor', () => {
    expect(evaluate({ network_rtt_ms: 301 }).failedChecks).toEqual(['network_rtt_ms']);
    expect(evaluate({ network_rtt_ms: 300 }).ok).toBe(true);
    // A very fast connection must never be rejected for being fast.
    expect(evaluate({ network_rtt_ms: 0 }).ok).toBe(true);
  });

  it('applies min_downlink_kbps', () => {
    expect(evaluate({ downlink_kbps: 499 }).failedChecks).toEqual(['downlink_kbps']);
    expect(evaluate({ downlink_kbps: 500 }).ok).toBe(true);
  });

  it('applies min_lighting_score', () => {
    expect(evaluate({ lighting_score: 29.9 }).failedChecks).toEqual(['lighting_score']);
    expect(evaluate({ lighting_score: 30 }).ok).toBe(true);
  });

  it('applies min_stability_score', () => {
    expect(evaluate({ stability_score: 29.9 }).failedChecks).toEqual(['stability_score']);
    expect(evaluate({ stability_score: 30 }).ok).toBe(true);
  });
});

describe('per-tenant thresholds', () => {
  it('uses the tenant it is given, not a global default', () => {
    const strict: PreflightThresholds = {
      minVideoPx: 1080,
      minMicLevel: 50,
      maxRttMs: 40,
      minDownlinkKbps: 5000,
      minLightingScore: 80,
      minStabilityScore: 90,
    };
    // Measurements that pass under the defaults fail under this tenant.
    expect(evaluatePreflight(GOOD, THRESHOLDS).ok).toBe(true);
    const result = evaluatePreflight(GOOD, strict);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual([
      'camera_width',
      'camera_height',
      'network_rtt_ms',
      'downlink_kbps',
      'lighting_score',
      'stability_score',
    ]);
    // The one measurement comfortably above this tenant's bar is not reported.
    expect(result.failedChecks).not.toContain('microphone_level');
  });

  it('a permissive tenant accepts what a strict one rejects', () => {
    const permissive: PreflightThresholds = {
      minVideoPx: 1,
      minMicLevel: 0,
      maxRttMs: 100_000,
      minDownlinkKbps: 0,
      minLightingScore: 0,
      minStabilityScore: 0,
    };
    const poor: PreflightRequest = {
      camera_width: 320,
      camera_height: 180,
      microphone_level: 1,
      network_rtt_ms: 900,
      downlink_kbps: 40,
      lighting_score: 2,
      stability_score: 3,
    };
    expect(evaluatePreflight(poor, THRESHOLDS).ok).toBe(false);
    expect(evaluatePreflight(poor, permissive).ok).toBe(true);
  });
});

describe('failed_checks accuracy', () => {
  it('names only the measurements that actually failed', () => {
    const result = evaluate({ downlink_kbps: 100, lighting_score: 5 });
    expect(result.ok).toBe(false);
    expect([...result.failedChecks].sort()).toEqual(['downlink_kbps', 'lighting_score']);
  });

  it('reports every failure when everything is bad', () => {
    const result = evaluatePreflight(
      {
        camera_width: 100,
        camera_height: 100,
        microphone_level: 0,
        network_rtt_ms: 5000,
        downlink_kbps: 0,
        lighting_score: 0,
        stability_score: 0,
      },
      THRESHOLDS,
    );
    expect(result.failedChecks).toEqual([
      'camera_width',
      'camera_height',
      'microphone_level',
      'network_rtt_ms',
      'downlink_kbps',
      'lighting_score',
      'stability_score',
    ]);
  });

  it('reports failures in the order the API contract lists the fields', () => {
    const result = evaluate({ stability_score: 0, microphone_level: 0, downlink_kbps: 0 });
    expect(result.failedChecks).toEqual(['microphone_level', 'downlink_kbps', 'stability_score']);
  });

  it('never reports a check for a passing measurement', () => {
    const result = evaluate({ lighting_score: 1 });
    expect(result.failedChecks).not.toContain('stability_score');
    expect(result.failedChecks).not.toContain('camera_width');
  });
});

describe('the client cannot influence the verdict (D11)', () => {
  it('ignores an extra preflight_ok field entirely', () => {
    // The schema rejects this shape before it reaches here; this asserts the
    // evaluator would not honour it even if something else let it through.
    const smuggled = { ...GOOD, downlink_kbps: 1, preflight_ok: true } as PreflightRequest;
    expect(evaluatePreflight(smuggled, THRESHOLDS).ok).toBe(false);
  });

  it('derives the verdict solely from measurements and thresholds', () => {
    // Same measurements, two tenants, two answers — proving the decision is a
    // function of the tenant's configuration and not of anything client-sent.
    const measurements = { ...GOOD, downlink_kbps: 600 };
    expect(evaluatePreflight(measurements, THRESHOLDS).ok).toBe(true);
    expect(evaluatePreflight(measurements, { ...THRESHOLDS, minDownlinkKbps: 700 }).ok).toBe(false);
  });
});
