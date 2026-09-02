/**
 * The checklist a session is pinned to, read (T33) and answered (T34).
 *
 * Two statements behind a port, for the reason every other repository here has
 * one: the service's decisions are worth testing without PostgreSQL, and the
 * SQL is worth writing once.
 *
 * The read is a `LEFT JOIN`, deliberately. An inner join would be shorter and
 * would collapse three different situations into one empty result — the
 * session does not exist, the session is another tenant's, and the session was
 * created when the tenant had no active template. The first two are a 404 the
 * caller deserves; the third is a data-integrity error nobody should be shown
 * as "not found". Keeping the session row and letting the template columns come
 * back null is what lets the service tell them apart.
 *
 * The write **never opens a transaction**, for the reason `SessionEventWriter`
 * does not: the answers belong to the verdict, and the verdict is one
 * transaction that also moves the session, bills it, snapshots the AI summary
 * and writes the outbox (schema §45). A checklist that committed on its own
 * would be a record of an attestation for a verdict that then rolled back.
 */

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ResolvedChecklistItem } from '@vcip/shared';
import { checklistTemplates, sessions } from '../../db/schema.js';
import type { DbExecutor } from '../common/events/session-event.writer.js';
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

  /**
   * Record the answers (T34, schema §45's "Upsert session\_checklist\_items").
   *
   * `executor` is the transaction the verdict owns. There is no overload that
   * opens one — see the note at the top of this file.
   *
   * An upsert rather than an insert, because the verdict route carries an
   * `Idempotency-Key` and a replay must land on the same rows rather than a
   * primary-key violation. The keys are already validated against the pinned
   * template before this is reached, so nothing here decides what may be
   * written; it writes what it is given.
   */
  saveAnswers(
    sessionId: string,
    items: readonly ResolvedChecklistItem[],
    executor: DbExecutor,
  ): Promise<void>;
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

  async saveAnswers(
    sessionId: string,
    items: readonly ResolvedChecklistItem[],
    executor: DbExecutor,
  ): Promise<void> {
    /* c8 ignore next -- validation upstream never produces an empty set */
    if (items.length === 0) return;

    // One statement for the whole checklist. Three round trips inside the
    // verdict's transaction would hold row locks for three times as long on
    // the path that also bills the session.
    //
    // `checked_at` is derived here rather than passed in, because the schema's
    // CHECK constraint ties the two columns together — a checked item has a
    // time, an unchecked one has none — and `now()` is the database's clock
    // rather than this process's.
    const values = items.map(
      (item) =>
        sql`(${sessionId}::uuid, ${item.key}, ${item.checked}, ${item.checked ? sql`now()` : sql`NULL`}, now())`,
    );

    await executor.execute(sql`
      INSERT INTO session_checklist_items (session_id, item_key, checked, checked_at, updated_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (session_id, item_key) DO UPDATE
         SET checked    = EXCLUDED.checked,
             checked_at = EXCLUDED.checked_at,
             updated_at = now()
    `);
  }
}
