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

describe('queue', () => {
  const QUEUED = {
    session_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    language: 'en',
    priority: 0,
    queued_at: '2026-08-31T10:00:00.000Z',
    wait_seconds: 32,
  };

  it('reads the documented route with a GET', async () => {
    const { api, calls } = harness(() => ok({ sessions: [QUEUED] }));

    const result = await api.queue();

    expect(calls[0]?.url).toBe(`${BASE}/v1/agent/queue`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(result.sessions).toEqual([QUEUED]);
  });

  it('sends no body and no content type', async () => {
    const { api, calls } = harness(() => ok({ sessions: [] }));

    await api.queue();

    expect(calls[0]?.init?.body).toBeUndefined();
    expect(headersOf(calls[0])['Content-Type']).toBeUndefined();
  });

  it('sends the bearer token as a header', async () => {
    const { api, calls } = harness(() => ok({ sessions: [] }));

    await api.queue();

    expect(headersOf(calls[0]).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never puts the token or any filter in the URL', async () => {
    const { api, calls } = harness(() => ok({ sessions: [] }));

    await api.queue();

    const url = calls[0]?.url ?? '';
    expect(url).not.toContain('?');
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain('tenant');
    expect(url).not.toContain('agent_id');
    expect(url).not.toContain('limit');
  });

  it('takes no argument through which a caller could widen the result', () => {
    const { api } = harness(() => ok({ sessions: [] }));

    expect(api.queue).toHaveLength(0);
  });

  it('returns an empty list without inventing sessions', async () => {
    const { api } = harness(() => ok({ sessions: [] }));

    expect((await api.queue()).sessions).toEqual([]);
  });

  it('reports a 401 as a re-authentication error rather than an empty queue', async () => {
    const { api } = harness(() =>
      json(401, { error: { code: 'UNAUTHENTICATED', message: 'no', request_id: 'r-1' } }),
    );

    await expect(api.queue()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('reports a 403 rather than an empty queue', async () => {
    const { api } = harness(() =>
      json(403, { error: { code: 'FORBIDDEN', message: 'no', request_id: 'r-2' } }),
    );

    await expect(api.queue()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

// ------------------------------------------------------------------ claim

const CLAIMED = {
  session_id: '11111111-2222-4333-8444-555555555555',
  status: 'OFFERED',
  offered_to_agent_id: 'agent-1',
  offer_expires_at: '2026-09-01T10:00:30.000Z',
};

const SESSION = CLAIMED.session_id;

describe('claim', () => {
  it('posts to the session claim route', async () => {
    const { api, calls } = harness(() => ok(CLAIMED));
    await api.claim(SESSION, 'key-1');

    expect(calls[0]?.url).toBe(`${BASE}/v1/agent/sessions/${SESSION}/claim`);
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('sends the idempotency key it was given', async () => {
    const { api, calls } = harness(() => ok(CLAIMED));
    await api.claim(SESSION, 'key-1');

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-1');
  });

  it('sends the same key again for a retry', async () => {
    // The client does not mint keys, so a retry with the same key is a retry.
    const { api, calls } = harness(() => ok(CLAIMED));
    await api.claim(SESSION, 'key-1');
    await api.claim(SESSION, 'key-1');

    const first = calls[0]?.init?.headers as Record<string, string>;
    const second = calls[1]?.init?.headers as Record<string, string>;
    expect(second['Idempotency-Key']).toBe(first['Idempotency-Key']);
  });

  it('sends an empty body, whatever the caller had in mind', async () => {
    const { api, calls } = harness(() => ok(CLAIMED));
    await api.claim(SESSION, 'key-1');

    // The whole payload. No agent id, no tenant id, no session id, no status:
    // the server reads the first two from the JWT and the third from the path.
    expect(calls[0]?.init?.body).toBe('{}');
  });

  it('carries the credential as a header', async () => {
    const { api, calls } = harness(() => ok(CLAIMED));
    await api.claim(SESSION, 'key-1');

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it('encodes the session id into the path', async () => {
    const { api, calls } = harness(() => ok(CLAIMED));
    await api.claim('../../etc/passwd', 'key-1');

    // A stale or tampered id becomes a 400 from the server, never a request to
    // a path this client invented.
    expect(calls[0]?.url).toBe(`${BASE}/v1/agent/sessions/..%2F..%2Fetc%2Fpasswd/claim`);
  });

  it('surfaces a lost race as an ApiError with the server code', async () => {
    const { api } = harness(() =>
      json(409, { error: { code: 'SESSION_ALREADY_ASSIGNED', message: 'taken' } }),
    );

    await expect(api.claim(SESSION, 'key-1')).rejects.toBeInstanceOf(ApiError);
  });
});

// ----------------------------------------------------------------- accept

const ACCEPTED = {
  session_id: SESSION,
  status: 'IN_CALL',
  agent_id: 'agent-1',
  room_name: `vcip_${SESSION}`,
};

describe('accept', () => {
  it('posts to the session accept route with its key', async () => {
    const { api, calls } = harness(() => ok(ACCEPTED));
    await api.accept(SESSION, 'key-2');

    expect(calls[0]?.url).toBe(`${BASE}/v1/agent/sessions/${SESSION}/accept`);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-2');
  });

  it('sends an empty body', async () => {
    const { api, calls } = harness(() => ok(ACCEPTED));
    await api.accept(SESSION, 'key-2');
    expect(calls[0]?.init?.body).toBe('{}');
  });

  it('returns the room name the server assigned', async () => {
    const { api } = harness(() => ok(ACCEPTED));
    await expect(api.accept(SESSION, 'key-2')).resolves.toMatchObject({
      room_name: `vcip_${SESSION}`,
    });
  });
});

// ---------------------------------------------------------------- session

describe('session', () => {
  it('reads the session with a GET and no body', async () => {
    const { api, calls } = harness(() =>
      ok({ session_id: SESSION, status: 'OFFERED', room_name: null }),
    );
    await api.session(SESSION);

    expect(calls[0]?.url).toBe(`${BASE}/v1/sessions/${SESSION}`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('sends no idempotency key on a read', async () => {
    const { api, calls } = harness(() =>
      ok({ session_id: SESSION, status: 'IN_CALL', room_name: null }),
    );
    await api.session(SESSION);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('returns the status the server reported', async () => {
    const { api } = harness(() => ok({ session_id: SESSION, status: 'QUEUED', room_name: null }));
    await expect(api.session(SESSION)).resolves.toMatchObject({ status: 'QUEUED' });
  });
});

// --------------------------------------------- the agent cannot name itself

describe('no request names an agent, a tenant, or a status', () => {
  it('sends nothing but a credential and a key on every action', async () => {
    const { api, calls } = harness((call) =>
      call.url.endsWith('/claim') ? ok(CLAIMED) : ok(ACCEPTED),
    );
    await api.claim(SESSION, 'key-1');
    await api.accept(SESSION, 'key-2');

    for (const call of calls) {
      const body = String(call.init?.body ?? '{}');
      for (const field of ['agent_id', 'tenant_id', 'session_id', 'status', 'room_name']) {
        expect(body).not.toContain(field);
      }
      expect(call.url).not.toContain('agent_id');
      expect(call.url).not.toContain('tenant_id');
    }
  });
});
