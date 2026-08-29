import { describe, expect, it } from 'vitest';
import type { GeoDecision } from '../common/geo/geo.provider.js';
import { StaticGeoProvider, normaliseCountry } from '../common/geo/geo.provider.js';
import { evaluateLocation } from './location.js';

const THRESHOLDS = { gpsMaxAccuracyM: 100 };

const RESOLVED: GeoDecision = { country: 'IN', allowed: true };
const UNKNOWN: GeoDecision = { country: null, allowed: true };
const DENIED: GeoDecision = { country: 'XX', allowed: false };

describe('GPS accuracy gate', () => {
  it('passes an accurate fix', () => {
    const result = evaluateLocation({ accuracyM: 25 }, RESOLVED, THRESHOLDS);
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.persist.geoOk).toBe(true);
  });

  it('passes a fix exactly on the threshold', () => {
    expect(evaluateLocation({ accuracyM: 100 }, RESOLVED, THRESHOLDS).ok).toBe(true);
  });

  it('fails a fix above the threshold', () => {
    const result = evaluateLocation({ accuracyM: 101 }, RESOLVED, THRESHOLDS);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['gps_accuracy_m']);
    expect(result.persist.geoOk).toBe(false);
  });

  it('uses the tenant threshold it is given', () => {
    const loose = { gpsMaxAccuracyM: 5000 };
    expect(evaluateLocation({ accuracyM: 800 }, RESOLVED, THRESHOLDS).ok).toBe(false);
    expect(evaluateLocation({ accuracyM: 800 }, RESOLVED, loose).ok).toBe(true);
  });

  it('rounds accuracy to whole metres for the INTEGER column', () => {
    expect(evaluateLocation({ accuracyM: 24.6 }, RESOLVED, THRESHOLDS).persist.gpsAccuracyM).toBe(
      25,
    );
    expect(evaluateLocation({ accuracyM: 0.2 }, RESOLVED, THRESHOLDS).persist.gpsAccuracyM).toBe(0);
  });
});

describe('IP country gate (R7)', () => {
  it('passes when the country is unknown, so a local demo is never blocked', () => {
    const result = evaluateLocation({ accuracyM: 25 }, UNKNOWN, THRESHOLDS);
    expect(result.ok).toBe(true);
    expect(result.persist.ipCountry).toBeNull();
  });

  it('records a resolved country', () => {
    expect(evaluateLocation({ accuracyM: 25 }, RESOLVED, THRESHOLDS).persist.ipCountry).toBe('IN');
  });

  it('fails when the provider explicitly refuses the connection', () => {
    const result = evaluateLocation({ accuracyM: 25 }, DENIED, THRESHOLDS);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['ip_country']);
  });

  it('reports both failures when accuracy and country both fail', () => {
    const result = evaluateLocation({ accuracyM: 900 }, DENIED, THRESHOLDS);
    expect(result.failedChecks).toEqual(['gps_accuracy_m', 'ip_country']);
  });

  it('still records the country when the location is rejected', () => {
    // Where a refused attempt came from is exactly the thing worth keeping.
    const result = evaluateLocation({ accuracyM: 900 }, RESOLVED, THRESHOLDS);
    expect(result.ok).toBe(false);
    expect(result.persist.ipCountry).toBe('IN');
  });
});

describe('what is persisted', () => {
  it('returns only geo_ok, accuracy, and country — never coordinates', () => {
    const result = evaluateLocation({ accuracyM: 25 }, RESOLVED, THRESHOLDS);
    expect(Object.keys(result.persist).sort()).toEqual(['geoOk', 'gpsAccuracyM', 'ipCountry']);
  });

  it('has no way to receive coordinates in the first place', () => {
    // The measurement type carries accuracy only. A latitude cannot be
    // persisted by this path because it never reaches it.
    const measurement: Record<string, unknown> = { accuracyM: 25, latitude: 28.6, longitude: 77.2 };
    const result = evaluateLocation(measurement as { accuracyM: number }, RESOLVED, THRESHOLDS);
    expect(JSON.stringify(result.persist)).not.toContain('28.6');
    expect(JSON.stringify(result.persist)).not.toContain('77.2');
  });

  it('geo_ok mirrors the overall result and is never client-supplied', () => {
    expect(evaluateLocation({ accuracyM: 1 }, RESOLVED, THRESHOLDS).persist.geoOk).toBe(true);
    expect(evaluateLocation({ accuracyM: 9999 }, RESOLVED, THRESHOLDS).persist.geoOk).toBe(false);
  });
});

describe('StaticGeoProvider', () => {
  it('reports an unknown country by default, and allows it', async () => {
    const provider = new StaticGeoProvider({});
    expect(await provider.resolve('203.0.113.7')).toEqual({ country: null, allowed: true });
  });

  it('reports the configured country', async () => {
    const provider = new StaticGeoProvider({ VCIP_GEO_STATIC_COUNTRY: 'in' });
    expect(await provider.resolve(null)).toEqual({ country: 'IN', allowed: true });
  });

  it('never blocks, whatever the address', async () => {
    const provider = new StaticGeoProvider({ VCIP_GEO_STATIC_COUNTRY: 'IN' });
    for (const ip of ['127.0.0.1', '::1', '198.51.100.4', null]) {
      expect((await provider.resolve(ip)).allowed).toBe(true);
    }
  });

  it('ignores a misconfigured country rather than storing rubbish', async () => {
    for (const value of ['India', 'I', 'IND', '', '12']) {
      const provider = new StaticGeoProvider({ VCIP_GEO_STATIC_COUNTRY: value });
      expect((await provider.resolve(null)).country).toBeNull();
    }
  });
});

describe('normaliseCountry', () => {
  it('uppercases a valid alpha-2 code', () => {
    expect(normaliseCountry('in')).toBe('IN');
    expect(normaliseCountry(' gb ')).toBe('GB');
  });

  it('rejects anything that is not alpha-2', () => {
    for (const value of ['IND', 'I', '', '  ', 'I1', undefined, null]) {
      expect(normaliseCountry(value)).toBeNull();
    }
  });
});
