/**
 * Customer session token authentication.
 *
 *   Authorization: Bearer <customer_session_token>
 *
 * The token is short-lived, stateless, and bound to exactly one session (R8).
 * A customer holding it can act on that session and nothing else: not another
 * session, not an agent route, not an internal route.
 *
 * There is no refresh and no revocation in the MVP. The two-hour lifetime is
 * the whole of the expiry story.
 */

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { AuthConfig } from './auth.config.js';
import { InjectAuthConfig } from './auth.config.js';
import type { AuthenticatedRequest } from './auth-context.js';
import { bearerFrom, verifyJwt } from './tokens.js';

/** Claim names. `tid`/`sid` rather than the column names: this is a wire format. */
export const CUSTOMER_ACTOR_CLAIM = 'customer';

const reject = (): never => {
  throw new UnauthorizedException({
    code: ErrorCode.UNAUTHENTICATED,
    message: 'Invalid or missing customer token.',
  });
};

/**
 * Route parameters that name a session. A customer token is checked against
 * whichever of these the route carries.
 */
const SESSION_PARAMS = ['sessionId', 'session_id', 'id'] as const;

const sessionParamOf = (request: AuthenticatedRequest): string | null => {
  const params = request.params as Record<string, string | undefined> | undefined;
  if (params === undefined) return null;
  for (const name of SESSION_PARAMS) {
    const value = params[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
};

@Injectable()
export class CustomerTokenGuard implements CanActivate {
  constructor(@InjectAuthConfig() private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const presented = bearerFrom(request.headers.authorization);
    if (presented === null) return reject();

    let claims;
    try {
      // Verified with the CUSTOMER secret and against the customer actor claim.
      // An agent JWT fails both checks, not just one.
      claims = verifyJwt(presented, this.config.customerTokenSecret, CUSTOMER_ACTOR_CLAIM);
    } catch {
      // The reason is deliberately swallowed: expired, forged, and wrong-type
      // must be indistinguishable to the caller.
      return reject();
    }

    const tenantId = claims['tid'];
    const sessionId = claims['sid'];
    if (typeof tenantId !== 'string' || tenantId.length === 0) return reject();
    if (typeof sessionId !== 'string' || sessionId.length === 0) return reject();

    // Session binding. A token for session A presented against session B is
    // rejected here — the token is valid, but not for this resource.
    const routeSession = sessionParamOf(request);
    if (routeSession !== null && routeSession !== sessionId) return reject();

    request.actor = { kind: 'customer', tenantId, sessionId };
    return true;
  }
}
