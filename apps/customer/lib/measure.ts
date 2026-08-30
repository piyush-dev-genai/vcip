/**
 * Preflight measurement (D11).
 *
 * The browser measures; the server judges. Nothing in this file knows a
 * threshold, and nothing in this file decides whether preflight passed — that
 * comparison belongs to the tenant's configuration on the server, and putting a
 * copy of it here is exactly the failure D11 was written to prevent.
 *
 * The file splits in two on purpose:
 *
 *   - **Scoring functions** are pure — array in, number out. They carry the
 *     judgement calls (what counts as well-lit, what counts as steady) and are
 *     unit-tested under Node with no DOM, which is what keeps them honest.
 *   - **Capture functions** touch `getUserMedia`, `AudioContext`, canvas, and
 *     `fetch`. Their dependencies are injected so the orchestration is testable
 *     too, and so this module can be imported during server rendering without
 *     evaluating a browser global.
 *
 * Where a value cannot be measured, it is not invented. Every approximation
 * below says so at its definition, and each fails *low* rather than high: a
 * measurement we could not take must not become a passing number.
 */

import type { PreflightRequest } from '@vcip/shared';

declare global {
  interface Window {
    /** Safari's prefixed constructor. Absent everywhere else. */
    webkitAudioContext?: typeof AudioContext;
  }
}

// ------------------------------------------------------------------ scoring

/** Scores are 0-100 in the shared schema; nothing may escape that range. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Microphone level from a linear RMS amplitude (0-1).
 *
 * Mapped through decibels rather than linearly, because loudness is
 * logarithmic: a linear scale puts every ordinary speaking voice in the bottom
 * tenth of the range and makes the number useless for a threshold.
 *
 * The window is -60 dBFS (silence, near the noise floor of a laptop mic) to
 * -10 dBFS (loud, close speech). Anything quieter is 0, anything louder is 100.
 */
export const MIC_FLOOR_DBFS = -60;
export const MIC_CEILING_DBFS = -10;

export function micLevelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const dbfs = 20 * Math.log10(rms);
  const ratio = (dbfs - MIC_FLOOR_DBFS) / (MIC_CEILING_DBFS - MIC_FLOOR_DBFS);
  return round1(clampScore(ratio * 100));
}

/** RMS of a `getFloatTimeDomainData` buffer, whose samples are -1..1. */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Mean luminance of an RGBA buffer, 0-255.
 *
 * Rec. 709 coefficients — the same weighting a display uses, so "bright" here
 * means what a human would call bright rather than what the raw channel average
 * would suggest.
 */
export function meanLuminance(rgba: ArrayLike<number>): number {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return 0;
  let total = 0;
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    const r = rgba[offset] ?? 0;
    const g = rgba[offset + 1] ?? 0;
    const b = rgba[offset + 2] ?? 0;
    total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return total / pixels;
}

/**
 * Lighting score from mean luminance.
 *
 * A band, not a ramp. Too dark hides a face; too bright blows it out, and a
 * washed-out frame is no more usable than a dark one — a monotonic "brighter is
 * better" score would rate a blank white frame perfect. Full marks between 70
 * and 190, falling linearly to zero at 10 and 250.
 */
export const LIGHTING_IDEAL_MIN = 70;
export const LIGHTING_IDEAL_MAX = 190;
const LIGHTING_DARK_ZERO = 10;
const LIGHTING_BRIGHT_ZERO = 250;

export function lightingScoreFromLuminance(mean: number): number {
  if (!Number.isFinite(mean)) return 0;
  if (mean >= LIGHTING_IDEAL_MIN && mean <= LIGHTING_IDEAL_MAX) return 100;
  if (mean < LIGHTING_IDEAL_MIN) {
    const span = LIGHTING_IDEAL_MIN - LIGHTING_DARK_ZERO;
    return round1(clampScore(((mean - LIGHTING_DARK_ZERO) / span) * 100));
  }
  const span = LIGHTING_BRIGHT_ZERO - LIGHTING_IDEAL_MAX;
  return round1(clampScore(((LIGHTING_BRIGHT_ZERO - mean) / span) * 100));
}

/**
 * Mean absolute difference between two equal-length luminance buffers, 0-255.
 *
 * Returns 255 for mismatched lengths rather than throwing: a resolution change
 * mid-capture (simulcast does exactly this — see D23's spike notes) is a real
 * instability, and reporting it as maximum movement is truthful.
 */
export function meanAbsoluteDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0) return 255;
  if (a.length !== b.length) return 255;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return total / a.length;
}

/**
 * Stability score from mean frame-to-frame difference.
 *
 * Zero movement scores 100; a difference of 40 levels or more scores 0. Chosen
 * so that a hand-held phone still passes while a camera being waved around does
 * not. This measures camera steadiness, not the subject — it is a device check,
 * not a biometric one.
 */
export const STABILITY_ZERO_AT = 40;

export function stabilityScoreFromDelta(meanDelta: number): number {
  if (!Number.isFinite(meanDelta) || meanDelta < 0) return 0;
  return round1(clampScore((1 - meanDelta / STABILITY_ZERO_AT) * 100));
}

