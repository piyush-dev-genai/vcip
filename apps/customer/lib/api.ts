/**
 * The Control API client.
 *
 * One place that knows how to talk to the API, so no component holds a raw
 * `fetch`. That concentration is what makes four rules enforceable instead of
 * conventional:
 *
 *   - **The token is a header, never a query parameter.** `buildUrl` takes no
 *     credential at all, so there is no code path that could put one in a URL.
 *   - **Requests are validated before they are sent**, against the same
 *     `@vcip/shared` schemas the Control API validates them with (T12). One
 *     schema, not two that drift.
 *   - **Failures arrive as `ApiError`/`NetworkError`**, never as a raw
 *     response, so a screen cannot accidentally render a server string.
 *   - **Nothing here logs.** Not the token, not the body, not the coordinates.
 *
 * `fetch` is injected so all of this is testable under plain Node.
 */

import { consentSchema, locationSchema, preflightSchema } from '@vcip/shared';
import type { ConsentRequest, LocationRequest, PreflightRequest } from '@vcip/shared';
import { ApiError, NetworkError } from './errors';
import type {
  AbortResult,
  ConsentResult,
  LocationResult,
  PreflightResult,
  SessionView,
} from './session';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionApiDeps {
  readonly baseUrl: string;
  /** Read at call time, not captured: the token is consumed after mount. */
  readonly token: () => string | null;
  readonly fetchImpl?: FetchLike;
  /** Injected so the idempotency header is assertable in a test. */
  readonly newIdempotencyKey?: () => string;
}

/**
 * The five customer operations.
 *
 * The three validating methods are `async` so that a schema rejection arrives
 * as a rejected promise rather than a synchronous throw. A method that
 * sometimes does one and sometimes the other is a method every caller has to
 * wrap twice.
 */
export interface SessionApi {
  getSession(sessionId: string): Promise<SessionView>;
  submitConsent(sessionId: string, body: ConsentRequest): Promise<ConsentResult>;
  submitPreflight(sessionId: string, body: PreflightRequest): Promise<PreflightResult>;
  submitLocation(sessionId: string, body: LocationRequest): Promise<LocationResult>;
  abortSession(sessionId: string): Promise<AbortResult>;
}

/** The success envelope: every 2xx body is `{ "data": ... }` (§5). */
interface Envelope<T> {
  readonly data?: T;
}

/** The failure envelope (§6). Fields are optional because a proxy or a crash
 *  can produce a non-envelope body, and this code must survive that. */
interface ErrorEnvelope {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly request_id?: unknown;
  };
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Build a request URL.
 *
 * Path segments are encoded. The session id is a UUID the server will re-check,
 * but encoding it here means a malformed value cannot alter the path shape.
 */
function buildUrl(baseUrl: string, sessionId: string, suffix = ''): string {
  return `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function defaultIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function createSessionApi(deps: SessionApiDeps): SessionApi {
  const doFetch: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const newKey = deps.newIdempotencyKey ?? defaultIdempotencyKey;

  /**
   * One idempotency key per session, for the lifetime of this client.
   *
   * A fresh key per call would be wrong: two keys are two operations as far as
   * T11 is concerned, so a double-click or a retry after a dropped connection
   * would race the terminal transition a second time instead of replaying the
   * first answer. Aborting a session is one intent, and it gets one key.
   */
  const abortKeys = new Map<string, string>();
  const abortKeyFor = (sessionId: string): string => {
    const existing = abortKeys.get(sessionId);
    if (existing !== undefined) return existing;
    const created = newKey();
    abortKeys.set(sessionId, created);
    return created;
  };

  async function request<T>(
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };

    const token = deps.token();
    // Absent rather than empty: sending `Bearer ` would produce a confusing 401
    // instead of the honest "we have no credential" the caller can act on.
    if (token !== null && token.length > 0) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey !== undefined) headers['Idempotency-Key'] = init.idempotencyKey;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      // Deliberately not re-thrown with the original message: a fetch failure
      // message can name the host and the URL, and this value reaches a screen.
      throw new NetworkError();
    }

    // A body may be absent or unparseable on either path; neither is a reason
    // to throw something other than the two error types callers expect.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const envelope = (parsed ?? {}) as ErrorEnvelope;
      throw new ApiError(
        response.status,
        asString(envelope.error?.code) ?? 'UNKNOWN',
        // Kept for diagnostics on the Error object; `toCustomerMessage` never
        // shows it, and no screen reads `.message` directly.
        asString(envelope.error?.message) ?? 'request failed',
        asString(envelope.error?.request_id),
      );
    }

    const envelope = (parsed ?? {}) as Envelope<T>;
    if (envelope.data === undefined) {
      throw new ApiError(response.status, 'UNKNOWN', 'response had no data envelope', null);
    }
    return envelope.data;
  }

  return {
    getSession(sessionId) {
      return request<SessionView>(buildUrl(deps.baseUrl, sessionId), { method: 'GET' });
    },

    async submitConsent(sessionId, body) {
      // Parsed, not merely typed: this is the same schema the server enforces,
      // so an impossible body fails here rather than as a 400 round trip.
      const valid = consentSchema.parse(body);
      return request<ConsentResult>(buildUrl(deps.baseUrl, sessionId, '/consent'), {
        method: 'POST',
        body: valid,
      });
    },

    async submitPreflight(sessionId, body) {
      // `strictObject` in `@vcip/shared` is doing real work here: if this app
      // ever added `preflight_ok` to the payload, the parse would reject it
      // before the request left the browser. D11 is not the client's to assert.
      const valid = preflightSchema.parse(body);
      return request<PreflightResult>(buildUrl(deps.baseUrl, sessionId, '/preflight'), {
        method: 'POST',
        body: valid,
      });
    },

    async submitLocation(sessionId, body) {
      const valid = locationSchema.parse(body);
      return request<LocationResult>(buildUrl(deps.baseUrl, sessionId, '/location'), {
        method: 'POST',
        body: valid,
      });
    },

    abortSession(sessionId) {
      // T11 requires the header on this route, and the key is stable per
      // session so a repeated press replays the first response (D13).
      return request<AbortResult>(buildUrl(deps.baseUrl, sessionId, '/abort'), {
        method: 'POST',
        idempotencyKey: abortKeyFor(sessionId),
      });
    },
  };
}
