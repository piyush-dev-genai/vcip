/**
 * Location capture.
 *
 * The refusal paths get as much attention as the success path: a denied
 * permission is the single most likely outcome on this screen, and it must
 * produce an explanation rather than an unhandled rejection.
 */

import { describe, expect, it, vi } from 'vitest';
import { locationSchema } from '@vcip/shared';
import type { GeolocationLike } from './geolocation';
import {
  GeolocationError,
  GeolocationFailure,
  currentPosition,
  explainGeolocationFailure,
  failureFromCode,
  toLocationRequest,
} from './geolocation';

const position = (overrides: Partial<GeolocationCoordinates> = {}, timestamp = 1_756_500_000_000) =>
  ({
    coords: {
      latitude: 28.6139,
      longitude: 77.209,
      accuracy: 25,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...overrides,
    },
    timestamp,
  }) as GeolocationPosition;

describe('toLocationRequest', () => {
  it('produces exactly the four fields the shared schema defines', () => {
    const body = toLocationRequest(position());
    expect(Object.keys(body).sort()).toEqual([
      'accuracy_m',
      'captured_at',
      'latitude',
      'longitude',
    ]);
    expect(() => locationSchema.parse(body)).not.toThrow();
  });

  it('never adds geo_ok — the server decides that', () => {
    expect(toLocationRequest(position())).not.toHaveProperty('geo_ok');
  });

  it('uses the timestamp of the fix, not the moment of submission', () => {
    const body = toLocationRequest(position({}, Date.UTC(2026, 7, 27, 10, 30, 0)));
    expect(body.captured_at).toBe('2026-08-27T10:30:00.000Z');
  });

  it('clamps an absurd accuracy into range rather than failing validation', () => {
    // A 900 km radius is a useless fix, and a useless fix should be judged by
    // the server, not rejected by a 400 that tells the customer nothing.
    const body = toLocationRequest(position({ accuracy: 900_000 }));
    expect(body.accuracy_m).toBe(100_000);
    expect(() => locationSchema.parse(body)).not.toThrow();
  });

  it('survives a non-finite accuracy', () => {
    const body = toLocationRequest(position({ accuracy: Number.NaN }));
    expect(() => locationSchema.parse(body)).not.toThrow();
  });
});

describe('failureFromCode', () => {
  it('maps the three standard codes', () => {
    expect(failureFromCode(1)).toBe(GeolocationFailure.PERMISSION_DENIED);
    expect(failureFromCode(2)).toBe(GeolocationFailure.POSITION_UNAVAILABLE);
    expect(failureFromCode(3)).toBe(GeolocationFailure.TIMEOUT);
  });

  it('treats anything unrecognised as unavailable', () => {
    expect(failureFromCode(99)).toBe(GeolocationFailure.POSITION_UNAVAILABLE);
  });
});

describe('currentPosition', () => {
  it('resolves with the request body', async () => {
    const geolocation: GeolocationLike = {
      getCurrentPosition: (onSuccess) => {
        onSuccess(position());
      },
    };
    await expect(currentPosition(geolocation)).resolves.toMatchObject({ accuracy_m: 25 });
  });

  it('rejects with a permission failure when the customer declines', async () => {
    const geolocation: GeolocationLike = {
      getCurrentPosition: (_onSuccess, onError) => {
        onError({ code: 1 });
      },
    };
    await expect(currentPosition(geolocation)).rejects.toMatchObject({
      reason: GeolocationFailure.PERMISSION_DENIED,
    });
  });

  it('rejects with a timeout failure', async () => {
    const geolocation: GeolocationLike = {
      getCurrentPosition: (_onSuccess, onError) => {
        onError({ code: 3 });
      },
    };
    const thrown = await currentPosition(geolocation).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(GeolocationError);
    expect((thrown as GeolocationError).reason).toBe(GeolocationFailure.TIMEOUT);
  });

  it('rejects when the browser has no geolocation at all', async () => {
    await expect(currentPosition(undefined)).rejects.toMatchObject({
      reason: GeolocationFailure.UNSUPPORTED,
    });
  });

  it('asks for a fresh high-accuracy fix, not a cached one', () => {
    // `maximumAge: 0` matters: a cached city-level position would pass an
    // accuracy gate it has no business passing.
    const getCurrentPosition = vi.fn();
    void currentPosition({ getCurrentPosition });
    const options = getCurrentPosition.mock.calls[0]?.[2] as PositionOptions;
    expect(options.enableHighAccuracy).toBe(true);
    expect(options.maximumAge).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
  });
});

describe('explainGeolocationFailure', () => {
  it('explains every failure, and never names a coordinate', () => {
    for (const reason of Object.values(GeolocationFailure)) {
      const explanation = explainGeolocationFailure(reason);
      expect(explanation.title.length).toBeGreaterThan(0);
      expect(explanation.detail.length).toBeGreaterThan(0);
    }
  });

  it('offers a retry where one could work, and not where it could not', () => {
    expect(explainGeolocationFailure(GeolocationFailure.PERMISSION_DENIED).retryable).toBe(true);
    expect(explainGeolocationFailure(GeolocationFailure.UNSUPPORTED).retryable).toBe(false);
  });
});
