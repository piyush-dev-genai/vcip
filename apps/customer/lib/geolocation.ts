/**
 * Location capture.
 *
 * The browser produces a fix; this turns it into the request body T12 expects
 * and classifies a refusal into something the UI can explain.
 *
 * The coordinates exist in exactly one place — the object handed to
 * `POST /v1/sessions/{id}/location` — and go nowhere else. They are not stored,
 * not put in a URL, not logged, and not kept in component state beyond the
 * request. §39 classes precise location as sensitive, and T12 already refuses to
 * persist it server-side; the browser side of that promise is this file's job.
 *
 * `geo_ok` is deliberately not computed here. Accuracy is judged against
 * `tenants.gps_max_accuracy_m` on the server, together with the IP country the
 * browser cannot see.
 */

import type { LocationRequest } from '@vcip/shared';

/** Why a fix could not be taken. Each maps to its own explanation on screen. */
export const GeolocationFailure = {
  UNSUPPORTED: 'unsupported',
  PERMISSION_DENIED: 'permission_denied',
  POSITION_UNAVAILABLE: 'position_unavailable',
  TIMEOUT: 'timeout',
} as const;

export type GeolocationFailure = (typeof GeolocationFailure)[keyof typeof GeolocationFailure];

export class GeolocationError extends Error {
  readonly reason: GeolocationFailure;

  constructor(reason: GeolocationFailure) {
    super(`geolocation failed: ${reason}`);
    this.name = 'GeolocationError';
    this.reason = reason;
  }
}

/** The three `GeolocationPositionError` codes, without relying on the constants
 *  being present — they are absent in a non-browser runtime. */
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

export function failureFromCode(code: number): GeolocationFailure {
  switch (code) {
    case PERMISSION_DENIED:
      return GeolocationFailure.PERMISSION_DENIED;
    case TIMEOUT:
      return GeolocationFailure.TIMEOUT;
    case POSITION_UNAVAILABLE:
      return GeolocationFailure.POSITION_UNAVAILABLE;
    default:
      return GeolocationFailure.POSITION_UNAVAILABLE;
  }
}

/**
 * Build the request body from a browser position.
 *
 * `captured_at` comes from the fix's own timestamp, not from `Date.now()`: it
 * is when the position was determined, which is the thing worth recording. The
 * server does not trust it for anything security-relevant — it owns
 * `geo_checked_at` itself — so a skewed client clock is not a hazard here.
 *
 * Accuracy is clamped to the schema's ceiling rather than allowed to fail
 * validation: a browser reporting a 200-kilometre radius is reporting a useless
 * fix, and a useless fix should be *judged* by the server, not rejected by a
 * 400 that tells the customer nothing.
 */
const MAX_ACCURACY_M = 100_000;

export function toLocationRequest(position: GeolocationPosition): LocationRequest {
  const accuracy = position.coords.accuracy;
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_m: Number.isFinite(accuracy)
      ? Math.min(Math.max(accuracy, 0), MAX_ACCURACY_M)
      : MAX_ACCURACY_M,
    captured_at: new Date(position.timestamp).toISOString(),
  };
}

/** Matches the browser's own option bag; injected so this is testable. */
export interface GeolocationLike {
  getCurrentPosition(
    onSuccess: (position: GeolocationPosition) => void,
    onError: (error: { code: number }) => void,
    options?: PositionOptions,
  ): void;
}

const OPTIONS: PositionOptions = {
  // A KYC location gate wants the real fix, not a cached city-level guess.
  enableHighAccuracy: true,
  timeout: 20_000,
  maximumAge: 0,
};

export function currentPosition(
  geolocation: GeolocationLike | undefined,
): Promise<LocationRequest> {
  if (geolocation === undefined) {
    return Promise.reject(new GeolocationError(GeolocationFailure.UNSUPPORTED));
  }
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        resolve(toLocationRequest(position));
      },
      (error) => {
        reject(new GeolocationError(failureFromCode(error.code)));
      },
      OPTIONS,
    );
  });
}

export interface GeolocationExplanation {
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/** What to say about each refusal. Fixed text, like the API error table. */
export function explainGeolocationFailure(reason: GeolocationFailure): GeolocationExplanation {
  switch (reason) {
    case GeolocationFailure.PERMISSION_DENIED:
      return {
        title: 'Location permission was declined',
        detail:
          'Verification requires your location. Allow location access for this site in your browser settings, then try again.',
        retryable: true,
      };
    case GeolocationFailure.TIMEOUT:
      return {
        title: 'Could not get your location in time',
        detail: 'Move somewhere with a clearer view of the sky or a better signal, then try again.',
        retryable: true,
      };
    case GeolocationFailure.UNSUPPORTED:
      return {
        title: 'This browser cannot share your location',
        detail: 'Please open this link in an up-to-date browser.',
        retryable: false,
      };
    case GeolocationFailure.POSITION_UNAVAILABLE:
      return {
        title: 'Your location is unavailable',
        detail:
          'Your device could not determine where it is. Check that location services are on, then try again.',
        retryable: true,
      };
  }
}
