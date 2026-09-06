'use client';

import { useEffect, useRef, useState } from 'react';
import type { PreflightRequest } from '@vcip/shared';
import { PREFLIGHT_MEASUREMENTS } from '@vcip/shared';
import { apiBaseUrl } from '@/lib/config';
import type { PreflightMedia } from '@/lib/measure';
import { measurePreflight, openPreflightMedia, THROUGHPUT_PROBE_BYTES } from '@/lib/measure';
import { Steps } from './Steps';

/**
 * Screen 2 — device and connection check.
 *
 * The camera and microphone are opened, measured, and released. They are open
 * for the length of one measurement pass and are stopped the moment it ends, on
 * unmount, and on failure (§9). No frame is stored or transmitted: the seven
 * numbers below are the only thing that leaves the device.
 *
 * The measured values are shown before they are submitted. That is not
 * decoration — the customer is about to be told that one of them was too low,
 * and being shown what was measured is what makes that message actionable.
 *
 * Nothing here decides whether the check passed. There is no threshold in this
 * file; the server compares against the tenant's configuration (D11), which is
 * also why the readouts below are figures and never verdicts. A green tick
 * beside a number this app is not entitled to judge would be a promise the
 * server may then break.
 */

const LABELS: Readonly<Record<string, string>> = {
  camera_width: 'Camera width',
  camera_height: 'Camera height',
  microphone_level: 'Microphone level',
  network_rtt_ms: 'Network round trip',
  downlink_kbps: 'Download speed',
  lighting_score: 'Lighting',
  stability_score: 'Camera steadiness',
};

const UNITS: Readonly<Record<string, string>> = {
  camera_width: 'px',
  camera_height: 'px',
  microphone_level: '/ 100',
  network_rtt_ms: 'ms',
  downlink_kbps: 'kbps',
  lighting_score: '/ 100',
  stability_score: '/ 100',
};

type Phase = 'idle' | 'measuring' | 'measured' | 'blocked';

export function Preflight({
  busy,
  onSubmit,
}: {
  /** True while the parent is posting to the Control API. */
  busy: boolean;
  onSubmit: (values: PreflightRequest) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [values, setValues] = useState<PreflightRequest | null>(null);
  const [approximate, setApproximate] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const mediaRef = useRef<PreflightMedia | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  // The safety net for every path that is not the happy one: navigating away,
  // a refresh, an unmount mid-measurement. Without it a camera light stays on.
  useEffect(() => {
    return () => {
      mediaRef.current?.stop();
      mediaRef.current = null;
    };
  }, []);

  async function runCheck(): Promise<void> {
    setPhase('measuring');
    setBlockedReason(null);

    let media: PreflightMedia;
    try {
      media = await openPreflightMedia();
    } catch {
      // Permission refused, no device, or the device is in use. The reason is
      // not distinguished: every one of them is fixed the same way, and the
      // browser's own error text is not written for a customer to read.
      setPhase('blocked');
      setBlockedReason(
        'We could not use your camera and microphone. Allow access for this site in your browser, close any other app using the camera, and try again.',
      );
      return;
    }

    mediaRef.current = media;
    const preview = previewRef.current;
    if (preview !== null) {
      preview.srcObject = media.stream;
      // A preview the customer can see is what makes a lighting score fair:
      // being told the room is too dark is only useful next to the picture.
      void preview.play().catch(() => undefined);
    }

    try {
      const measured = await measurePreflight(media, {
        rttUrl: `${apiBaseUrl()}/health`,
        throughputUrl: '/api/probe',
        connection: (navigator as { connection?: { downlink?: number } }).connection,
      });
      setValues(measured.values);
      setApproximate(measured.downlinkApproximate);
      setPhase('measured');
    } catch {
      setPhase('blocked');
      setBlockedReason('The device check could not be completed. Please try again.');
    } finally {
      // Released as soon as the measurement is done, not when the screen
      // changes: there is no reason to hold a camera open while a customer
      // reads a list of numbers.
      media.stop();
      mediaRef.current = null;
      if (preview !== null) preview.srcObject = null;
    }
  }

  const measuring = phase === 'measuring';

  return (
    <section className="card">
      <Steps current={2} />

      <h1>Check your camera and connection</h1>
      <p className="muted">
        Your camera, microphone, and internet connection are checked before the call, so the agent
        can see and hear you clearly.
      </p>

      {measuring ? (
        <>
          <video className="preview" ref={previewRef} muted playsInline />
          <p className="chip accent" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Measuring — hold still and stay in the light
          </p>
        </>
      ) : null}

      {phase === 'blocked' && blockedReason !== null ? (
        <div className="notice bad" role="alert">
          <h3>Camera or microphone unavailable</h3>
          <p>{blockedReason}</p>
        </div>
      ) : null}

      {values !== null ? (
        <>
          <h2>What we measured</h2>
          <ul className="readouts">
            {PREFLIGHT_MEASUREMENTS.map((name) => (
              <li key={name}>
                <span>{LABELS[name] ?? name}</span>
                <span className="readout-value">
                  {values[name]} <small>{UNITS[name] ?? ''}</small>
                </span>
              </li>
            ))}
          </ul>
          {approximate ? (
            <p className="hint">
              Your browser does not report its connection speed, so the download figure is a
              conservative estimate from a {Math.round(THROUGHPUT_PROBE_BYTES / 1024)} KB test
              transfer.
            </p>
          ) : null}
          <p className="hint">
            These values are sent to be checked. Whether they are good enough is decided by the
            organisation that asked you to verify.
          </p>
        </>
      ) : null}

      <div className="actions">
        {phase === 'measured' && values !== null ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              onSubmit(values);
            }}
          >
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Submitting…
              </>
            ) : (
              'Submit results'
            )}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={measuring || busy}
            onClick={() => {
              void runCheck();
            }}
          >
            {measuring ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Checking…
              </>
            ) : (
              'Start device check'
            )}
          </button>
        )}
        {phase === 'measured' || phase === 'blocked' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void runCheck();
            }}
          >
            Check again
          </button>
        ) : null}
      </div>

      <p className="hint">
        Your camera is used only for this check and is switched off as soon as it finishes. No
        picture or sound is saved or sent anywhere during this step.
      </p>
    </section>
  );
}