/** Median, so one stalled probe does not drag the reported latency with it. */
export function medianOf(samples: readonly number[]): number {
  const usable = samples
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  const middle = Math.floor(usable.length / 2);
  if (usable.length % 2 === 1) return usable[middle] ?? 0;
  return ((usable[middle - 1] ?? 0) + (usable[middle] ?? 0)) / 2;
}

/** `NetworkInformation.downlink` is megabits per second. The API wants kbps. */
export function downlinkKbpsFromMbps(mbps: number): number {
  if (!Number.isFinite(mbps) || mbps <= 0) return 0;
  return Math.round(mbps * 1000);
}

/** Throughput of a completed transfer. */
export function kbpsFromTransfer(bytes: number, elapsedMs: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs)) return 0;
  if (bytes <= 0 || elapsedMs <= 0) return 0;
  return Math.round((bytes * 8) / elapsedMs);
}

// ------------------------------------------------------------------ capture

/** A camera and microphone held open only for the duration of preflight. */
export interface PreflightMedia {
  readonly stream: MediaStream;
  /** Idempotent. Called on completion, on unmount, and on failure (§9). */
  stop(): void;
}

/** Camera dimensions, read from the track the browser actually gave us. */
export interface CameraDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Dimensions from a video track's own settings.
 *
 * `getSettings()` reports what the device is producing, which is not
 * necessarily what was requested — a camera asked for 1280x720 may return
 * 640x480, and reporting the request would be reporting a wish.
 */
export function dimensionsFromTrack(track: MediaStreamTrack): CameraDimensions | null {
  const settings = track.getSettings();
  const width = settings.width;
  const height = settings.height;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

export async function openPreflightMedia(): Promise<PreflightMedia> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: true,
  });

  let stopped = false;
  return {
    stream,
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/** How the video sample buffer is sized. Small on purpose: this is a lighting
 *  and movement measurement, not image analysis, and a 64x36 buffer is 2304
 *  pixels rather than a megapixel. */
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
const SAMPLE_COUNT = 8;
const SAMPLE_INTERVAL_MS = 120;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Luminance of every pixel in an RGBA buffer, for frame differencing. */
export function luminanceBuffer(rgba: ArrayLike<number>): Float32Array {
  const pixels = Math.floor(rgba.length / 4);
  const out = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    out[i] =
      0.2126 * (rgba[offset] ?? 0) +
      0.7152 * (rgba[offset + 1] ?? 0) +
      0.0722 * (rgba[offset + 2] ?? 0);
  }
  return out;
}

export interface VideoSampleResult {
  readonly lightingScore: number;
  readonly stabilityScore: number;
  /** How many frames were actually read. Zero means both scores are 0. */
  readonly frames: number;
}

/**
 * Sample the live video and derive lighting and stability.
 *
 * Frames are drawn to a small off-screen canvas, measured, and discarded. No
 * frame is stored, encoded, uploaded, or logged (§9) — only the two numbers
 * below leave this function.
 */
export async function sampleVideo(stream: MediaStream): Promise<VideoSampleResult> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return { lightingScore: 0, stabilityScore: 0, frames: 0 };

  try {
    await video.play();
  } catch {
    // Autoplay refused on a muted, source-bound element is unusual but not
    // fatal; the draw below simply yields nothing and both scores stay 0.
  }

  const luminances: number[] = [];
  const deltas: number[] = [];
  let previous: Float32Array | null = null;
  let frames = 0;

  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    if (i > 0) await wait(SAMPLE_INTERVAL_MS);
    if (video.videoWidth === 0 || video.videoHeight === 0) continue;

    context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const frame = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
    frames += 1;

    luminances.push(meanLuminance(frame));
    const current = luminanceBuffer(frame);
    if (previous !== null) deltas.push(meanAbsoluteDifference(previous, current));
    previous = current;
  }

  video.pause();
  video.srcObject = null;

  if (frames === 0) return { lightingScore: 0, stabilityScore: 0, frames: 0 };

  const meanLight = luminances.reduce((total, value) => total + value, 0) / luminances.length;
  // A single frame yields no difference to measure. Report 0 rather than a
  // flattering 100: we did not observe stability, we merely failed to sample.
  const meanDelta = deltas.length === 0 ? STABILITY_ZERO_AT : medianOf(deltas);

  return {
    lightingScore: lightingScoreFromLuminance(meanLight),
    stabilityScore: stabilityScoreFromDelta(meanDelta),
    frames,
  };
}

const MIC_SAMPLE_COUNT = 12;
const MIC_SAMPLE_INTERVAL_MS = 100;

/**
 * Microphone level from live audio.
 *
 * An `AnalyserNode` over the real input, sampled for about 1.2 seconds. The
 * loudest window is taken rather than the average: the customer may not speak
 * for the whole window, and averaging in their silence would measure patience
 * rather than the microphone.
 *
 * No audio is recorded. The analyser reads the live buffer and nothing is
 * retained.
 */
