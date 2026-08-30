/**
 * Agent login.
 *
 * The whole of this file is one question — is this the right password for this
 * user in this tenant — and the discipline is in how it answers *no*.
 *
 * **One failure, one message, one shape.** Unknown tenant, unknown email,
 * disabled user, suspended tenant, a user who is not an agent, a null password
 * hash, and a wrong password all produce the identical 401. Not similar: the
 * same object, from the same helper. Anything else is an oracle — and here it
 * would be a *cross-tenant* oracle, because the caller chooses the tenant slug.
 * Being able to learn that `someone@bank-a.example` exists at Bank B by
 * comparing two error messages is exactly what invariant I8 forbids.
 *
 * **Every path does the KDF.** A rejection that skips scrypt returns in
 * microseconds where a real attempt takes ~100 ms, and that gap answers the
 * same question the error message refuses to. So when no user is found, the
 * password is verified against `unknownUserHash()` and the result discarded.
 *
 * **Nothing about the failure is logged with the input.** The email is the
 * thing an attacker is probing with; writing it to a log on every miss builds
 * the enumeration list for them in our own storage.
 *
 * Issuing the token itself is T09's `signJwt` with T09's claims and T09's
 * secret. There is no second JWT implementation and no second token format.
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AgentLoginRequest } from '@vcip/shared';
import { ErrorCode } from '@vcip/shared';
import { AGENT_ACTOR_CLAIM } from '../common/auth/agent-jwt.guard.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { InjectAuthConfig } from '../common/auth/auth.config.js';
import { ActorRole, isActorRole } from '../common/auth/auth-context.js';
import { unknownUserHash, verifyPassword } from '../common/auth/password.js';
import { nowSeconds, signJwt } from '../common/auth/tokens.js';
import type { AgentRepository } from './agent.repository.js';
import { InjectAgentRepository } from './agent.repository.js';

/**
 * `POST /v1/agent/login` response body.
 *
 * `expires_at` is ISO-8601 rather than the token's epoch-second `exp`: the rest
 * of the API's envelope speaks in timestamps, and a client should not have to
 * decode a JWT to know when to send the agent back to the login screen. The
 * token is the only credential in the body; there is no refresh token, because
 * R8's model has no refresh anywhere in the MVP.
 */
export interface AgentLoginResult {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_at: string;
}

/** `tenants.status` and `users.status` share the schema's active value. */
const ACTIVE = 'ACTIVE';

/**
 * The one authentication failure.
 *
 * A function rather than a constant so each throw is a fresh exception with its
 * own stack, and a helper rather than an inline object so a future branch
 * cannot quietly say something more specific.
 */
const rejectCredentials = (): never => {
  throw new UnauthorizedException({
    code: ErrorCode.UNAUTHENTICATED,
    message: 'Invalid credentials.',
  });
};

@Injectable()
export class AgentsService {
  constructor(
    @InjectAgentRepository() private readonly agents: AgentRepository,
    @InjectAuthConfig() private readonly config: AuthConfig,
  ) {}

  async login(body: AgentLoginRequest): Promise<AgentLoginResult> {
    const user = await this.agents.findAgentByEmail(body.tenant_slug, body.email);

    // The unknown-user path still pays for a KDF, so it cannot be told from the
    // wrong-password path by how long it took. The result is discarded; the
    // work is the point.
    if (user === null) {
      await verifyPassword(body.password, await unknownUserHash());
      return rejectCredentials();
    }

    // Everything below is checked *before* the outcome is used, and every
    // failure lands on the same throw. Order carries no information because the
    // response does not vary.
    const passwordOk = await verifyPassword(body.password, user.passwordHash);

    if (!passwordOk) return rejectCredentials();
    // A tenant that is not active cannot have agents taking calls, whatever the
    // user row says.
    if (user.tenantStatus !== ACTIVE) return rejectCredentials();
    // `DISABLED` is the schema's off switch for a user (USER_STATUSES). An
    // offboarded agent presenting yesterday's password gets the same answer as
    // a stranger.
    if (user.status !== ACTIVE) return rejectCredentials();
    // T16 is the agent surface. A `TENANT_ADMIN` row is a valid user with no
    // agent portal to log into; R9 leaves tenant-admin APIs unbuilt.
    if (user.role !== ActorRole.AGENT) return rejectCredentials();
    /* c8 ignore next -- the CHECK constraint on users.role makes this
       unreachable from the database; it exists so a widened enum cannot mint a
       token for a role the guard would then have to interpret. */
    if (!isActorRole(user.role)) return rejectCredentials();

    const issuedAt = nowSeconds();
    const expiresAt = issuedAt + this.config.agentJwtTtlSeconds;

    return {
      // T09's claim names, verbatim: `AgentJwtGuard` reads `uid`, `tid`, and
      // `role`, and `verifyJwt` requires `act` and `exp`. The tenant is the
      // one on the user's own row — never the slug the caller supplied, which
      // only chose which namespace to look in.
      access_token: signJwt(
        {
          act: AGENT_ACTOR_CLAIM,
          uid: user.userId,
          tid: user.tenantId,
          role: user.role,
        },
        {
          secret: this.config.agentJwtSecret,
          ttlSeconds: this.config.agentJwtTtlSeconds,
          issuedAt,
        },
      ),
      token_type: 'Bearer',
      expires_at: new Date(expiresAt * 1000).toISOString(),
    };
  }
}
