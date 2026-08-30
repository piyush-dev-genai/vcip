/**
 * Preflight measurement.
 *
 * The scoring functions are deterministic, so they are tested as functions.
 * `sampleNetwork` touches `fetch` but takes it as an argument, so its
 * orchestration is testable here too — including the case that matters most,
 * where nothing can be measured and the result must be 0 rather than a number
 * that would pass.
 *
 * Nothing in this file asserts a threshold. There are none to assert: the
 * comparison is the server's (D11), and a test here that encoded one would be
 * the first half of the duplication D11 forbids.
 */

import { describe, expect, it, vi } from 'vitest';
import { PREFLIGHT_MEASUREMENTS, preflightSchema } from '@vcip/shared';
import {
  MIC_CEILING_DBFS,
  MIC_FLOOR_DBFS,
  STABILITY_ZERO_AT,
  clampScore,
  dimensionsFromTrack,
  downlinkKbpsFromMbps,
  kbpsFromTransfer,
  lightingScoreFromLuminance,
  luminanceBuffer,
  meanAbsoluteDifference,
  meanLuminance,
  medianOf,
  micLevelFromRms,
  rmsOf,
  sampleNetwork,
  stabilityScoreFromDelta,
} from './measure';

/** An RGBA buffer of `pixels` identical pixels. */
const solid = (r: number, g: number, b: number, pixels = 16): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    out.set([r, g, b, 255], i * 4);
  }
  return out;
};

// ------------------------------------------------------------- clamping

