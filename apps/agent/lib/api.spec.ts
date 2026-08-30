import { describe, expect, it } from 'vitest';
import { createAgentApi } from './api';
import { ApiError, NetworkError } from './errors';

/**
 * The API client under plain Node, with `fetch` injected.
 *
 * The negative assertions carry the weight: no credential in a URL, no agent id
 * in a body, no `BUSY` leaving the browser, no field on a heartbeat.
 */

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const BASE = 'http://localhost:3001';
const TOKEN = 'FAKE.AGENT.TOKEN';

function harness(responder: (call: Call) => Response | Promise<Response>, token = TOKEN) {
  const calls: Call[] = [];
  const api = createAgentApi({
    baseUrl: BASE,
    token: () => token,
    fetchImpl: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return Promise.resolve(responder(call));
    },
  });
  return { api, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ok = (data: unknown): Response => json(200, { data });

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;

const headersOf = (call: Call | undefined): Record<string, string> =>
  (call?.init?.headers ?? {}) as Record<string, string>;

const LOGIN = {
  tenant_slug: 'demo-bank',
  email: 'agent.one@demo.local',
  password: 'FAKE-PASSWORD-FOR-TESTS',
};

describe('login', () => {
  it('posts the credentials to the documented route', async () => {
    const { api, calls } = harness(() =>
      ok({ access_token: 'FAKE.NEW.TOKEN', token_type: 'Bearer', expires_at: 'later' }),
    );

    const result = await api.login(LOGIN);

    expect(calls[0]?.url).toBe('http://localhost:3001/v1/agent/login');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(result.access_token).toBe('FAKE.NEW.TOKEN');
  });

  it('sends no Authorization header', async () => {
    // Login is the route that mints a credential; presenting a stale one would
    // be meaningless and would put a dead token on the wire for no reason.
    const { api, calls } = harness(() =>
      ok({ access_token: 'x', token_type: 'Bearer', expires_at: 'later' }),
    );
    await api.login(LOGIN);
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it('never puts a credential in the URL', async () => {
    const { api, calls } = harness(() =>
      ok({ access_token: 'x', token_type: 'Bearer', expires_at: 'later' }),
    );
    await api.login(LOGIN);

    expect(calls[0]?.url).not.toContain(LOGIN.password);
    expect(calls[0]?.url).not.toContain('token');
    expect(calls[0]?.url).not.toContain('?');
    expect(calls[0]?.url).not.toContain('#');
  });

  it('normalises the email through the shared schema before sending', async () => {
    const { api, calls } = harness(() =>
      ok({ access_token: 'x', token_type: 'Bearer', expires_at: 'later' }),
    );
    await api.login({ ...LOGIN, email: '  Agent.One@Demo.Local ' });

    // The same transform the server applies, so the two cannot disagree about
    // which row the credentials name.
    expect(bodyOf(calls[0]).email).toBe('agent.one@demo.local');
  });

  it('rejects a malformed login before it leaves the browser', async () => {
    const { api, calls } = harness(() => ok({}));

    await expect(api.login({ ...LOGIN, email: 'not-an-email' })).rejects.toThrow();
    await expect(api.login({ ...LOGIN, password: 'short' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('availability', () => {
  it('sends only the status', async () => {
    const { api, calls } = harness(() => ok({ agent_id: 'a1', status: 'AVAILABLE' }));

    await api.setAvailability({ status: 'AVAILABLE' });

    expect(calls[0]?.url).toBe('http://localhost:3001/v1/agent/availability');
    expect(bodyOf(calls[0])).toEqual({ status: 'AVAILABLE' });
  });

  it('sends the bearer token as a header', async () => {
    const { api, calls } = harness(() => ok({ agent_id: 'a1', status: 'AVAILABLE' }));
    await api.setAvailability({ status: 'UNAVAILABLE' });
    expect(headersOf(calls[0]).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('omits the header entirely when there is no token', async () => {
    const { api, calls } = harness(() => ok({ agent_id: 'a1', status: 'AVAILABLE' }), '');
    await api.setAvailability({ status: 'AVAILABLE' });
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it('refuses to send BUSY', async () => {
    const { api, calls } = harness(() => ok({}));

    // R5, enforced on this side too: the request never leaves the browser.
    await expect(
      api.setAvailability({ status: 'BUSY' } as unknown as { status: 'AVAILABLE' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses to send an agent id, tenant id, or language list', async () => {
    const { api, calls } = harness(() => ok({}));

    for (const extra of [{ agent_id: 'a2' }, { tenant_id: 't2' }, { languages: ['fr'] }]) {
      await expect(
        api.setAvailability({ status: 'AVAILABLE', ...extra } as never),
      ).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
});

describe('heartbeat', () => {
  it('posts an empty body to the documented route', async () => {
    const { api, calls } = harness(() =>
      ok({ agent_id: 'a1', status: 'AVAILABLE', last_seen: '2026-08-31T09:00:00.000Z' }),
    );

    const result = await api.heartbeat();

    expect(calls[0]?.url).toBe('http://localhost:3001/v1/agent/heartbeat');
    expect(bodyOf(calls[0])).toEqual({});
    expect(result.status).toBe('AVAILABLE');
  });

  it('reports a not-live presence without inventing one', async () => {
    const { api } = harness(() => ok({ agent_id: 'a1', status: 'UNAVAILABLE', last_seen: null }));
    const result = await api.heartbeat();

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.last_seen).toBeNull();
  });

  it('reports BUSY as the server sent it', async () => {
    const { api } = harness(() => ok({ agent_id: 'a1', status: 'BUSY', last_seen: 'now' }));
    expect((await api.heartbeat()).status).toBe('BUSY');
  });
});

describe('failures', () => {
  it('turns an error envelope into an ApiError', async () => {
    const { api } = harness(() =>
      json(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials.', request_id: 'req-1' },
      }),
    );

    await expect(api.login(LOGIN)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      requestId: 'req-1',
    });
  });

  it('survives a non-envelope error body', async () => {
    const { api } = harness(() => new Response('<html>502</html>', { status: 502 }));
    const error = await api.heartbeat().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNKNOWN');
  });

  it('turns a transport failure into a NetworkError that names no host', async () => {
    const api = createAgentApi({
      baseUrl: BASE,
      token: () => TOKEN,
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.internal.example')),
    });

    const error = await api.heartbeat().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).not.toContain('api.internal.example');
  });

  it('rejects a 200 with no data envelope', async () => {
    const { api } = harness(() => json(200, { status: 'AVAILABLE' }));
    await expect(api.heartbeat()).rejects.toBeInstanceOf(ApiError);
  });
});
