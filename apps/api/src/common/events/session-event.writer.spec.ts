/**
 * The event writer, without a database.
 *
 * These assert the *statement* the writer builds — its real SQL text and bound
 * parameters, via Drizzle's own dialect — rather than that some method was
 * called. That is what makes "the server generates `server_ts`" and "ownership
 * is checked in the INSERT" checkable here at all: both are properties of the
 * SQL, and a mock that only records a call would prove neither.
 *
 * Behaviour against real PostgreSQL — transaction rollback, commit, and an
 * actual cross-tenant refusal — is `scripts/verify-events.ts`. Those need a
 * server, and the vitest suite stays runnable without one.
 */

import { describe, expect, it } from 'vitest';
import { SessionEventType } from '@vcip/shared';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Actor } from '../auth/auth-context.js';
import type { DbExecutor, SessionEventInput } from './session-event.writer.js';
import {
  DrizzleSessionEventWriter,
  EventTenantMismatchError,
  eventActorFor,
} from './session-event.writer.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const dialect = new PgDialect();

/**
 * Captures the statement instead of running it.
 *
 * Its only member is `execute`, which is also the entire `DbExecutor` contract —
 * so this doubles as proof that the writer cannot open a transaction of its own
 * even if someone later tried to make it.
 */
class CapturingExecutor implements DbExecutor {
  statements: SQL[] = [];
  rows: Record<string, unknown>[] = [{ id: '1', server_ts: new Date('2026-08-27T10:00:00.000Z') }];

  execute(query: SQL): Promise<Record<string, unknown>[]> {
    this.statements.push(query);
    return Promise.resolve(this.rows);
  }

  /** The last statement, as the text and parameters PostgreSQL would receive. */
  built(): { sql: string; params: unknown[] } {
    const last = this.statements[this.statements.length - 1];
    if (last === undefined) throw new Error('no statement was executed');
    return dialect.sqlToQuery(last);
  }
}

const validEvent = (overrides: Partial<SessionEventInput> = {}): SessionEventInput => ({
  tenantId: TENANT,
  sessionId: SESSION,
  eventType: SessionEventType.SESSION_CREATED,
  actorType: 'ENTERPRISE',
  actorId: null,
  payload: { language: 'en' },
  ...overrides,
});

const appendWith = async (event: SessionEventInput = validEvent()): Promise<CapturingExecutor> => {
  const executor = new CapturingExecutor();
  await new DrizzleSessionEventWriter().append(event, executor);
  return executor;
};

// ------------------------------------------------------------- the insert

describe('the appended row', () => {
  it('writes to session_events', async () => {
    const { sql } = (await appendWith()).built();
    expect(sql).toContain('INSERT INTO session_events');
  });

  it('binds tenant_id, session_id, event_type, actor_type, actor_id and payload', async () => {
    const { params } = (
      await appendWith(
        validEvent({
          eventType: SessionEventType.CONSENT_ACCEPTED,
          actorType: 'AGENT',
          actorId: USER,
          payload: { accepted: true },
        }),
      )
    ).built();

    expect(params).toContain(TENANT);
    expect(params).toContain(SESSION);
    expect(params).toContain('CONSENT_ACCEPTED');
    expect(params).toContain('AGENT');
    expect(params).toContain(USER);
    expect(params).toContain(JSON.stringify({ accepted: true }));
  });

  it('names the columns in the order the schema declares them', async () => {
    const { sql } = (await appendWith()).built();
    expect(sql).toContain(
      'session_events (tenant_id, session_id, event_type, actor_type, actor_id, payload, server_ts)',
    );
  });

  it('binds every caller value as a parameter, never as literal SQL', async () => {
    // An event type or payload spliced into the statement text would be an
    // injection surface. Everything variable must arrive as $n.
    const { sql } = (
      await appendWith(validEvent({ payload: { note: "'; DROP TABLE sessions; --" } }))
    ).built();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain(TENANT);
  });

  it('returns the id and server timestamp the database assigned', async () => {
    const executor = new CapturingExecutor();
    executor.rows = [{ id: '42', server_ts: new Date('2026-08-27T09:00:00.000Z') }];
    const written = await new DrizzleSessionEventWriter().append(validEvent(), executor);
    expect(written.id).toBe('42');
    expect(written.serverTs).toEqual(new Date('2026-08-27T09:00:00.000Z'));
  });
});

// ------------------------------------------------------- server timestamp

describe('server_ts is the server, not the caller', () => {
  it('sets server_ts to now(), evaluated by PostgreSQL', async () => {
    const { sql } = (await appendWith()).built();
    expect(sql).toContain('now()');
  });

  it('never binds a timestamp parameter', async () => {
    const { params } = (await appendWith()).built();
    for (const param of params) {
      expect(param).not.toBeInstanceOf(Date);
    }
  });

  it('ignores a timestamp smuggled past the type', async () => {
    // The input type has no `serverTs`, so this needs a cast to even write.
    // Casting past a type must not change what is stored.
    const smuggled = {
      ...validEvent(),
      serverTs: new Date('1999-01-01T00:00:00.000Z'),
      server_ts: '1999-01-01T00:00:00.000Z',
    } as unknown as SessionEventInput;

    const { sql, params } = (await appendWith(smuggled)).built();
    expect(sql).toContain('now()');
    expect(params).not.toContain('1999-01-01T00:00:00.000Z');
    expect(JSON.stringify(params)).not.toContain('1999');
  });
});

