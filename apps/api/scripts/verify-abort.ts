/**
 * The customer abort, and the charge it now carries (T12).
 *
 * The abort reported an amount from the shared billing table and wrote no
 * `billing_entries` row. The response said Rs 5, the ledger said nothing, and
 * the two disagreed for every aborted verification in the system. The
 * in-memory suite proves the service issues the command; four things are claims
 * about the real schema and can be made nowhere else:
 *
 *   - that the row lands with the category, amount and invoice month the
 *     command asked for -- `invoice_month` is `date_trunc`'d in SQL, so it is
 *     the database's arithmetic and not the service's,
 *   - that `billing_entries_amount_positive` and the category CHECK accept what
 *     the abort writes, rather than rejecting it mid-transaction the way a
 *     zero-amount row would,
 *   - that a **lost guard writes nothing at all** -- no status, no event, and
 *     above all no charge, because a charge surviving a rolled-back transition
 *     is worse than the gap this fixes,
 *   - and that the primary key really does refuse a second charge, which is the
 *     defence behind the guard.
 *
 * Both abort targets are covered: `QUEUED -> DROPPED_QUEUED` and
 * `IN_CALL -> ABORTED` are different facts (R4) at the same price.
 *
 * Committed fixtures, deleted in the `finally`.
 *
 *   pnpm --filter @vcip/api db:verify-abort
 */

import { randomUUID } from 'node:crypto';
import { SessionEventType, SessionStatus, getBillingForOutcome } from '@vcip/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { billingEntries, sessionEvents, sessions, tenants } from '../db/schema.js';
import { DrizzleSessionEventWriter } from '../src/common/events/index.js';
import { DrizzleSessionRepository } from '../src/sessions/session.repository.js';
import type { AbortSessionCommand } from '../src/sessions/session.repository.js';

let passed = 0;
let failed = 0;

