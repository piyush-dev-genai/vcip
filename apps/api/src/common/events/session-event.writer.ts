/**
 * The append-only `session_events` writer.
 *
 * One place where session history is written. Every module that follows —
 * queue, agents, checklist, verdict, billing, export, webhooks — appends
 * through this rather than reaching for the table, so the payload boundary, the
 * tenant check, and the server timestamp are decided once instead of at each
 * call site.
 *
 * Three properties are worth reading the implementation for.
 *
 * **It never opens a transaction.** The executor is an argument. A session
 * mutation and its event must commit together (invariant I10 is worthless if an
 * event can survive a rolled-back state change, or vanish from a committed
 * one), and a writer that opened its own connection would quietly break that
 * for every caller. Passing the handle in is the whole design.
 *
 * **The tenant check is the INSERT.** Rather than SELECT the session, compare
 * its tenant, and then insert — three statements with a gap in the middle, and
 * a second tenant-isolation mechanism competing with T09's — the ownership test
 * is a `WHERE EXISTS` on the insert itself. Zero rows inserted means the
 * session does not belong to that tenant, and the writer throws. There is no
 * window, no extra round trip, and no way to write a mismatched pair.
 *
 * **`server_ts` is `now()`, evaluated by PostgreSQL.** The input type has no
 * timestamp field, so a caller cannot pass one; the SQL does not read one, so a
 * caller casting past the type cannot smuggle one either.
 *
 * On append-only: this exposes `append` and nothing else, which makes writing
 * history the easy path and rewriting it require deliberately going around the
 * writer. It is not an absolute guarantee — `sessionEvents` is exported from
 * `db/schema.ts` and any module could import it and call `.update()`. A real
 * guarantee needs a restricted database role or a trigger, which
 * `docs/06-database-schema.md`'s invariant notes already defer past the MVP.
 * Claiming more than that here would be false comfort.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { SessionEventType } from '@vcip/shared';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
// `import type`, deliberately: ACTOR_TYPES is used only in a `typeof` type
// query, never as a value or an injection token, so erasing it at compile time
// is correct here — unlike the DI tokens in tenant.guard.ts.
import type { ACTOR_TYPES } from '../../../db/schema.js';
import type { Actor } from '../auth/auth-context.js';
import type { EventPayload } from './event-payload.js';
import { assertPayloadAllowed } from './event-payload.js';

/**
 * `session_events.actor_type`.
 *
 * Derived from the schema's own value set rather than retyped, so the union and
 * the CHECK constraint cannot drift. Note that there are exactly four: there is
 * no `INTERNAL`, and an internal service writes as `SYSTEM`.
 */
export type EventActorType = (typeof ACTOR_TYPES)[number];

/**
 * Anything that can run a statement: the database handle, or a transaction.
 *
 * Structural on purpose. `PostgresJsDatabase` and the transaction object
 * Drizzle hands to a `transaction()` callback are different types that both
 * have `execute`, and this is the one member the writer needs. Naming the
 * capability instead of the class is what lets the same call work inside and
 * outside a transaction without a second abstraction.
 *
 * Declared rather than `Pick`ed from the driver: Drizzle's own return type is a
 * `PgRaw<RowList<...>>`, and requiring that exact type would mean only Drizzle
 * objects could ever satisfy this — no test double, and no future driver.
 *
 * Non-generic, and rows come back untyped. Drizzle's `execute` is generic in
 * the row type, but its `Assume<TRow, Row>` indirection does not survive
 * structural assignment, so a generic signature here makes `PgTransaction`
 * itself unassignable. Untyped is also the truth: this is raw SQL, and nothing
 * has checked that the returned columns match a claimed shape. The writer reads
 * the two columns it asked for and converts them explicitly.
 */
export interface DbExecutor {
  execute(query: SQL): PromiseLike<Record<string, unknown>[]>;
}

export interface SessionEventInput {
  /** From the authenticated context. Present in the ownership check. */
  readonly tenantId: string;
  readonly sessionId: string;
  /** From `@vcip/shared`. The vocabulary is closed; no string literals. */
  readonly eventType: SessionEventType;
  readonly actorType: EventActorType;
  /** Null where no user identity applies — a system or enterprise actor. */
  readonly actorId: string | null;
  readonly payload: EventPayload;