describe('clampScore', () => {
  it('holds every score inside the schema range', () => {
    expect(clampScore(-10)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(42)).toBe(42);
  });

  it('turns a non-finite value into 0, never into a passing number', () => {
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ---------------------------------------------------------- microphone

describe('microphone level', () => {
  it('computes RMS of a time-domain buffer', () => {
    expect(rmsOf([1, -1, 1, -1])).toBeCloseTo(1);
    expect(rmsOf([0, 0, 0, 0])).toBe(0);
    expect(rmsOf([])).toBe(0);
  });

  it('reports silence as 0', () => {
    expect(micLevelFromRms(0)).toBe(0);
    expect(micLevelFromRms(-0.5)).toBe(0);
  });

  it('anchors the scale at the documented dBFS window', () => {
    expect(micLevelFromRms(10 ** (MIC_FLOOR_DBFS / 20))).toBe(0);
    expect(micLevelFromRms(10 ** (MIC_CEILING_DBFS / 20))).toBe(100);
  });

  it('is monotonic and logarithmic, so ordinary speech is not squashed to zero', () => {
    // A linear mapping would put every normal speaking voice under 20.
    const quiet = micLevelFromRms(0.005);
    const speech = micLevelFromRms(0.05);
    const loud = micLevelFromRms(0.2);
    expect(quiet).toBeLessThan(speech);
    expect(speech).toBeLessThan(loud);
    expect(speech).toBeGreaterThan(30);
  });

  it('never escapes 0-100', () => {
    for (const rms of [1e-9, 0.001, 0.5, 1, 12]) {
      const level = micLevelFromRms(rms);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(100);
    }
  });
});

// ------------------------------------------------------------- lighting

describe('lighting', () => {
  it('weights luminance the way a display does, not as a channel average', () => {
    // Pure green is far brighter than pure blue at the same channel value.
    expect(meanLuminance(solid(0, 255, 0))).toBeGreaterThan(meanLuminance(solid(0, 0, 255)));
    expect(meanLuminance(solid(255, 255, 255))).toBeCloseTo(255, 0);
    expect(meanLuminance(solid(0, 0, 0))).toBe(0);
  });

  it('is 0 for an empty buffer', () => {
    expect(meanLuminance(new Uint8ClampedArray(0))).toBe(0);
  });

  it('scores a well-lit frame full marks', () => {
    expect(lightingScoreFromLuminance(120)).toBe(100);
  });

  it('penalises darkness', () => {
    expect(lightingScoreFromLuminance(0)).toBe(0);
    expect(lightingScoreFromLuminance(40)).toBeLessThan(100);
    expect(lightingScoreFromLuminance(40)).toBeGreaterThan(0);
  });

  it('penalises a blown-out frame too, rather than rewarding brightness', () => {
    // The property a monotonic score would get wrong: a blank white frame is
    // not a good camera image.
    expect(lightingScoreFromLuminance(255)).toBe(0);
    expect(lightingScoreFromLuminance(230)).toBeLessThan(50);
  });

  it('never escapes 0-100', () => {
    for (const mean of [-50, 0, 128, 255, 400, Number.NaN]) {
      const score = lightingScoreFromLuminance(mean);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

// ------------------------------------------------------------ stability

describe('stability', () => {
  it('is 0 difference for identical frames', () => {
    const frame = luminanceBuffer(solid(120, 120, 120));
    expect(meanAbsoluteDifference(frame, frame)).toBe(0);
  });

  it('grows with movement', () => {
    const a = luminanceBuffer(solid(100, 100, 100));
    const b = luminanceBuffer(solid(140, 140, 140));
    expect(meanAbsoluteDifference(a, b)).toBeCloseTo(40, 0);
  });

  it('treats a resolution change as maximum movement', () => {
    // Simulcast ramps resolution mid-stream (D23's spike found exactly this).
    // A frame that cannot be compared is not a steady frame.
    expect(meanAbsoluteDifference(new Float32Array(4), new Float32Array(8))).toBe(255);
    expect(meanAbsoluteDifference(new Float32Array(0), new Float32Array(4))).toBe(255);
  });

  it('scores a still camera 100 and a shaken one 0', () => {
    expect(stabilityScoreFromDelta(0)).toBe(100);
    expect(stabilityScoreFromDelta(STABILITY_ZERO_AT)).toBe(0);
    expect(stabilityScoreFromDelta(200)).toBe(0);
  });

  it('never escapes 0-100', () => {
    for (const delta of [-1, 0, 20, 400, Number.NaN]) {
      const score = stabilityScoreFromDelta(delta);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

// -------------------------------------------------------------- network

describe('medianOf', () => {
  it('ignores one outlier, which is why it is not a mean', () => {
    expect(medianOf([40, 45, 4000])).toBe(45);
  });

  it('averages the middle pair for an even count', () => {
    expect(medianOf([10, 20, 30, 40])).toBe(25);
  });

  it('drops unusable samples and returns 0 when nothing is left', () => {
    expect(medianOf([Number.NaN, -5])).toBe(0);
    expect(medianOf([])).toBe(0);
  });
});

describe('downlink conversion', () => {
  it('converts the browser estimate from Mbps to kbps', () => {
    expect(downlinkKbpsFromMbps(4.2)).toBe(4200);
    expect(downlinkKbpsFromMbps(0)).toBe(0);
    expect(downlinkKbpsFromMbps(Number.NaN)).toBe(0);
  });

  it('computes throughput from a completed transfer', () => {
    // 131072 bytes in 1000 ms is about 1048 kbps.
    expect(kbpsFromTransfer(131072, 1000)).toBe(1049);
    expect(kbpsFromTransfer(0, 1000)).toBe(0);
    expect(kbpsFromTransfer(1000, 0)).toBe(0);
  });
});

describe('sampleNetwork', () => {
  const okResponse = (bytes = 0) => new Response(new Uint8Array(bytes), { status: 200 });

  it('measures RTT as the median of repeated probes against the Control API', async () => {
    let clock = 0;
    const times = [0, 50, 100, 140, 200, 260];
    const fetchImpl = vi.fn((_url: string) => Promise.resolve(okResponse()));
    const result = await sampleNetwork({
      rttUrl: 'http://localhost:3001/health',
      throughputUrl: '/api/probe',
      fetchImpl,
      now: () => times[clock++] ?? 0,
      connection: { downlink: 4 },
    });
    // Probes span 50, 40, and 60 ms.
    expect(result.rttMs).toBe(50);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/health'))).toHaveLength(3);
  });

  it('prefers the browser estimate and labels it as measured', async () => {
    const fetchImpl = vi.fn((_url: string) => Promise.resolve(okResponse()));
    const result = await sampleNetwork({
      rttUrl: '/health',
      throughputUrl: '/api/probe',
      fetchImpl,
      now: () => 0,
      connection: { downlink: 4.2 },
    });
    expect(result.downlinkKbps).toBe(4200);
    expect(result.downlinkApproximate).toBe(false);
    // No throughput transfer when the browser already reports a figure.
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/api/probe'))).toBe(false);
  });

  it('falls back to a timed transfer, and says the value is an approximation', async () => {
    let clock = 0;
    const times = [0, 0, 0, 0, 0, 0, 0, 1000];
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(okResponse(url.includes('/api/probe') ? 131072 : 0)),
    );
    const result = await sampleNetwork({
      rttUrl: '/health',
      throughputUrl: '/api/probe',
      fetchImpl,
      now: () => times[clock++] ?? 1000,
      connection: undefined,
    });
    expect(result.downlinkApproximate).toBe(true);
    expect(result.downlinkKbps).toBeGreaterThan(0);
  });

  it('reports 0 rather than a guess when nothing can be measured', async () => {
    // The direction that matters. An unmeasurable connection must fail the
    // server-side gate, not slip past it on an invented number.
    const fetchImpl = vi.fn(() => Promise.reject(new Error('offline')));
    const result = await sampleNetwork({
      rttUrl: '/health',
      throughputUrl: '/api/probe',
      fetchImpl,
      now: () => 0,
      connection: undefined,
    });
    expect(result.rttMs).toBe(0);
    expect(result.downlinkKbps).toBe(0);
    expect(result.downlinkApproximate).toBe(true);
  });

  it('survives some probes failing', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      return call === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve(okResponse());
    });
    const result = await sampleNetwork({
      rttUrl: '/health',
      throughputUrl: '/api/probe',
      fetchImpl,
      now: () => 0,
      connection: { downlink: 1 },
    });
    expect(result.downlinkKbps).toBe(1000);
  });
});

// ------------------------------------------------------------- camera

describe('dimensionsFromTrack', () => {
  const track = (settings: MediaTrackSettings): MediaStreamTrack =>
    ({ getSettings: () => settings }) as MediaStreamTrack;

  it('reads what the device is producing, not what was requested', () => {
    expect(dimensionsFromTrack(track({ width: 640, height: 480 }))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('is null when the track reports no dimensions', () => {
    expect(dimensionsFromTrack(track({}))).toBeNull();
    expect(dimensionsFromTrack(track({ width: 0, height: 0 }))).toBeNull();
  });
});

// ------------------------------------------------------------ the shape

describe('the measurement payload', () => {
  it('is exactly the seven fields the shared schema defines', () => {
    // If this app ever grew an eighth measurement, or dropped one, the strict
    // schema would reject the body — this states the same thing up front.
    const values = {
      camera_width: 1280,
      camera_height: 720,
      microphone_level: micLevelFromRms(0.05),
      network_rtt_ms: 48,
      downlink_kbps: 4200,
      lighting_score: lightingScoreFromLuminance(120),
      stability_score: stabilityScoreFromDelta(2),
    };
    expect(Object.keys(values).sort()).toEqual([...PREFLIGHT_MEASUREMENTS].sort());
    expect(() => preflightSchema.parse(values)).not.toThrow();
  });

  it('produces values the schema accepts even at the extremes', () => {
    expect(() =>
      preflightSchema.parse({
        camera_width: 1,
        camera_height: 1,
        microphone_level: micLevelFromRms(0),
        network_rtt_ms: 0,
        downlink_kbps: 0,
        lighting_score: lightingScoreFromLuminance(0),
        stability_score: stabilityScoreFromDelta(999),
      }),
    ).not.toThrow();
  });
});
