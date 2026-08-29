import { describe, expect, it } from 'vitest';
import type { EventPayload } from './event-payload.js';
import {
  InvalidEventPayloadError,
  ProhibitedEventPayloadError,
  assertPayloadAllowed,
  isProhibitedKey,
  normaliseKey,
} from './event-payload.js';

const allows = (payload: EventPayload): void => {
  expect(() => assertPayloadAllowed(payload)).not.toThrow();
};

const rejects = (payload: EventPayload, key: string): void => {
  expect(() => assertPayloadAllowed(payload)).toThrow(ProhibitedEventPayloadError);
  try {
    assertPayloadAllowed(payload);
  } catch (error) {
    expect((error as ProhibitedEventPayloadError).key).toBe(key);
  }
};

describe('the payloads T12 actually writes are allowed', () => {
  // If any of these start failing, the denylist has become too aggressive and
  // the approved design no longer fits through it.

  it('allows the SESSION_CREATED payload', () => {
    allows({ language: 'en' });
  });

  it('allows the consent payload', () => {
    allows({ accepted: true, consent_version: 'v1' });
  });

  it('allows the preflight payload with measurements and thresholds', () => {
    allows({
      measurements: {
        camera_width: 1280,
        camera_height: 720,
        microphone_level: 62.5,
        network_rtt_ms: 48,
        downlink_kbps: 4200,
        lighting_score: 71,
        stability_score: 88,
      },
      thresholds: { min_video_px: 480, min_downlink_kbps: 500 },
      failed_checks: ['downlink_kbps', 'lighting_score'],
    });
  });

  it('allows gps_accuracy_m and ip_country, which are approved columns', () => {
    // The reason the denylist matches whole keys and not substrings. A rule on
    // "gps" or "ip" would reject the exact payload the design specifies.
    allows({ gps_accuracy_m: 25, gps_max_accuracy_m: 100, ip_country: 'IN' });
  });

  it('allows the abort payload', () => {
    allows({ from: 'QUEUED', to: 'DROPPED_QUEUED', reason: 'CUSTOMER_ABORT' });
  });
});

describe('prohibited keys are rejected', () => {
  it('rejects credentials', () => {
    rejects({ password: 'x' }, 'password');
    rejects({ token: 'x' }, 'token');
    rejects({ jwt: 'x' }, 'jwt');
    rejects({ api_key: 'x' }, 'api_key');
    rejects({ authorization: 'x' }, 'authorization');
    rejects({ private_key: 'x' }, 'private_key');
    rejects({ password_hash: 'x' }, 'password_hash');
  });

  it('rejects precise location', () => {
    rejects({ latitude: 28.6 }, 'latitude');
    rejects({ longitude: 77.2 }, 'longitude');
    rejects({ lat: 28.6 }, 'lat');
    rejects({ coordinates: [28.6, 77.2] }, 'coordinates');
  });

  it('rejects raw network identity', () => {
    rejects({ ip: '203.0.113.1' }, 'ip');
    rejects({ ip_address: '203.0.113.1' }, 'ip_address');
    rejects({ client_ip: '203.0.113.1' }, 'client_ip');
  });

  it('rejects identity documents', () => {
    rejects({ pan: 'ABCDE1234F' }, 'pan');
    rejects({ aadhaar: '0000' }, 'aadhaar');
  });

  it('rejects captured content and extracted text', () => {
    rejects({ face_image: 'data:...' }, 'face_image');
    rejects({ ocr_text: 'NAME ...' }, 'ocr_text');
    rejects({ video: 'x' }, 'video');
    rejects({ frames: [] }, 'frames');
  });
});

describe('naming conventions cannot evade the check', () => {
  it('matches regardless of case or separator', () => {
    rejects({ Latitude: 1 }, 'Latitude');
    rejects({ LATITUDE: 1 }, 'LATITUDE');
    rejects({ ipAddress: 'x' }, 'ipAddress');
    rejects({ 'ip-address': 'x' }, 'ip-address');
    rejects({ IP_ADDRESS: 'x' }, 'IP_ADDRESS');
  });

  it('normalises the way the matcher expects', () => {
    expect(normaliseKey('ip_address')).toBe('ipaddress');
    expect(normaliseKey('IP-Address')).toBe('ipaddress');
    expect(normaliseKey('ip country')).toBe('ipcountry');
    expect(isProhibitedKey('ipAddress')).toBe(true);
    expect(isProhibitedKey('ip_country')).toBe(false);
    expect(isProhibitedKey('gps_accuracy_m')).toBe(false);
  });
});

describe('nested structures are walked', () => {
  it('finds a prohibited key inside an object', () => {
    rejects({ device: { camera: 'ok', latitude: 28.6 } }, 'device.latitude');
  });

  it('finds a prohibited key several levels down', () => {
    rejects({ a: { b: { c: { token: 'x' } } } }, 'a.b.c.token');
  });

  it('finds a prohibited key inside an array of objects', () => {
    rejects({ attempts: [{ ok: true }, { pan: 'ABCDE1234F' }] }, 'attempts.pan');
  });

  it('reports the full path, so the offending key is findable', () => {
    rejects({ outer: { inner: { ocr_text: 'x' } } }, 'outer.inner.ocr_text');
  });

  it('refuses a pathologically nested payload rather than recursing forever', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => assertPayloadAllowed(deep as EventPayload)).toThrow(InvalidEventPayloadError);
  });
});

describe('values JSONB cannot hold are rejected', () => {
  it('rejects a function', () => {
    expect(() => assertPayloadAllowed({ fn: (() => 1) as never })).toThrow(
      InvalidEventPayloadError,
    );
  });

  it('rejects undefined', () => {
    expect(() => assertPayloadAllowed({ nothing: undefined as never })).toThrow(
      InvalidEventPayloadError,
    );
  });

  it('rejects NaN and Infinity, which would serialise to null', () => {
    expect(() => assertPayloadAllowed({ score: Number.NaN })).toThrow(InvalidEventPayloadError);
    expect(() => assertPayloadAllowed({ score: Number.POSITIVE_INFINITY })).toThrow(
      InvalidEventPayloadError,
    );
  });

  it('rejects a BigInt', () => {
    expect(() => assertPayloadAllowed({ big: 1n as never })).toThrow(InvalidEventPayloadError);
  });

  it('allows null, which JSONB holds perfectly well', () => {
    allows({ ip_country: null });
  });

  it('allows an empty payload', () => {
    allows({});
  });
});

describe('the guard does not rewrite what it is given', () => {
  it('leaves an allowed payload untouched', () => {
    const payload = { language: 'en', nested: { ok: true } };
    const before = JSON.stringify(payload);
    assertPayloadAllowed(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('throws rather than stripping, so the upstream bug surfaces', () => {
    // Silently removing the key would store a plausible-looking event and hide
    // whatever put a credential in it.
    const payload = { language: 'en', token: 'FAKE-TOKEN-VALUE' };
    expect(() => assertPayloadAllowed(payload)).toThrow(ProhibitedEventPayloadError);
    expect(payload.token).toBe('FAKE-TOKEN-VALUE');
  });

  it('never quotes the offending value in the error', () => {
    try {
      assertPayloadAllowed({ password: 'FAKE-SECRET-VALUE' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('password');
      expect((error as Error).message).not.toContain('FAKE-SECRET-VALUE');
    }
  });
});
