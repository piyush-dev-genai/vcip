'use client';

import { CONSENT_VERSION } from '@/lib/config';
import { Steps } from './Steps';

/**
 * Screen 1 — consent.
 *
 * Two explicit actions, no default and no pre-ticked box. Both are disabled
 * while a request is in flight, which is what makes a double click harmless:
 * the second click cannot fire, so there is no second request to reconcile.
 *
 * Neither button advances anything. The parent moves on only after the server
 * has answered, because `consent_ok` is server state and this screen is not
 * entitled to predict it.
 *
 * "I agree" is the primary action and sits above "Decline", which is the
 * ordering a customer who opened this link expects. The decline is a full,
 * ordinary button rather than a link in the small print: someone who does not
 * want to be recorded should not have to hunt for the way out.
 */
export function Consent({
  busy,
  rejected,
  onDecide,
}: {
  busy: boolean;
  /** The customer refused during this visit. Presentation state only — the
   *  server records `consent_ok = false` and keeps the session `CREATED`. */
  rejected: boolean;
  onDecide: (accepted: boolean) => void;
}) {
  if (rejected) {
    return (
      <section className="card">
        <p className="step">Verification stopped</p>
        <h1>You declined consent</h1>
        <p className="muted">
          The verification cannot continue without it, and nothing further has been recorded.
        </p>
        <p className="muted">
          If you did not mean to decline, please start again from your bank or provider.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <Steps current={1} />

      <h1>Consent to video verification</h1>
      <p className="muted">
        To complete your verification, a trained agent will speak with you over a live video call.
      </p>

      <h2>What this involves</h2>
      <ul className="plain">
        <li>The video call is recorded and kept as evidence of the verification.</li>
        <li>You will be asked to show your face and an identity document.</li>
        <li>Your device camera, microphone, and location are checked before the call.</li>
        <li>The recording is shared with the organisation that asked you to verify.</li>
      </ul>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            onDecide(true);
          }}
        >
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Submitting…
            </>
          ) : (
            'I agree'
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onDecide(false);
          }}
        >
          Decline
        </button>
      </div>

      <p className="hint">Consent text version {CONSENT_VERSION}.</p>
    </section>
  );
}
