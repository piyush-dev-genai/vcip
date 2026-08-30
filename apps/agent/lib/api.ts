/**
 * The Control API client for the agent portal.
 *
 * One place that knows how to talk to the API, so no component holds a raw
 * `fetch`. That concentration is what makes these rules enforceable rather than
 * conventional:
 *
 *   - **The token is a header, never a query parameter.** `buildUrl` takes no
 *     credential at all, so there is no code path that could put one in a URL.
 *   - **Requests are validated before they are sent**, against the same
 *     `@vcip/shared` schemas the Control API validates them with. In particular
 *     `agentAvailabilitySchema` has no `BUSY`, so a portal that tried to send
 *     it would fail here rather than at the server — and `agentHeartbeatSchema`
 *     is an empty strict object, so the heartbeat provably carries nothing.
 *   - **The agent never names itself.** No method takes an agent id. The server
 *     reads it from the JWT, and there is no parameter here through which a
 *     client could suggest otherwise.
 *   - **Failures arrive as `ApiError`/`NetworkError`**, never as a raw
 *     response, so a screen cannot accidentally render a server string.
 *   - **Nothing here logs.** Not the token, not the password, not the body.
 *
 * `fetch` is injected so all of this is testable under plain Node.
 */

import {
  agentAvailabilitySchema,
  agentHeartbeatSchema,
  agentLoginSchema,
  type AgentAvailabilityRequest,
  type AgentLoginRequest,
} from '@vcip/shared';
import { ApiError, NetworkError } from './errors';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentApiDeps {
  readonly baseUrl: string;
  /** Read at call time, not captured: the token arrives after login. */
  readonly token: () => string | null;
  readonly fetchImpl?: FetchLike;
}

/** `POST /v1/agent/login`. */
export interface LoginResult {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_at: string;
}

/** `POST /v1/agent/availability`. */
export interface AvailabilityResult {
  readonly agent_id: string;
  readonly status: 'AVAILABLE' | 'UNAVAILABLE' | 'BUSY';
}

/** `POST /v1/agent/heartbeat`. */
export interface HeartbeatResult {
  readonly agent_id: string;
  readonly status: 'AVAILABLE' | 'UNAVAILABLE' | 'BUSY';
  readonly last_seen: string | null;
}

export interface AgentApi {
  login(body: AgentLoginRequest): Promise<LoginResult>;
  setAvailability(body: AgentAvailabilityRequest): Promise<AvailabilityResult>;
  heartbeat(): Promise<HeartbeatResult>;
}

/** The success envelope: every 2xx body is `{ "data": ... }`. */
interface Envelope<T> {
  readonly data?: T;
}

/** The failure envelope. Fields are optional because a proxy or a crash can
 *  produce a non-envelope body, and this code must survive that. */
interface ErrorEnvelope {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly request_id?: unknown;
  };
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const buildUrl = (baseUrl: string, suffix: string): string => `${baseUrl}/v1/agent${suffix}`;

export function createAgentApi(deps: AgentApiDeps): AgentApi {
  const doFetch: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request<T>(
    url: string,
    init: { body: unknown; authenticated: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    if (init.authenticated) {
      const token = deps.token();
      // Absent rather than empty: sending `Bearer ` would produce a confusing
      // 401 instead of the honest "we have no credential" the caller can act on.
      if (token !== null && token.length > 0) headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(init.body),
      });
    } catch {
      // Deliberately not re-thrown with the original message: a fetch failure
      // message can name the host and the URL, and this value reaches a screen.
      throw new NetworkError();
    }

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
        // Kept for diagnostics on the Error object; the message tables never
        // show it, and no screen reads `.message` directly.
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
    async login(body) {
      // Parsed, not merely typed: the same schema the server enforces, so an
      // impossible body fails here rather than as a 400 round trip. The parsed
      // value is what is sent, so the email normalisation applies on this side
      // too and the two cannot disagree.
      const valid = agentLoginSchema.parse(body);
      return request<LoginResult>(buildUrl(deps.baseUrl, '/login'), {
        body: valid,
        authenticated: false,
      });
    },

    async setAvailability(body) {
      // `agentAvailabilitySchema` accepts AVAILABLE and UNAVAILABLE only. A
      // portal that tried to send BUSY would be stopped here, before the
      // request left the browser.
      const valid = agentAvailabilitySchema.parse(body);
      return request<AvailabilityResult>(buildUrl(deps.baseUrl, '/availability'), {
        body: valid,
        authenticated: true,
      });
    },

    async heartbeat() {
      // An empty strict object. Parsing it is not ceremony: it is what makes
      // "the heartbeat carries nothing" a property of the code rather than of
      // the current call site.
      const valid = agentHeartbeatSchema.parse({});
      return request<HeartbeatResult>(buildUrl(deps.baseUrl, '/heartbeat'), {
        body: valid,
        authenticated: true,
      });
    },
  };
}
