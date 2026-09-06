'use client';

import { useState } from 'react';
import type { LocationRequest } from '@vcip/shared';
import type { GeolocationExplanation } from '@/lib/geolocation';
import { GeolocationError, currentPosition, explainGeolocationFailure } from '@/lib/geolocation';
import { Steps } from './Steps';

/**
 * Screen 3 — location.
 *
 * The fix is taken, handed to the parent, and forgotten. Coordinates are never
 * placed in component state, never rendered, and never written anywhere that
 * outlives the request — the customer is told their location was shared, not
 * shown a readout of it (§39). That is also why this screen has no map: a map
 * would mean holding the position long enough to draw it.
 *
 * `geo_ok` is not computed here. Accuracy is judged against the tenant's
 * `gps_max_accuracy_m` on the server, alongside an IP-country check the browser
 * cannot see and is not told about.
 */
export function LocationStep({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (body: LocationRequest) => void;
}) {
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<GeolocationExplanation | null>(null);

  async function share(): Promise<void> {
    setLocating(true);
    setProblem(null);
    try {
      const body = await currentPosition(
        typeof navigator === 'undefined' ? undefined : navigator.geolocation,
      );
      // Straight through. Nothing between here and the request retains it.
      onSubmit(body);
    } catch (error) {
      setProblem(
        explainGeolocationFailure(
          error instanceof GeolocationError ? error.reason : 'position_unavailable',
        ),
      );
    } finally {
      setLocating(false);
    }
  }

  const working = locating || busy;

  return (
    <section className="card">
      <Steps current={3} />

      <h1>Share your location</h1>
      <p className="muted">
        Verification must take place in a permitted location, so your device is asked where it is
        before the call begins.
      </p>

      {problem !== null ? (
        <div className="notice bad" role="alert">
          <h3>{problem.title}</h3>
          <p>{problem.detail}</p>
        </div>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={working}
          onClick={() => {
            void share();
          }}
        >
          {working ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {locating ? 'Getting your location…' : 'Submitting…'}
            </>
          ) : (
            'Share my location'
          )}
        </button>
      </div>

      <p className="hint">
        Your browser will ask for permission. Your position is used once, for this check, and is not
        stored or shown.
      </p>
    </section>
  );
}
