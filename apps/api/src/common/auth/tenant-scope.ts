/**
 * Tenant authorization.
 *
 * Authentication answered "who are you?". This answers "which tenant may you
 * operate within, and does this row belong to them?" — a separate question,
 * kept in a separate file, because collapsing the two is how a system ends up
 * treating "authenticated" as "allowed".
 *
 * Reusable across sessions, agents, checklists, webhooks, and billing: every
 * tenant-owned table carries `tenant_id`, so one predicate covers all of them.
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { Actor } from './auth-context.js';
import { tenantOf } from './auth-context.js';

/** Any row from a tenant-owned table. */
export interface TenantOwned {
  readonly tenantId: string;
}

@Injectable()
export class TenantScope {
  /**
   * The tenant this actor may operate within.
   *
   * Comes from the verified credential and from nowhere else — never from a
   * body, query, or path. Throws for an internal actor, which has no tenant
   * and therefore has no business on a tenant-scoped route.
   */
  requireTenant(actor: Actor | undefined): string {
    const tenantId = actor === undefined ? null : tenantOf(actor);
    if (tenantId === null) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'No tenant context for this request.',
      });
    }
    return tenantId;
  }

  /** Does this actor operate within `tenantId`? */
  owns(actor: Actor | undefined, tenantId: string): boolean {
    return actor !== undefined && tenantOf(actor) === tenantId;
  }

  /**
   * Assert that a loaded row belongs to the authenticated tenant.
   *
   * Throws `NOT_FOUND`, not `FORBIDDEN`, and the same for a missing row as for
   * another tenant's row. `403` on a cross-tenant id would confirm that the id
   * exists somewhere, turning this into an oracle for enumerating other
   * tenants' identifiers. From outside, another tenant's session and a session
   * that never existed look identical — which is the point.
   */
  assertOwnership<T extends TenantOwned>(actor: Actor | undefined, resource: T | null): T {
    const tenantId = this.requireTenant(actor);
    if (resource === null || resource.tenantId !== tenantId) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found.',
      });
    }
    return resource;
  }

  /**
   * A customer actor is additionally bound to one session (R8).
   *
   * Tenant ownership is necessary but not sufficient: a customer holding a
   * valid token for their own tenant still must not read a sibling session.
   */
  assertSessionAccess(actor: Actor | undefined, sessionId: string): void {
    this.requireTenant(actor);
    if (actor?.kind === 'customer' && actor.sessionId !== sessionId) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found.',
      });
    }
  }
}
