/**
 * The API client.
 *
 * These assert the request that would go on the wire — method, URL, headers,
 * body — because that is where the rules live. "The token is never a query
 * parameter" and "the client never asserts `preflight_ok`" are both properties
 * of a request, and a test that only checked a return value would prove
 * neither.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PreflightRequest } from '@vcip/shared';
import { createSessionApi } from './api';
import { ApiError, NetworkError } from './errors';

const BASE = 'http://localhost:3001';
const SESSION = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'FAKE-TOKEN-VALUE';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** Records the request and returns a canned response. */
function recorder(response: { status?: number; body?: unknown } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body ?? { data: {} }), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { calls, fetchImpl };
}

const client = (
  fetchImpl: ReturnType<typeof recorder>['fetchImpl'],
  token: string | null = TOKEN,
) =>
  createSessionApi({
    baseUrl: BASE,
    token: () => token,
    fetchImpl,
    newIdempotencyKey: () => 'fixed-key-for-test',
  });

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  (init?.headers ?? {}) as Record<string, string>;

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

const MEASUREMENTS: PreflightRequest = {
  camera_width: 1280,
  camera_height: 720,
  microphone_level: 62.5,
  network_rtt_ms: 48,
  downlink_kbps: 4200,
  lighting_score: 71,
  stability_score: 88,
};

// ------------------------------------------------------------ credential

describe('the credential', () => {
  it('travels in the Authorization header', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { session_id: SESSION } } });
    await client(fetchImpl).getSession(SESSION);
    expect(headersOf(calls[0]?.init).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never appears in a URL, on any route', async () => {
    // The single most important assertion in this file. A token in a URL is a
    // token in an access log.
    const { calls, fetchImpl } = recorder({ body: { data: {} } });
    const api = client(fetchImpl);
    await api.getSession(SESSION);
    await api.submitConsent(SESSION, { accepted: true, consent_version: 'v1' });
    await api.submitPreflight(SESSION, MEASUREMENTS);
    await api.submitLocation(SESSION, {
      latitude: 28.6139,
      longitude: 77.209,
      accuracy_m: 25,
      captured_at: '2026-08-27T10:30:00.000Z',
    });
    await api.abortSession(SESSION);

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.url).not.toContain('token=');
      expect(call.url).not.toContain('?');
    }
  });

  it('sends no Authorization header at all when there is no token', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: {} } });
    await client(fetchImpl, null).getSession(SESSION);
    expect(headersOf(calls[0]?.init).Authorization).toBeUndefined();
  });

  it('reads the token at call time, not at construction', async () => {
    // The token is consumed from the fragment after the client is built.
    const { calls, fetchImpl } = recorder({ body: { data: {} } });
    let current: string | null = null;
    const api = createSessionApi({ baseUrl: BASE, token: () => current, fetchImpl });
    await api.getSession(SESSION);
    current = TOKEN;
    await api.getSession(SESSION);

    expect(headersOf(calls[0]?.init).Authorization).toBeUndefined();
    expect(headersOf(calls[1]?.init).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

// --------------------------------------------------------------- routes

describe('routes and payloads', () => {
  it('reads a session with GET', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { session_id: SESSION } } });
    const session = await client(fetchImpl).getSession(SESSION);
    expect(calls[0]?.url).toBe(`${BASE}/v1/sessions/${SESSION}`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(session.session_id).toBe(SESSION);
  });

  it('posts an accepted consent with its version', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { consent_ok: true } } });
    await client(fetchImpl).submitConsent(SESSION, { accepted: true, consent_version: 'v1' });
    expect(calls[0]?.url).toBe(`${BASE}/v1/sessions/${SESSION}/consent`);
    expect(bodyOf(calls[0]?.init)).toEqual({ accepted: true, consent_version: 'v1' });
  });

  it('posts a declined consent as accepted=false, not by omitting the call', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { consent_ok: false } } });
    await client(fetchImpl).submitConsent(SESSION, { accepted: false, consent_version: 'v1' });
    expect(bodyOf(calls[0]?.init)).toEqual({ accepted: false, consent_version: 'v1' });
  });

  it('posts all seven preflight measurements', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { preflight_ok: true } } });
    await client(fetchImpl).submitPreflight(SESSION, MEASUREMENTS);
    expect(bodyOf(calls[0]?.init)).toEqual(MEASUREMENTS);
  });

  it('never sends preflight_ok, and cannot be made to', async () => {
    // D11: the server decides. `preflightSchema` is a strict object, so an
    // extra key is rejected in the browser before a request is made at all.
    const { calls, fetchImpl } = recorder({ body: { data: {} } });
    const withVerdict = { ...MEASUREMENTS, preflight_ok: true } as unknown as PreflightRequest;
    await expect(client(fetchImpl).submitPreflight(SESSION, withVerdict)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('posts the four location fields, and no geo_ok', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { geo_ok: true } } });
    await client(fetchImpl).submitLocation(SESSION, {
      latitude: 28.6139,
      longitude: 77.209,
      accuracy_m: 25,
      captured_at: '2026-08-27T10:30:00.000Z',
    });
    const body = bodyOf(calls[0]?.init);
    expect(Object.keys(body).sort()).toEqual([
      'accuracy_m',
      'captured_at',
      'latitude',
      'longitude',
    ]);
    expect(body).not.toHaveProperty('geo_ok');
  });

  it('rejects a location payload asserting geo_ok before sending it', async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      client(fetchImpl).submitLocation(SESSION, {
        latitude: 1,
        longitude: 1,
        accuracy_m: 1,
        captured_at: '2026-08-27T10:30:00.000Z',
        geo_ok: true,
      } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------- idempotency

describe('abort', () => {
  it('sends an Idempotency-Key, as T11 requires on this route', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: { status: 'ABORTED' } } });
    await client(fetchImpl).abortSession(SESSION);
    expect(calls[0]?.url).toBe(`${BASE}/v1/sessions/${SESSION}/abort`);
    expect(headersOf(calls[0]?.init)['Idempotency-Key']).toBe('fixed-key-for-test');
  });

  it('reuses one key per session, so a repeated press replays rather than races', async () => {
    let issued = 0;
    const { calls, fetchImpl } = recorder({ body: { data: {} } });
    const api = createSessionApi({
      baseUrl: BASE,
      token: () => TOKEN,
      fetchImpl,
      newIdempotencyKey: () => `key-${String((issued += 1))}`,
    });
    await api.abortSession(SESSION);
    await api.abortSession(SESSION);
    expect(headersOf(calls[0]?.init)['Idempotency-Key']).toBe('key-1');
    expect(headersOf(calls[1]?.init)['Idempotency-Key']).toBe('key-1');
  });

  it('does not send an Idempotency-Key on routes that do not take one', async () => {
    const { calls, fetchImpl } = recorder({ body: { data: {} } });
    await client(fetchImpl).submitConsent(SESSION, { accepted: true, consent_version: 'v1' });
    expect(headersOf(calls[0]?.init)['Idempotency-Key']).toBeUndefined();
  });

  it('returns the server billing figures unchanged', async () => {
    // The customer app computes no amount and knows no rule (D: billing is
    // server-derived). It renders what it is given.
    const { fetchImpl } = recorder({
      body: {
        data: {
          session_id: SESSION,
          status: 'ABORTED',
          bill_category: 'FAILED',
          bill_amount_paise: 500,
        },
      },
    });
    const result = await client(fetchImpl).abortSession(SESSION);
    expect(result.bill_category).toBe('FAILED');
    expect(result.bill_amount_paise).toBe(500);
  });
});

