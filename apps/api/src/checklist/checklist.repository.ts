/**
 * Reading the checklist a session is pinned to (T33, D8).
 *
 * One query behind a port, for the reason every other repository here is: the
 * service's decisions are worth testing without PostgreSQL, and the SQL is
 * worth writing once.
 *
 * A `LEFT JOIN`, deliberately. An inner join would be shorter and would
 * collapse three different situations into one empty result — the session does
 * not exist, the session is another tenant's, and the session was created when
 * the tenant had no active template. The first two are a 404 the caller
 * deserves; the third is a data-integrity error nobody should be shown as
 * "not found". Keeping the session row and letting the template columns come
 * back null is what lets the service tell them apart.
 */

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { checklistTemplates, sessions } from '../../db/schema.js';
import { InjectDatabase } from '../common/db/db.tokens.js';

/**
 * A session and the template it was pinned to, if any.
 *
 * `items` is `unknown` on purpose: it is `jsonb`, the database guarantees
 * nothing about its shape, and typing it here as a checklist would be this
 * layer asserting something it cannot know. `parseTemplateItems` is what turns
 * it into items.
 */
export interface ChecklistSessionRow {
  readonly sessionId: string;
  /** Carried so `TenantScope.assertOwnership` can do its job on the result. */
  readonly tenantId: string;
  /** `sessions.agent_id`. Null until an agent accepts. */
  readonly assignedAgentId: string | null;
  /** Null when the tenant had no active template at session creation. */
  readonly templateId: string | null;
  readonly version: number | null;
  readonly items: unknown;
}

export interface ChecklistRepository {
  /**
   * The session's pinned checklist, or null when there is no such session in
   * this tenant.
   *
   * Tenant-scoped in SQL rather than in a check afterwards, so another
   * tenant's row is never loaded and the 404 is a property of the query.
   */
  findForSession(tenantId: string, sessionId: string): Promise<ChecklistSessionRow | null>;
}

export const CHECKLIST_REPOSITORY = Symbol('CHECKLIST_REPOSITORY');

export const InjectChecklistRepository = (): ParameterDecorator => Inject(CHECKLIST_REPOSITORY);

@Injectable()
export class DrizzleChecklistRepository implements ChecklistRepository {
  constructor(@InjectDatabase() private readonly db: PostgresJsDatabase) {}

  async findForSession(tenantId: string, sessionId: string): Promise<ChecklistSessionRow | null> {
    const rows = await this.db
      .select({
        sessionId: sessions.id,
        tenantId: sessions.tenantId,
        assignedAgentId: sessions.agentId,
        templateId: checklistTemplates.id,
        version: checklistTemplates.version,
        items: checklistTemplates.items,
      })
      .from(sessions)
      // Joined on the pinned id and nothing else. Not on `active`, which is
      // the whole point of D8: the template this session was judged against
      // stays readable after the tenant activates a different one.
      .leftJoin(checklistTemplates, eq(checklistTemplates.id, sessions.checklistTemplateId))
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
      .limit(1);

    return rows[0] ?? null;
  }
}