const check = (condition: boolean, label: string): void => {
  if (condition) {
    passed += 1;
    process.stdout.write(`   PASS  ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`   FAIL  ${label}\n`);
  }
};

const section = (label: string): void => process.stdout.write(`\n${label}\n`);

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client);
  const repo = new DrizzleSessionRepository(db, new DrizzleSessionEventWriter());

  const runId = randomUUID().slice(0, 8);
  const TENANT = randomUUID();
  // Deliberately not the first of the month: `invoice_month` has to be derived
  // rather than copied, and a timestamp on the 1st would hide the difference.
  const T0 = new Date('2026-09-17T22:45:12.345Z');

  const seeded: string[] = [];

  const seedSession = async (status: SessionStatus): Promise<string> => {
    const id = randomUUID();
    seeded.push(id);
    await db.insert(sessions).values({
      id,
      tenantId: TENANT,
      externalRef: `verify-abort-${runId}`,
      status,
      language: 'en',
      roomName: `vcip_${id}`,
      queuedAt: new Date(T0.getTime() - 120_000),
      version: 1,
    });
    return id;
  };

  const commandFor = (
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
    over: Partial<AbortSessionCommand> = {},
  ): AbortSessionCommand => {
    const billing = getBillingForOutcome(to);
    return {
      sessionId,
      tenantId: TENANT,
      expectedStatus: from,
      expectedVersion: 1,
      status: to,
      now: T0,
      billCategory: billing.category ?? 'FAILED',
      billAmountPaise: billing.amountPaise,
      events: [
        {
          type: SessionEventType.SESSION_ABORTED,
          actorType: 'CUSTOMER',
          actorId: null,
          payload: { from, to, reason: 'CUSTOMER_ABORT' },
        },
        {
          type: SessionEventType.BILLING_CREATED,
          actorType: 'SYSTEM',
          actorId: null,
          payload: { category: billing.category, amount_paise: billing.amountPaise },
        },
      ],
      ...over,
    };
  };

  const ledgerFor = async (sessionId: string) => {
    const [row] = await db
      .select({
        category: billingEntries.category,
        amountPaise: billingEntries.amountPaise,
        invoiceMonth: billingEntries.invoiceMonth,
        tenantId: billingEntries.tenantId,
      })
      .from(billingEntries)
      .where(eq(billingEntries.sessionId, sessionId));
    return row ?? null;
  };

  try {
    await db.insert(tenants).values({
      id: TENANT,
      slug: `va-${runId}`,
      name: `verify abort ${runId}`,
      status: 'ACTIVE',
    });

    section('A queue abort is charged Rs 5');

    const queued = await seedSession(SessionStatus.QUEUED);
    const droppedRow = await repo.abortSession(
      commandFor(queued, SessionStatus.QUEUED, SessionStatus.DROPPED_QUEUED),
    );

    check(droppedRow?.status === SessionStatus.DROPPED_QUEUED, 'ends as DROPPED_QUEUED');
    check(droppedRow?.endedAt !== null, 'is stamped with an end');

    const droppedBill = await ledgerFor(queued);
    check(droppedBill !== null, 'a billing row exists at all -- the gap this closes');
    check(droppedBill?.category === 'FAILED', 'the category is FAILED');
    check(droppedBill?.amountPaise === 500, 'the amount is Rs 5');
    check(droppedBill?.tenantId === TENANT, 'the row carries the tenant');
    check(
      String(droppedBill?.invoiceMonth) === '2026-09-01',
      'the invoice month is derived by date_trunc, not copied from the timestamp',
    );

    const droppedEvents = await db
      .select({ type: sessionEvents.eventType })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, queued));
    check(
      droppedEvents.some((event) => event.type === SessionEventType.BILLING_CREATED),
      'the charge is in the append-only history beside the transition',
    );

    section('An in-call abort is charged Rs 5');

    const inCall = await seedSession(SessionStatus.IN_CALL);
    const abortedRow = await repo.abortSession(
      commandFor(inCall, SessionStatus.IN_CALL, SessionStatus.ABORTED),
    );

    check(abortedRow?.status === SessionStatus.ABORTED, 'ends as ABORTED (R4)');
    const abortedBill = await ledgerFor(inCall);
    check(
      abortedBill?.amountPaise === 500 && abortedBill.category === 'FAILED',
      'is billed Rs 5 as FAILED, like the queue abort',
    );

    section('A lost guard writes nothing at all');

    const contested = await seedSession(SessionStatus.QUEUED);
    // The version the caller read is stale: something else moved the row first.
    const lost = await repo.abortSession(
      commandFor(contested, SessionStatus.QUEUED, SessionStatus.DROPPED_QUEUED, {
        expectedVersion: 99,
      }),
    );

    check(lost === null, 'the guard refuses a stale version');

    const [untouched] = await db
      .select({ status: sessions.status, billCategory: sessions.billCategory })
      .from(sessions)
      .where(eq(sessions.id, contested));
    check(untouched?.status === SessionStatus.QUEUED, 'the session did not move');
    check(untouched?.billCategory === null, 'the mirrored billing column stayed null');
    check(await ledgerFor(contested).then((row) => row === null), 'and no charge was written');

    const noEvents = await db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, contested));
    check(noEvents.length === 0, 'and no event was appended');

    section('A second charge is impossible');

    const second = await repo.abortSession(
      commandFor(queued, SessionStatus.QUEUED, SessionStatus.DROPPED_QUEUED),
    );
    check(second === null, 'a second abort matches nothing (I11)');

    const stillOne = await db
      .select({ id: billingEntries.sessionId })
      .from(billingEntries)
      .where(eq(billingEntries.sessionId, queued));
    check(stillOne.length === 1, 'exactly one billing row survives');

    // The constraint itself, not merely the guard in front of it.
    let refused = false;
    try {
      await db.insert(billingEntries).values({
        sessionId: queued,
        tenantId: TENANT,
        category: 'FAILED',
        amountPaise: 500,
        invoiceMonth: '2026-09-01',
      });
    } catch {
      refused = true;
    }
    check(refused, 'the primary key refuses a second billing row outright');
  } finally {
    for (const sessionId of seeded) {
      await db.delete(billingEntries).where(eq(billingEntries.sessionId, sessionId));
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
    await db.delete(tenants).where(eq(tenants.id, TENANT));
    await client.end();
  }

  process.stdout.write(`\n=== RESULT: ${String(passed)} passed, ${String(failed)} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stdout.write(`\nVERIFY FAILED: ${String(error)}\n`);
  process.exit(1);
});
