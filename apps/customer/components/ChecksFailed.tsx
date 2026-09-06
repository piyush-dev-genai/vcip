'use client';

/**
 * The terminal screen for `PREFLIGHT_FAILED`.
 *
 * Reached from either gate: a sub-threshold device measurement or a failed
 * location check both terminate the session at `PREFLIGHT_FAILED`, unbilled
 * (invariant I5). There is no retry, because the status is terminal on the
 * server — offering one would be offering something the API will refuse.
 *
 * `failedChecks` is present only when this screen follows the response that
 * produced the failure. After a page refresh the server reports the status but
 * not the reasons — `GET /v1/sessions/{id}` returns no `failed_checks` — so the
 * list is omitted rather than reconstructed from a guess.
 */

const LABELS: Readonly<Record<string, string>> = {
  camera_width: 'Camera resolution was too low',
  camera_height: 'Camera resolution was too low',
  microphone_level: 'Your microphone was too quiet',
  network_rtt_ms: 'Your connection was too slow to respond',
  downlink_kbps: 'Your download speed was too low',
  lighting_score: 'The lighting was not good enough',
  stability_score: 'The camera was not steady enough',
  gps_accuracy_m: 'Your location was not precise enough',
  ip_country: 'Verification is not available from your location',
};

export function ChecksFailed({ failedChecks }: { failedChecks: readonly string[] | null }) {
  // Both camera dimensions fail together, and saying so twice helps nobody.
  const reasons =
    failedChecks === null ? [] : [...new Set(failedChecks.map((name) => LABELS[name] ?? name))];

  return (
    <section className="card">
      <p className="step">Verification stopped</p>
      <h1>Your device or location did not meet the requirements</h1>
      <p className="muted">
        The checks before the call did not pass, so the verification cannot continue. You have not
        been charged.
      </p>

      {reasons.length > 0 ? (
        <>
          <h2>What did not pass</h2>
          <ul className="gates">
            {reasons.map((reason) => (
              <li key={reason}>
                <span className="mark todo" aria-hidden="true">
                  ✕
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="hint">
        To try again, please start a new verification from your bank or provider.
      </p>
    </section>
  );
}