// ---------------------------------------------------- tenant / ownership

describe('tenant ownership is enforced by the statement itself', () => {
  it('guards the insert with EXISTS on the session and its tenant', async () => {
    const { sql } = (await appendWith()).built();
    expect(sql).toContain('WHERE EXISTS');
    expect(sql).toContain('FROM sessions');
    expect(sql).toContain('tenant_id =');
  });

  it('is a single statement, so there is no gap between check and write', async () => {
    const executor = await appendWith();
    expect(executor.statements).toHaveLength(1);
  });

  it('throws when the insert matches no session, which is what a mismatch looks like', async () => {
    const executor = new CapturingExecutor();
    executor.rows = [];
    await expect(
      new DrizzleSessionEventWriter().append(validEvent(), executor),
    ).rejects.toBeInstanceOf(EventTenantMismatchError);
  });

  it('names the session but never the tenant in the failure', async () => {
    const executor = new CapturingExecutor();
    executor.rows = [];
    try {
      await new DrizzleSessionEventWriter().append(validEvent(), executor);
      expect.unreachable();
    } catch (error) {
      expect((error as EventTenantMismatchError).sessionId).toBe(SESSION);
      expect((error as Error).message).not.toContain(TENANT);
    }
  });
});

// ------------------------------------------------------ transaction usage

describe('transaction participation', () => {
  it('runs on the executor it is given', async () => {
    const first = new CapturingExecutor();
    const second = new CapturingExecutor();
    const writer = new DrizzleSessionEventWriter();

    await writer.append(validEvent(), first);
    expect(first.statements).toHaveLength(1);
    expect(second.statements).toHaveLength(0);

    await writer.append(validEvent(), second);
    expect(second.statements).toHaveLength(1);
  });

  it('needs nothing from an executor beyond execute()', async () => {
    // A transaction handle is not a database handle. Depending on any wider
    // surface would silently make the writer unusable inside a transaction.
    const minimal: DbExecutor = {
      execute: () => Promise.resolve([{ id: '1', server_ts: new Date() }]),
    };
    await expect(
      new DrizzleSessionEventWriter().append(validEvent(), minimal),
    ).resolves.toMatchObject({ id: '1' });
  });

  it('is stateless, so one instance serves every caller', () => {
    const writer = new DrizzleSessionEventWriter();
    expect(Object.keys(writer)).toEqual([]);
  });
});

// ------------------------------------------------------------ append-only

describe('append-only surface', () => {
  it('exposes append and nothing else', () => {
    // The structural guarantee. Adding update() or delete() to the writer
    // fails here, which is the only place it can fail.
    const surface = Object.getOwnPropertyNames(DrizzleSessionEventWriter.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(surface).toEqual(['append']);
  });

  it('emits no UPDATE or DELETE', async () => {
    const { sql } = (await appendWith()).built();
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/ON CONFLICT/i);
  });

  it('appends a second event rather than replacing the first', async () => {
    const executor = new CapturingExecutor();
    const writer = new DrizzleSessionEventWriter();
    await writer.append(validEvent({ eventType: SessionEventType.SESSION_CREATED }), executor);
    await writer.append(validEvent({ eventType: SessionEventType.CONSENT_ACCEPTED }), executor);

    expect(executor.statements).toHaveLength(2);
    for (const statement of executor.statements) {
      expect(dialect.sqlToQuery(statement).sql).toContain('INSERT INTO session_events');
    }
  });
});

// ----------------------------------------------------------- actor model

describe('eventActorFor', () => {
  const enterprise: Actor = {
    kind: 'enterprise',
    tenantId: TENANT,
    apiKeyId: 'key-1',
    scopes: [],
  };
  const customer: Actor = { kind: 'customer', tenantId: TENANT, sessionId: SESSION };
  const agent: Actor = { kind: 'agent', tenantId: TENANT, userId: USER, role: 'AGENT' };
  const internal: Actor = { kind: 'internal', service: 'internal' };

  it('records an internal service as SYSTEM, the value the schema allows', () => {
    // There is no INTERNAL in session_events.actor_type. Writing one would
    // violate the CHECK constraint at runtime.
    expect(eventActorFor(internal)).toEqual({ actorType: 'SYSTEM', actorId: null });
  });

  it('records an agent with its user id', () => {
    expect(eventActorFor(agent)).toEqual({ actorType: 'AGENT', actorId: USER });
  });

  it('records an enterprise actor without a user id', () => {
    expect(eventActorFor(enterprise)).toEqual({ actorType: 'ENTERPRISE', actorId: null });
  });

  it('records a customer without a user id', () => {
    expect(eventActorFor(customer)).toEqual({ actorType: 'CUSTOMER', actorId: null });
  });

  it('never puts credential material in actor_id', () => {
    // An API key id and a session id are identities, but not user identities.
    expect(eventActorFor(enterprise).actorId).not.toBe('key-1');
    expect(eventActorFor(customer).actorId).not.toBe(SESSION);
  });

  it('only ever produces one of the four values the CHECK permits', () => {
    const allowed = ['CUSTOMER', 'AGENT', 'SYSTEM', 'ENTERPRISE'];
    for (const actor of [enterprise, customer, agent, internal]) {
      expect(allowed).toContain(eventActorFor(actor).actorType);
    }
  });
});
