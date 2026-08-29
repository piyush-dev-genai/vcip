/**
 * Tenant guard.
 *
 * Runs after an authentication guard and enforces two things at the request
 * boundary:
 *
 *   1. There IS an authenticated tenant. A route carrying this guard is
 *      tenant-scoped, so an actor without a tenant — an internal service —
 *      does not belong on it.
 *   2. Nothing in the request can redefine which tenant that is. A `tenant_id`
 *      in a body, query, or path that disagrees with the credential is
 *      rejected outright rather than ignored.
 *
 * Rejecting rather than ignoring is the deliberate choice. Silently ignoring a
 * mismatched `tenant_id` is safe but invisible: a caller sending the wrong one
 * gets another tenant's-looking request quietly answered from their own data,
 * and nobody learns the client is broken. A 403 surfaces it on the first call.
 *
 * Whether a specific ROW belongs to the tenant is `TenantScope.assertOwnership`,
 * called by the service that loaded it. A guard cannot know that — it has not
 * read the database yet.
 */

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { AuthenticatedRequest } from './auth-context.js';
// A value import, NOT `import type`: TenantScope is the injection token Nest
// resolves this constructor argument by, so erasing it at compile time makes
// the module unresolvable at boot. A unit test that constructs the guard
// directly cannot catch that, which is why the build is booted before release.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above
import { TenantScope } from './tenant-scope.js';

/** Where a client might try to assert a tenant. */
const TENANT_FIELDS = ['tenant_id', 'tenantId'] as const;

const suppliedTenantIds = (request: AuthenticatedRequest): string[] => {
  const sources: Array<Record<string, unknown> | undefined> = [
    request.body as Record<string, unknown> | undefined,
    request.query as Record<string, unknown> | undefined,
    request.params as unknown as Record<string, unknown> | undefined,
  ];

  const found: string[] = [];
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue;
    for (const field of TENANT_FIELDS) {
      const value = source[field];
      if (typeof value === 'string' && value.length > 0) found.push(value);
    }
  }
  return found;
};

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly tenantScope: TenantScope) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Throws FORBIDDEN when the request is unauthenticated or the actor has no
    // tenant. The authenticated credential is the only source considered.
    const authenticatedTenant = this.tenantScope.requireTenant(request.actor);

    for (const supplied of suppliedTenantIds(request)) {
      if (supplied !== authenticatedTenant) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Tenant mismatch.',
        });
      }
    }

    return true;
  }
}
