/**
 * Agent JWT authentication.
 *
 *   Authorization: Bearer <agent_jwt>
 *
 * Claims required by `docs/03-system-design.md` §32: `user_id`, `tenant_id`,
 * `role`, and an expiry. All four are mandatory — a token missing any of them
 * is rejected rather than defaulted, because a token without a tenant is a
 * token that could reach every tenant.
 *
 * Issuing these (email plus password, then a JWT) belongs to the agent auth
 * flow in a later task. This is the verifying half.
 */

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { AuthConfig } from './auth.config.js';
import { InjectAuthConfig } from './auth.config.js';
import type { AuthenticatedRequest } from './auth-context.js';
import { isActorRole } from './auth-context.js';
import { bearerFrom, verifyJwt } from './tokens.js';

export const AGENT_ACTOR_CLAIM = 'agent';

const reject = (): never => {
  throw new UnauthorizedException({
    code: ErrorCode.UNAUTHENTICATED,
    message: 'Invalid or missing agent credentials.',
  });
};

@Injectable()
export class AgentJwtGuard implements CanActivate {
  constructor(@InjectAuthConfig() private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const presented = bearerFrom(request.headers.authorization);
    if (presented === null) return reject();

    let claims;
    try {
      claims = verifyJwt(presented, this.config.agentJwtSecret, AGENT_ACTOR_CLAIM);
    } catch {
      return reject();
    }

    const userId = claims['uid'];
    const tenantId = claims['tid'];
    const role = claims['role'];

    if (typeof userId !== 'string' || userId.length === 0) return reject();
    // Never silently accept a token without tenant identity. There is no
    // fallback, no default tenant, and no lookup that could supply one.
    if (typeof tenantId !== 'string' || tenantId.length === 0) return reject();
    // The role must be one @vcip/shared recognises. An unknown role is not
    // treated as "no privileges"; it is treated as a broken credential.
    if (!isActorRole(role)) return reject();

    request.actor = { kind: 'agent', tenantId, userId, role };
    return true;
  }
}