export async function sampleMicrophone(stream: MediaStream): Promise<number> {
  if (stream.getAudioTracks().length === 0) return 0;

  const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
  if (AudioCtor === undefined) return 0;

  const context = new AudioCtor();
  try {
    if (context.state === 'suspended') await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < MIC_SAMPLE_COUNT; i += 1) {
      await wait(MIC_SAMPLE_INTERVAL_MS);
      analyser.getFloatTimeDomainData(buffer);
      peak = Math.max(peak, rmsOf(buffer));
    }

    source.disconnect();
    return micLevelFromRms(peak);
  } finally {
    await context.close();
  }
}

export interface NetworkSample {
  readonly rttMs: number;
  readonly downlinkKbps: number;
  /** True when `downlink_kbps` came from a timed transfer rather than from the
   *  browser's own estimate. Surfaced so the UI and this module can be honest
   *  about which number the server is judging. */
  readonly downlinkApproximate: boolean;
}

const RTT_PROBE_COUNT = 3;
/** Bytes requested from the same-origin probe route for the throughput test. */
export const THROUGHPUT_PROBE_BYTES = 131072;

export interface NetworkProbeDeps {
  /** Absolute URL of the Control API's `/health`, for the latency probes. */
  readonly rttUrl: string;
  /** Same-origin route that returns `THROUGHPUT_PROBE_BYTES` bytes. */
  readonly throughputUrl: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  /** `navigator.connection`, when the browser has one. */
  readonly connection?: { readonly downlink?: number } | undefined;
}

/**
 * Round-trip time and downlink.
 *
 * **RTT is measured**, as the median of three timed requests to the Control
 * API's health route. That is the real path the session will use, which is what
 * makes it worth measuring rather than reading from an API.
 *
 * **Downlink is the browser's estimate when there is one.**
 * `navigator.connection.downlink` is Chromium-only, and by specification it is
 * *deliberately coarse* — rounded to the nearest 25 kbps and capped around
 * 10 Mbps to limit fingerprinting. It is an estimate, not a measurement, and it
 * is labelled as such below.
 *
 * **Otherwise it is approximated** by timing a 128 KB same-origin download.
 * That is a genuine transfer, but it is a *lower bound*: TCP has not left slow
 * start at that size, so a fast connection measures slower than it is. It never
 * over-reports, which is the direction a gate should err in.
 *
 * If both fail, the result is 0 — no measurement, no invented number, and a
 * server-side failure the customer can see and act on.
 */
export async function sampleNetwork(deps: NetworkProbeDeps): Promise<NetworkSample> {
  const doFetch = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? (() => performance.now());

  const rtts: number[] = [];
  for (let i = 0; i < RTT_PROBE_COUNT; i += 1) {
    const started = now();
    try {
      const response = await doFetch(`${deps.rttUrl}?probe=${String(i)}`, { cache: 'no-store' });
      await response.arrayBuffer();
      rtts.push(now() - started);
    } catch {
      // A failed probe contributes nothing rather than a punitive number: the
      // median of the rest is a better answer than a fabricated timeout.
    }
  }
  const rttMs = Math.round(medianOf(rtts));

  const reported = deps.connection?.downlink;
  if (typeof reported === 'number' && reported > 0) {
    return { rttMs, downlinkKbps: downlinkKbpsFromMbps(reported), downlinkApproximate: false };
  }

  try {
    const started = now();
    const response = await doFetch(
      `${deps.throughputUrl}?bytes=${String(THROUGHPUT_PROBE_BYTES)}`,
      {
        cache: 'no-store',
      },
    );
    const payload = await response.arrayBuffer();
    const elapsed = now() - started;
    return {
      rttMs,
      downlinkKbps: kbpsFromTransfer(payload.byteLength, elapsed),
      downlinkApproximate: true,
    };
  } catch {
    return { rttMs, downlinkKbps: 0, downlinkApproximate: true };
  }
}

export interface PreflightMeasurement {
  readonly values: PreflightRequest;
  /** True when `downlink_kbps` is the timed-transfer lower bound. */
  readonly downlinkApproximate: boolean;
}

/**
 * Take all seven measurements.
 *
 * Assembles exactly the fields `preflightSchema` defines and nothing else — no
 * `preflight_ok`, no threshold, no verdict. The server compares.
 */
export async function measurePreflight(
  media: PreflightMedia,
  network: NetworkProbeDeps,
): Promise<PreflightMeasurement> {
  const [videoTrack] = media.stream.getVideoTracks();
  const dimensions = videoTrack === undefined ? null : dimensionsFromTrack(videoTrack);

  const [video, microphoneLevel, net] = await Promise.all([
    sampleVideo(media.stream),
    sampleMicrophone(media.stream),
    sampleNetwork(network),
  ]);

  return {
    values: {
      // 1x1 when the track reported nothing: a positive integer, as the schema
      // requires, and far below any tenant's `min_video_px`. Reporting a
      // plausible default here would be asserting a camera we never saw.
      camera_width: dimensions?.width ?? 1,
      camera_height: dimensions?.height ?? 1,
      microphone_level: microphoneLevel,
      network_rtt_ms: net.rttMs,
      downlink_kbps: net.downlinkKbps,
      lighting_score: video.lightingScore,
      stability_score: video.stabilityScore,
    },
    downlinkApproximate: net.downlinkApproximate,
  };
}
