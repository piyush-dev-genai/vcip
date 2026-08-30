/**
 * The D14 session bootstrap.
 *
 * `POST /v1/sessions` requires the enterprise API key, and the enterprise
 * backend is what normally calls it. There is no enterprise backend in this
 * repository, so D14 names the stand-in explicitly:
 *
 *   > For the demo, a server-side route handler stands in for the enterprise
 *   > backend; the key stays on the server.
 *
 * This is that route handler, and "stays on the server" is the whole of its
 * design. The key is read from `process.env` inside a Node route handler, which
 * Next never ships to the browser; it is not `NEXT_PUBLIC_`; it is not returned,
 * echoed, or logged; and the only thing that crosses back to the browser is the
 * short-lived, session-scoped customer token the Control API minted.
 *
 * This is not a BFF. It creates a session and stops. Every subsequent request —
 * consent, preflight, location, status, abort — goes from the browser straight
 * to the Control API with the customer token, which is why T14 configures CORS
 * rather than proxying.
 *
 * The token is returned in the response **body**, and the browser puts it in a
 * URL fragment. Not a redirect: a `Location` header carrying a credential is a
 * credential in a response header, which is exactly the class of place tokens
 * get logged.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface CreateSessionData {
  readonly session_id?: unknown;
  readonly customer_token?: unknown;
}

const DEFAULT_API_BASE_URL = 'http://localhost:3001';

/** A refusal that names the missing configuration, never a value. */
const misconfigured = (message: string): NextResponse =>
  NextResponse.json({ error: { code: 'DEMO_BOOTSTRAP_UNAVAILABLE', message } }, { status: 503 });

export async function POST(): Promise<NextResponse> {
  // The demo bootstrap holds an enterprise credential. Outside development it
  // stays off unless someone turns it on deliberately — the same posture the
  // seed script takes with VCIP_SEED_FORCE.
  if (process.env.NODE_ENV === 'production' && process.env.VCIP_DEMO_BOOTSTRAP !== 'yes') {
    return misconfigured('The demo session bootstrap is disabled outside development.');
  }

  const apiKey = process.env.VCIP_DEMO_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return misconfigured(
      'VCIP_DEMO_API_KEY is not set. Run the database seed to issue a development API key.',
    );
  }

  const baseUrl = (process.env.VCIP_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Required by T11 on this route. A fresh key per bootstrap: each demo
        // click is a new session, not a retry of the previous one.
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        external_ref: `demo-${crypto.randomUUID()}`,
        language: 'en',
      }),
      cache: 'no-store',
    });
  } catch {
    return misconfigured('The Control API is not reachable. Start it and try again.');
  }

  if (!response.ok) {
    // The upstream body may quote our own request. Report the status and
    // nothing else rather than forwarding a payload that could contain the key.
    return NextResponse.json(
      {
        error: {
          code: 'DEMO_BOOTSTRAP_FAILED',
          message: `The Control API refused to create a session (HTTP ${String(response.status)}).`,
        },
      },
      { status: 502 },
    );
  }

  const body = (await response.json()) as { data?: CreateSessionData };
  const sessionId = body.data?.session_id;
  const customerToken = body.data?.customer_token;

  if (typeof sessionId !== 'string' || typeof customerToken !== 'string') {
    return misconfigured('The Control API returned an unexpected session payload.');
  }

  return NextResponse.json(
    {
      data: {
        session_id: sessionId,
        // The fragment is assembled here but travels in a body, and the browser
        // is what puts it in the address bar. Nothing between here and there
        // sees it as part of a URL.
        url: `/session/${encodeURIComponent(sessionId)}#token=${encodeURIComponent(customerToken)}`,
      },
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
