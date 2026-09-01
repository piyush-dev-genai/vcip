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
  agentAcceptSchema,
  agentAvailabilitySchema,
  agentClaimSchema,
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

/** One row of `GET /v1/agent/queue`. Exactly the five fields §16 defines. */
export interface QueuedSession {
  readonly session_id: string;
  readonly language: string;
  readonly priority: number;
  readonly queued_at: string;
  readonly wait_seconds: number;
}

/** `GET /v1/agent/queue`. */
export interface QueueResult {
  readonly sessions: readonly QueuedSession[];
}

/** `POST /v1/agent/sessions/{id}/claim`. Exactly the four fields §17.1 defines. */
export interface ClaimResult {
  readonly session_id: string;
  readonly status: string;
  readonly offered_to_agent_id: string;
  readonly offer_expires_at: string;
}

/** `POST /v1/agent/sessions/{id}/accept`. Exactly the four fields §17.2 defines. */
export interface AcceptResult {
  readonly session_id: string;
  readonly status: string;
  readonly agent_id: string;
  readonly room_name: string | null;
}

/**
 * The subset of `GET /v1/sessions/{id}` the portal reads.
 *
 * Narrow on purpose. The endpoint returns more — consent, geo, verdict, export
 * state — and none of it belongs on a Day 2 screen. Declaring only what is
 * rendered keeps a future field from arriving in a component by accident.
 */
export interface SessionState {
  readonly session_id: string;
  readonly status: string;
  readonly room_name: string | null;
}

/**
 * `GET /v1/agent/sessions/{id}/media-token` (contract §13).
 *
 * Exactly the three documented fields. Where the SFU lives is not among them
 * and is not expected to be — that is `livekitUrl()` in `lib/config.ts`.
 */
export interface MediaTokenResult {
  readonly room_name: string;
  readonly token: string;
  readonly expires_at: string;
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
  /**
   * The queued sessions this agent could work.
   *
   * Takes no arguments, and that is the contract: the tenant, the agent, the
   * languages, and the bound are all the server's. There is no parameter here
   * through which a portal could widen what it sees.
   */
  queue(): Promise<QueueResult>;

  /**
   * Claim one queued session.
   *
   * The session id is the only thing the caller chooses. There is no agent id
   * and no tenant id in this signature, and the body is empty — the server
   * takes both from the JWT.
   *
   * `idempotencyKey` is a parameter rather than something minted here, because
   * a retry has to present the *same* key and only the caller knows whether
   * this is a retry. `lib/work.ts` is what remembers.
   */
  claim(sessionId: string, idempotencyKey: string): Promise<ClaimResult>;

  /** Take up the offer this agent holds. Same rules as `claim`. */
  accept(sessionId: string, idempotencyKey: string): Promise<AcceptResult>;

  /**
   * Read one session's current state.
   *
   * The recovery path after a reload, and the authority for every screen: the
   * portal renders what this returns rather than what it last believed.
   */
  session(sessionId: string): Promise<SessionState>;

  /**
   * Credentials for the session's LiveKit room (T24, contract §13).
   *
   * The agent path, `/v1/agent/sessions/{id}/media-token`. R1 records that the
   * customer path serves an agent JWT too and delegates to the same handler;
   * this app uses the one under `/v1/agent` because that is the route named
   * for this caller, and the answer is identical either way.
   *
   * A read: it mints a token but writes nothing, so it carries no idempotency
   * key and a repeat costs nothing. There is no role, room, or identity in the
   * signature — the server takes all three from the JWT, and issues a token
   * only when this agent is the one `sessions.agent_id` names.
   */
  mediaToken(sessionId: string): Promise<MediaTokenResult>;
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

/**
 * The session routes live outside `/v1/agent`.
 *
 * The id is encoded rather than interpolated raw. It comes from a queue row or
 * from storage, both of which should only ever hold a UUID — encoding it means
 * that if either is ever wrong, the result is a 400 from the server and not a
 * request to a path this function invented.
 */
const sessionUrl = (baseUrl: string, sessionId: string, suffix = ''): string =>
  `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;

const agentSessionUrl = (baseUrl: string, sessionId: string, suffix: string): string =>
  `${baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}${suffix}`;

export function createAgentApi(deps: AgentApiDeps): AgentApi {
  const doFetch: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request<T>(
    url: string,
    init: {
      method?: 'GET' | 'POST';
      body?: unknown;
      authenticated: boolean;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    const method = init.method ?? 'POST';
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Only where the route requires one (D13). Sending it everywhere would
    // make it look like a transport concern rather than a property of the six
    // operations that must happen at most once.
    if (init.idempotencyKey !== undefined) headers['Idempotency-Key'] = init.idempotencyKey;
    // A GET has no body, so it declares no content type. Sending one would add
    // nothing and would make the preflight ask for a header it does not need.
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    if (init.authenticated) {
      const token = deps.token();
      // Absent rather than empty: sending `Bearer ` would produce a confusing
      // 401 instead of the honest "we have no credential" the caller can act on.
      if (token !== null && token.length > 0) headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
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

    async queue() {
      // No schema to parse: the request has no body and no query string, so
      // there is nothing a client could get wrong and nothing to validate.
      return request<QueueResult>(buildUrl(deps.baseUrl, '/queue'), {
        method: 'GET',
        authenticated: true,
      });
    },

    async claim(sessionId, idempotencyKey) {
      // An empty strict object, parsed for the reason the heartbeat is: it
      // makes "a claim carries no agent id, no tenant id, and no session id in
      // its body" a property of this code rather than of the current call site.
      // A portal that tried to smuggle any of them would fail here, before the
      // request left the browser.
      const valid = agentClaimSchema.parse({});
      return request<ClaimResult>(agentSessionUrl(deps.baseUrl, sessionId, '/claim'), {
        body: valid,
        authenticated: true,
        idempotencyKey,
      });
    },

    async accept(sessionId, idempotencyKey) {
      const valid = agentAcceptSchema.parse({});
      return request<AcceptResult>(agentSessionUrl(deps.baseUrl, sessionId, '/accept'), {
        body: valid,
        authenticated: true,
        idempotencyKey,
      });
    },

    async session(sessionId) {
      return request<SessionState>(sessionUrl(deps.baseUrl, sessionId), {
        method: 'GET',
        authenticated: true,
      });
    },

    async mediaToken(sessionId) {
      return request<MediaTokenResult>(agentSessionUrl(deps.baseUrl, sessionId, '/media-token'), {
        method: 'GET',
        authenticated: true,
      });
    },
  };
}
