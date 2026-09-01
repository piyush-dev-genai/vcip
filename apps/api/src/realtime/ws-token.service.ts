/**
 * Minting WebSocket connection tokens (T27, D9).
 *
 * D9: a connection authenticates with a short-lived token in a query
 * parameter, because a browser cannot set `Authorization` on a WebSocket
 * handshake. The token is scoped to a tenant plus either a session (customer)
 * or a user (agent), and is minted by a REST endpoint the caller is already
 * authorised to use — which is the whole security argument. Nothing here grants
 * access the caller did not already have; it re-expresses an existing
 * credential in a form the handshake can carry.
 *
 * Every claim is taken from the verified actor. There is no field a caller can
 * supply that reaches the token, which is what makes "scope comes from the
 * credential" a property of the signature rather than of a later check.
 */

import { Injectable } from '@nestjs/common';
import { RealtimeAudience } from '@vcip/shared';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { InjectAuthConfig } from '../common/auth/auth.config.js';
import type { AgentActor, CustomerActor } from '../common/auth/auth-context.js';
import { signJwt } from '../common/auth/tokens.js';

/**
 * The `act` claim on a connection token.
 *
 * Distinct from the customer and agent actor claims, and verified against by
 * the gateway, so a session credential cannot be presented as a connection
 * token or the reverse — even before the separate signing secret is considered.
 */
export const WS_ACTOR_CLAIM = 'ws';

/**
 * `POST /v1/sessions/{id}/ws-token` and `POST /v1/agent/ws-token`.
 *
 * `expires_at` is returned so a client can refetch before the socket drops
 * rather than discovering the expiry as a failed handshake.
 */
export interface WsTokenResult {
  readonly token: string;
  readonly expires_at: string;
  /** Echoed so a client need not decode the token to know what it holds. */
  readonly audience: RealtimeAudience;
}

/** The clock, injected so expiry is assertable. */
export type WsTokenClock = () => Date;

@Injectable()
export class WsTokenService {
  constructor(@InjectAuthConfig() private readonly config: AuthConfig) {}

  /**
   * A customer's connection token: tenant plus exactly one session.
   *
   * The session id comes from the actor, not from the path. The route's
   * `:id` is checked by `CustomerTokenGuard` against the token's own `sid`
   * (R8), so by the time this runs the two are already known to agree — and
   * signing from the actor means a mismatch could not be smuggled through even
   * if that guard were ever removed.
   */
  forCustomer(actor: CustomerActor, now: Date = new Date()): WsTokenResult {
    const token = signJwt(
      {
        act: WS_ACTOR_CLAIM,
        aud: RealtimeAudience.CUSTOMER,
        tid: actor.tenantId,
        sid: actor.sessionId,
      },
      { secret: this.config.wsTokenSecret, ttlSeconds: this.config.wsTokenTtlSeconds },
    );

    return this.result(token, now, RealtimeAudience.CUSTOMER);
  }

  /**
   * An agent's connection token: tenant plus user.
   *
   * No session id, and that asymmetry is D9's: an agent's connection outlives
   * any one session, and scoping it to a session would mean re-minting on every
   * claim. The languages that decide which queue channels the connection joins
   * are deliberately **not** in the token — they are read from
   * `agent_profiles` at connect time, so a profile change takes effect on the
   * next connection rather than being frozen into a credential.
   */
  forAgent(actor: AgentActor, now: Date = new Date()): WsTokenResult {
    const token = signJwt(
      {
        act: WS_ACTOR_CLAIM,
        aud: RealtimeAudience.AGENT,
        tid: actor.tenantId,
        uid: actor.userId,
      },
      { secret: this.config.wsTokenSecret, ttlSeconds: this.config.wsTokenTtlSeconds },
    );

    return this.result(token, now, RealtimeAudience.AGENT);
  }

  private result(token: string, now: Date, audience: RealtimeAudience): WsTokenResult {
    return {
      token,
      expires_at: new Date(now.getTime() + this.config.wsTokenTtlSeconds * 1000).toISOString(),
      audience,
    };
  }
}
