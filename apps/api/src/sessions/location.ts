/**
 * Server-side location evaluation.
 *
 * Two checks, and one hard rule about what survives them.
 *
 *   - **GPS accuracy** against `tenants.gps_max_accuracy_m`. A fix with a
 *     500-metre radius does not establish where anyone is.
 *   - **IP country**, through the `GeoProvider` seam (R7). The static MVP
 *     provider never blocks and an unknown country passes, so this check cannot
 *     stop a local demo — but the seam is real, and a provider that does block
 *     needs no change here.
 *
 * The rule: the coordinates are an argument to this function and go no further.
 * `latitude` and `longitude` are sensitive location data (§39) and have no
 * durable column — the session stores only `geo_ok`, `gps_accuracy_m`,
 * `geo_checked_at`, and `ip_country`. This function returns exactly those, which
 * is what makes "we did not persist the coordinates" checkable rather than a
 * claim about discipline elsewhere.
 */

import type { LocationCheck } from '@vcip/shared';
import type { GeoDecision } from '../common/geo/geo.provider.js';

export interface LocationThresholds {
  readonly gpsMaxAccuracyM: number;
}

/** The measurement this gate consumes. Coordinates are not part of it. */
export interface LocationMeasurement {
  readonly accuracyM: number;
}

export interface LocationResult {
  readonly ok: boolean;
  readonly failedChecks: readonly LocationCheck[];
  /**
   * Exactly what is persisted. Note the absence of latitude and longitude:
   * this shape is the sensitive-data boundary, expressed as a type.
   */
  readonly persist: {
    readonly geoOk: boolean;
    readonly gpsAccuracyM: number;
    readonly ipCountry: string | null;
  };
}

export function evaluateLocation(
  measured: LocationMeasurement,
  geo: GeoDecision,
  thresholds: LocationThresholds,
): LocationResult {
  const failed: LocationCheck[] = [];

  if (measured.accuracyM > thresholds.gpsMaxAccuracyM) {
    failed.push('gps_accuracy_m');
  }
  // R7: only an explicit refusal fails. An unresolved country is `allowed`, so
  // a missing lookup service degrades to "we do not know" rather than to "no".
  if (!geo.allowed) {
    failed.push('ip_country');
  }

  const ok = failed.length === 0;

  return {
    ok,
    failedChecks: failed,
    persist: {
      geoOk: ok,
      // Rounded to a whole metre: the column is INTEGER, and sub-metre
      // precision on a browser accuracy estimate is noise.
      gpsAccuracyM: Math.round(measured.accuracyM),
      // Recorded even on failure — knowing where a rejected attempt came from
      // is the point of storing it at all.
      ipCountry: geo.country,
    },
  };
}
