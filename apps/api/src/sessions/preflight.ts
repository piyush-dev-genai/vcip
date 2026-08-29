/**
 * Server-side preflight evaluation (D11).
 *
 * The client submits measurements. This decides whether they pass. That
 * division is the whole point of D11: the previous design took five booleans
 * from the browser, which meant any client could assert that its camera was
 * fine and reach a verification agent with an unusable stream.
 *
 * Pure, so the rule is testable without a database, a tenant, or an HTTP
 * request — and so the thresholds a specific tenant configured are visibly an
 * argument rather than something read from ambient state.
 */

import type { PreflightCheck, PreflightRequest } from '@vcip/shared';

/** The tenant configuration this comparison needs (`§6a`). */
export interface PreflightThresholds {
  /** Compared against `min(camera_width, camera_height)`. */
  readonly minVideoPx: number;
  readonly minMicLevel: number;
  readonly maxRttMs: number;
  readonly minDownlinkKbps: number;
  readonly minLightingScore: number;
  readonly minStabilityScore: number;
}

export interface PreflightResult {
  readonly ok: boolean;
  /**
   * Which measurements fell short, in the contract's field order.
   *
   * Returned to the client so a customer can be told what to fix. Naming the
   * failing measurement is not a threshold disclosure: the customer already
   * knows what they measured, and "your connection is too slow" is the entire
   * purpose of the check.
   */
  readonly failedChecks: readonly PreflightCheck[];
}

/**
 * Compare measurements against thresholds.
 *
 * The comparisons are exactly the six in D11, in the order the contract lists
 * them. Each threshold is inclusive — a value equal to the minimum passes —
 * because a tenant setting `min_downlink_kbps = 500` means 500 is acceptable.
 */
export function evaluatePreflight(
  measured: PreflightRequest,
  thresholds: PreflightThresholds,
): PreflightResult {
  const failed: PreflightCheck[] = [];

  // The video check is one comparison over two fields: a 1280x100 stream is
  // not a usable camera even though its width is generous. Both dimensions are
  // reported, because the customer cannot act on a name they did not submit.
  if (Math.min(measured.camera_width, measured.camera_height) < thresholds.minVideoPx) {
    failed.push('camera_width', 'camera_height');
  }
  if (measured.microphone_level < thresholds.minMicLevel) {
    failed.push('microphone_level');
  }
  // The only ceiling among the six: latency is bad when it is high.
  if (measured.network_rtt_ms > thresholds.maxRttMs) {
    failed.push('network_rtt_ms');
  }
  if (measured.downlink_kbps < thresholds.minDownlinkKbps) {
    failed.push('downlink_kbps');
  }
  if (measured.lighting_score < thresholds.minLightingScore) {
    failed.push('lighting_score');
  }
  if (measured.stability_score < thresholds.minStabilityScore) {
    failed.push('stability_score');
  }

  return { ok: failed.length === 0, failedChecks: failed };
}
