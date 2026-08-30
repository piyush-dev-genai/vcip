'use client';

import { useState } from 'react';

/**
 * The development landing page.
 *
 * In production a customer never sees this: the enterprise backend creates the
 * session and sends them a link. There is no enterprise backend here, so this
 * page calls the D14 stand-in — a server-side route handler that holds the
 * enterprise API key — and follows the link it returns.
 *
 * The token comes back in the response body and is put into the URL fragment by
 * `location.assign` in the browser. It is never a query parameter and never a
 * `Location` header, so it reaches no server log on its way to the next page.
 */
export default function Page() {
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function start(): Promise<void> {
    setStarting(true);
    setProblem(null);
    try {
      const response = await fetch('/api/demo/session', { method: 'POST' });
      const body = (await response.json()) as {
        data?: { url?: string };
        error?: { message?: string };
      };

      if (!response.ok || typeof body.data?.url !== 'string') {
        setProblem(body.error?.message ?? 'The demo session could not be created.');
        setStarting(false);
        return;
      }
      // Assign, not push: the fragment must not become a history entry that
      // Back can return the token to.
      window.location.assign(body.data.url);
    } catch {
      setProblem('The customer application could not reach its own server.');
      setStarting(false);
    }
  }

  return (
    <main className="shell">
      <section className="card">
        <p className="step">Development</p>
        <h1>V-CIP Verification</h1>
        <p>
          A customer normally arrives here from a link sent by their bank or provider. This page
          stands in for that step during development.
        </p>
        <p className="muted">
          Starting a session calls the Control API with the enterprise API key from the server
          environment. The key stays on the server; only a short-lived, session-scoped customer
          token reaches this browser (D14).
        </p>

        {problem === null ? null : (
          <div className="notice bad" role="alert">
            <h3>Could not start a session</h3>
            <p className="muted">{problem}</p>
          </div>
        )}

        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={starting}
            onClick={() => {
              void start();
            }}
          >
            {starting ? 'Starting…' : 'Start a demo verification'}
          </button>
        </div>
      </section>
    </main>
  );
}
