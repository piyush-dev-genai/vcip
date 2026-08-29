/**
 * Internal service authentication (D10).
 *
 *   X-Internal-Token: <shared-secret>
 *
 * Protects `/internal/ai/result`, `/internal/egress/completed`, and
 * `/internal/livekit/webhook`. These routes are not published publicly; this
 * guard is the credential half of that boundary.
 *
 * LiveKit's own webhook signature verification is a separate concern and does
 * not live here — the webhook route carries both checks.
 *
 * The resulting actor deliberately has no tenant. Internal callers act across
 * tenants and name the resource they mean, so `TenantScope` refuses them on
 * tenant-scoped routes rather than inventing a tenant on their behalf.
 */

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ErrorCode } from '@vcip/shared';
import type { AuthConfig } from './auth.config.js';
import { InjectAuthConfig } from './auth.config.js';
import type { AuthenticatedRequest } from './auth-context.js';
import { INTERNAL_TOKEN_HEADER } from './auth-context.js';

const reject = (): never => {
  throw new UnauthorizedException({
    code: ErrorCode.UNAUTHENTICATED,
    message: 'Invalid or missing internal credentials.',
  });
};

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws when lengths differ, so lengths are compared first
 * and the result is folded in. The comparison still short-circuits on length —
 * which leaks the length of the secret, not its content, and the length is not
 * what protects it.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@InjectAuthConfig() private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const presented = request.headers[INTERNAL_TOKEN_HEADER];
    // A repeated header arrives as an array. Ambiguity is a rejection, not
    // something to resolve by picking one.
    if (typeof presented !== 'string' || presented.length === 0) return reject();

    if (!secretsMatch(presented, this.config.internalToken)) return reject();

    request.actor = { kind: 'internal', service: 'internal' };
    return true;
  }
}
