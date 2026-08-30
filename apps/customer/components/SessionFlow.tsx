'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocationRequest, PreflightRequest } from '@vcip/shared';
import { createSessionApi } from '@/lib/api';
import { CONSENT_VERSION, apiBaseUrl } from '@/lib/config';
import type { CustomerMessage } from '@/lib/errors';
import { ApiError, toCustomerMessage } from '@/lib/errors';
import { Screen, screenFor } from '@/lib/screen';
import type { AbortResult, SessionView } from '@/lib/session';
import { browserTokenHost, clearToken, consumeToken } from '@/lib/token';
import { ChecksFailed } from './ChecksFailed';
import { Consent } from './Consent';
import { ErrorNotice } from './ErrorNotice';
import { LocationStep } from './LocationStep';
import { Preflight } from './Preflight';
import { Status } from './Status';

/**
 * The customer flow.
 *
 * Holds two kinds of state, and keeps them apart deliberately:
 *
 *   - **Server state** — the `SessionView` from `GET /v1/sessions/{id}`. It is
 *     never edited locally. Every mutation is followed by a re-read, so what is
 *     on screen is what PostgreSQL says (D1), not what the browser expected the
 *     mutation to do.
 *   - **Presentation state** — whether a request is in flight, which error to
 *     show, the `failed_checks` from the response that caused a failure. None
 *     of it decides where the customer goes; `screenFor` does that, from server
 *     state alone.
 *
 * That split is what makes a refresh unremarkable. There is no resume logic: on
 * mount the component asks the server where the session is and renders it.
 */
export function SessionFlow({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CustomerMessage | null>(null);
  const [tokenMissing, setTokenMissing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Client-only, and null until the first successful read. Rendering a formatted
  // time during SSR would hydrate against a different locale and clock.
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [consentRejected, setConsentRejected] = useState(false);
  const [failedChecks, setFailedChecks] = useState<readonly string[] | null>(null);
  const [aborted, setAborted] = useState<AbortResult | null>(null);

  // A ref, not state: the API client is built once, and re-rendering because a
  // credential arrived would be re-rendering for something invisible.
  const tokenRef = useRef<string | null>(null);

  const api = useMemo(
    () => createSessionApi({ baseUrl: apiBaseUrl(), token: () => tokenRef.current }),
    [],
  );

  /**
   * Re-read the session.
   *
   * A dead credential is dropped from storage: leaving it would make every
   * later reload repeat a request that cannot succeed, and the customer needs a
   * fresh link either way.
   */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSession(await api.getSession(sessionId));
      // Recorded on every successful read, including the automatic ones after a
      // mutation. It is the only thing on the status screen that is guaranteed
      // to change when nothing else did — see `manualRefresh`.
      setLastCheckedAt(new Date());
      setError(null);
    } catch (thrown) {
      if (thrown instanceof ApiError && (thrown.status === 401 || thrown.status === 404)) {
        clearToken(sessionId, browserTokenHost());
        tokenRef.current = null;
      }
      setError(toCustomerMessage(thrown));
    } finally {
      setLoading(false);
    }
  }, [api, sessionId]);

  /**
   * The status screen's own refresh.
   *
   * Separate from `refresh` because it needs to be *visible*. A re-read that
   * returns the same session renders identically, so without its own pending
   * state and a timestamp that moves, pressing the button looks like pressing a
   * dead control — which is exactly how it was first reported.
   *
   * Separate from `submit` because this is a read: it must not take the `busy`
   * lock that guards mutations, and it has nothing to roll back.
   */
  const manualRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh, refreshing]);

  useEffect(() => {
    // Reads the fragment, stores the token, and strips the fragment from the
    // address bar — all before the first request goes out.
    const consumed = consumeToken(sessionId, browserTokenHost());
    tokenRef.current = consumed;

    if (consumed === null) {
      setTokenMissing(true);
      setLoading(false);
      return;
    }
    void refresh();
  }, [sessionId, refresh]);

  /** Run one mutation, then re-read. `busy` disables every action meanwhile. */
  const submit = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (thrown) {
        setError(toCustomerMessage(thrown));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  const onConsent = (accepted: boolean): void => {
    void submit(async () => {
      const result = await api.submitConsent(sessionId, {
        accepted,
        consent_version: CONSENT_VERSION,
      });
      // Presentation only. The server keeps the session `CREATED` with
      // `consent_ok = false`; there is no "consent refused" status to invent.
      if (!result.consent_ok) setConsentRejected(true);
    });
  };

  const onPreflight = (values: PreflightRequest): void => {
    void submit(async () => {
      const result = await api.submitPreflight(sessionId, values);
      // The server decided. This only remembers the reasons long enough to
      // show them; the status it set is what routes the screen.
      if (!result.preflight_ok) setFailedChecks(result.failed_checks ?? []);
    });
  };

  const onLocation = (body: LocationRequest): void => {
    void submit(async () => {
      const result = await api.submitLocation(sessionId, body);
      if (!result.geo_ok) setFailedChecks(result.failed_checks ?? []);
    });
  };

  const onAbort = (): void => {
    void submit(async () => {
      setAborted(await api.abortSession(sessionId));
    });
  };

  if (tokenMissing) {
    return (
      <section className="card">
        <h1>This link is incomplete</h1>
        <p>
          The verification link is missing the part that identifies you, or it has already been used
          in another tab.
        </p>
        <p className="muted">Please start again from your bank or provider.</p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="card" aria-busy="true">
        <h1>Loading your verification…</h1>
        <p className="muted">Checking where you left off.</p>
      </section>
    );
  }

  if (session === null) {
    return (
      <section className="card">
        <h1>We could not load your verification</h1>
        {error === null ? null : <ErrorNotice message={error} />}
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const screen = screenFor(session);

  return (
    <>
      {screen === Screen.CONSENT ? (
        <Consent busy={busy} rejected={consentRejected} onDecide={onConsent} />
      ) : null}

      {screen === Screen.PREFLIGHT ? <Preflight busy={busy} onSubmit={onPreflight} /> : null}

      {screen === Screen.LOCATION ? <LocationStep busy={busy} onSubmit={onLocation} /> : null}

      {screen === Screen.CHECKS_FAILED ? <ChecksFailed failedChecks={failedChecks} /> : null}

      {screen === Screen.READY_FOR_QUEUE || screen === Screen.SESSION_STATE ? (
        <Status
          session={session}
          busy={busy}
          refreshing={refreshing}
          lastCheckedAt={lastCheckedAt}
          aborted={aborted}
          onAbort={onAbort}
          onRefresh={() => {
            void manualRefresh();
          }}
        />
      ) : null}

      {error === null ? null : <ErrorNotice message={error} />}
    </>
  );
}
