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
 * The password input is never held anywhere but this component's state and is
 * cleared on a failed attempt. Nothing here logs, and the form is not
 * autofilled with anything.
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
    <section className="card">
      <p className="step">Agent portal</p>
      <h1>Sign in</h1>

      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Organisation</span>
          <input
            name="tenant_slug"
            value={tenantSlug}
            onChange={(event) => setTenantSlug(event.target.value)}
            autoComplete="organization"
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
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>

      {error === null ? null : (
        <div className="notice bad">
          <h3>{error.title}</h3>
          <p>{error.detail}</p>
          {error.requestId === null ? null : <p className="ref">Reference {error.requestId}</p>}
        </div>
      )}
    </section>
  );
}