  // Deliberately absent: `serverTs`. The server owns event time.
  // Deliberately absent: `id`. The column is BIGSERIAL.
}

/** What was written. Returned so a caller can log the id without re-reading. */
export interface AppendedEvent {
  readonly id: string;
  readonly serverTs: Date;
}

/**
 * Thrown when the session does not belong to the tenant the caller named.
 *
 * A server-side fault, not a client one: by the time anything reaches this
 * writer, T09's `TenantScope` has already established ownership, so a mismatch
 * here means a bug upstream — the caller paired a session with the wrong tenant.
 */
export class EventTenantMismatchError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('session does not belong to the tenant recording this event');
    this.name = 'EventTenantMismatchError';
    this.sessionId = sessionId;
  }
}

export interface SessionEventWriter {
  /**
   * Append one event.
   *
   * `executor` is the transaction the surrounding business operation owns, or
   * the database handle when there is no wider unit of work. There is no
   * overload that opens one for you — see the note at the top of this file.
   */
  append(event: SessionEventInput, executor: DbExecutor): Promise<AppendedEvent>;
}

export const SESSION_EVENT_WRITER = Symbol('SESSION_EVENT_WRITER');

export const InjectSessionEventWriter = (): ParameterDecorator => Inject(SESSION_EVENT_WRITER);

/**
 * Map an authenticated actor onto the two columns that describe it.
 *
 * The four actor kinds T09 defines do not map one-to-one onto the four the
 * schema allows: an `internal` actor is recorded as `SYSTEM`, because
 * `session_events.actor_type` has no `INTERNAL` value and an internal service
 * acting on a session is exactly what `SYSTEM` means.
 *
 * `actorId` is a user id or nothing. An enterprise actor's API key id and a
 * customer's session id are identities, but they are not user identities, and
 * putting either in a column that means "which user" would make the audit trail
 * lie about what it holds.
 */
export function eventActorFor(actor: Actor): {
  actorType: EventActorType;
  actorId: string | null;
} {
  switch (actor.kind) {
    case 'enterprise':
      return { actorType: 'ENTERPRISE', actorId: null };
    case 'customer':
      return { actorType: 'CUSTOMER', actorId: null };
    case 'agent':
      return { actorType: 'AGENT', actorId: actor.userId };
    case 'internal':
      return { actorType: 'SYSTEM', actorId: null };
  }
}

@Injectable()
export class DrizzleSessionEventWriter implements SessionEventWriter {
  async append(event: SessionEventInput, executor: DbExecutor): Promise<AppendedEvent> {
    // Before touching the database: a prohibited key throws here, so nothing is
    // written and the surrounding transaction is free to roll back cleanly.
    assertPayloadAllowed(event.payload);

    // INSERT ... SELECT ... WHERE EXISTS. The ownership test and the write are
    // one statement, so there is no interval in which the session could change
    // tenant, and no possibility of the check passing while the insert lands
    // against a different row.
    //
    // Raw SQL here, not in the caller-facing API: Drizzle's builder has no
    // natural form for a conditional insert of constant values, and the
    // parameters below are bound, never interpolated.
    const rows = await executor.execute(sql`
      INSERT INTO session_events (tenant_id, session_id, event_type, actor_type, actor_id, payload, server_ts)
      SELECT ${event.tenantId}::uuid,
             ${event.sessionId}::uuid,
             ${event.eventType},
             ${event.actorType},
             ${event.actorId}::uuid,
             ${JSON.stringify(event.payload)}::jsonb,
             now()
       WHERE EXISTS (
             SELECT 1 FROM sessions
              WHERE id = ${event.sessionId}::uuid
                AND tenant_id = ${event.tenantId}::uuid)
      RETURNING id, server_ts
    `);

    const written = rows[0];
    // No row: the EXISTS failed. Either the session does not exist, or it
    // belongs to another tenant — and both are the same upstream bug.
    if (written === undefined) throw new EventTenantMismatchError(event.sessionId);

    // Converted explicitly, because the driver's shape for these two columns is
    // its own business: `bigserial` may arrive as a string or a number, and a
    // `timestamptz` as a Date or an ISO string depending on the parser in play.
    const serverTs = written['server_ts'];
    return {
      id: String(written['id']),
      serverTs: serverTs instanceof Date ? serverTs : new Date(String(serverTs)),
    };
  }
}