// --------------------------------------------------------------- errors

describe('failures', () => {
  it('turns an error envelope into an ApiError carrying code and request id', async () => {
    const { fetchImpl } = recorder({
      status: 409,
      body: {
        error: {
          code: 'SESSION_INVALID_STATE',
          message: 'The session changed while this request was in flight.',
          request_id: 'req-123',
        },
      },
    });
    await expect(client(fetchImpl).abortSession(SESSION)).rejects.toMatchObject({
      status: 409,
      code: 'SESSION_INVALID_STATE',
      requestId: 'req-123',
    });
  });

  it('survives a failure body that is not the envelope', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('<html>gateway</html>', { status: 502 })),
    );
    const thrown = await client(fetchImpl)
      .getSession(SESSION)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(502);
    expect((thrown as ApiError).code).toBe('UNKNOWN');
  });

  it('reports a transport failure as NetworkError, without the underlying message', async () => {
    // A fetch failure message can name the host and the URL, and this value
    // is one hop from a screen.
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('failed to fetch http://internal')));
    const thrown = await client(fetchImpl)
      .getSession(SESSION)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NetworkError);
    expect((thrown as Error).message).not.toContain('internal');
  });

  it('treats a 2xx without a data envelope as a failure', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ oops: true }), { status: 200 })),
    );
    await expect(client(fetchImpl).getSession(SESSION)).rejects.toBeInstanceOf(ApiError);
  });
});
