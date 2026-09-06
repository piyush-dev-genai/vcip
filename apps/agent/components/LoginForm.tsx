'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentMessage } from '../lib/errors';

/**
 * The sign-in screen.
 *
 * `tenant_slug` is a field because `users.email` is unique per tenant, not
 * globally — the organisation selects which user table to look in, and the
 * password still has to match. It is labelled in the agent's language
 * ("Organisation"), not the schema's.
 *
 * The credential is never held anywhere but this component's state and is
 * cleared on a failed attempt. Nothing here logs, and the form is not
 * autofilled with anything.
 *
 * **`method="post"` is a security control, not a formality.** Nothing in this
 * app ever submits the form natively — `submit` calls `preventDefault` and the
 * credential goes out as a JSON body from `lib/api.ts`. But a form with no
 * method defaults to GET, and a GET submit serialises every named input into
 * the URL. So the one time it mattered was the one time the handler was not
 * attached: a dev server serving a stale chunk manifest failed to hydrate, the
 * browser fell back to its own submit, and the agent's password landed in the
 * address bar — and from there in history, in the referrer, and in any access
 * log in front of the app.
 *
 * A native POST is harmless by comparison: the fields travel in a body that no
 * log records, this route has no POST handler to accept them, and nothing is
 * left behind. The rule generalises — a form that collects a secret declares
 * POST even when it never intends to submit itself, because the fallback is
 * exactly the case where intentions have stopped applying.
 *
 * It is its own full-height screen rather than a card on the portal page,
 * because it is the one moment the agent is not working: no chrome, no queue,
 * nothing behind it to read.
 */
export interface LoginFormProps {
  readonly onSubmit: (credentials: {
    tenantSlug: string;
    email: string;
    password: string;
  }) => Promise<void>;
  readonly busy: boolean;
  readonly error: AgentMessage | null;
}

export function LoginForm({ onSubmit, busy, error }: LoginFormProps) {
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    await onSubmit({ tenantSlug, email, password });
    // Cleared whatever the outcome: on success it is no longer needed, and on
    // failure it should not sit in the DOM waiting for the next person.
    setPassword('');
  };

  return (
    <main className="auth">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            VC
          </span>
          <span className="brand-name">
            V-CIP
            <small>Agent console</small>
          </span>
        </div>

        <h1>Sign in</h1>
        <p className="muted">Use the account your organisation issued you.</p>

        <form method="post" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Organisation</span>
            <input
              name="tenant_slug"
              value={tenantSlug}
              onChange={(event) => setTenantSlug(event.target.value)}
              autoComplete="organization"
              placeholder="acme-bank"
              required
            />
          </label>

          <label className="field">
            <span>Email</span>
            <input
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              placeholder="you@example.com"
              required
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </div>
        </form>

        {error === null ? null : (
          <div className="notice bad" role="alert">
            <h3>{error.title}</h3>
            <p>{error.detail}</p>
            {error.requestId === null ? null : <p className="ref">Reference {error.requestId}</p>}
          </div>
        )}

        <p className="auth-foot ref">
          Signing in does not put you in the pool. You choose when to go available.
        </p>
      </section>
    </main>
  );
}
