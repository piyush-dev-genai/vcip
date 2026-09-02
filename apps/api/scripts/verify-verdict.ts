/**
 * The verdict transaction (T35) against real PostgreSQL and Redis.
 *
 * The unit suite proves the command is built correctly against fakes. Six
 * properties are claims about a real database and can be made nowhere else:
 *
 *   - that all six writes land — the transition, the checklist, the AI
 *     summary, the billing row, two events and the outbox row — from one call,
 *   - that they are **atomic**: a verdict that loses the guard writes none of
 *     them, which is §46's whole argument and the reason this is one
 *     transaction rather than six statements,
 *   - that the single-winner guard is in the statement rather than only in the
 *     service, so a session already terminal matches nothing (D17),
 *   - that `billing_entries.session_id` being the primary key really does make
 *     a second charge impossible,
 *   - that the outbox row is written without evidence keys and pointed at the
 *     tenant's active endpoint (D21),
 *   - and that the AI summary is absent, rather than zeroed, when no HUD
 *     exists (T32).
 *
 * Two halves, as `verify-agent-accept.ts` has: a rolled-back transaction for
 * everything one connection can answer, then committed fixtures — deleted in
 * the `finally` — for the parts that need a real commit to observe.
 *
 *   pnpm --filter @vcip/api db:verify-verdict
 */

import { randomUUID } from 'node:crypto';
import { LivenessStatus, OcrStatus, SessionEventType, SessionStatus } from '@vcip/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  billingEntries,
  checklistTemplates,
  sessionAiSummaries,
  sessionChecklistItems,
  sessionEvents,
  sessions,
  tenants,
  users,
  webhookEndpoints,
  webhookEvents,
} from '../db/schema.js';
import { DrizzleSessionEventWriter } from '../src/common/events/index.js';
import { DrizzleSessionRepository } from '../src/sessions/session.repository.js';
import type { SubmitVerdictCommand } from '../src/sessions/session.repository.js';

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

class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

const ITEMS = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
];

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client);

  const runId = randomUUID().slice(0, 8);
  const TENANT = randomUUID();
  const AGENT = randomUUID();
  const OTHER_AGENT = randomUUID();
  const TEMPLATE = randomUUID();
  const ENDPOINT = randomUUID();

  const T0 = new Date('2026-09-03T12:00:00.000Z');
  const eventWriter = new DrizzleSessionEventWriter();

  /** A session already `IN_CALL` with this agent, plus the `CALL_STARTED` fact. */
  const seedSession = async (
    executor: PostgresJsDatabase,
    id: string,
    over: { status?: string; agentId?: string; verdict?: string } = {},
  ): Promise<void> => {
    await executor.insert(sessions).values({
      id,
      tenantId: TENANT,
      externalRef: `verify-verdict-${runId}`,
      status: over.status ?? SessionStatus.IN_CALL,
      language: 'en',
      roomName: `vcip_${id}`,
      checklistTemplateId: TEMPLATE,
      agentId: over.agentId ?? AGENT,
      verdict: over.verdict ?? null,
      queuedAt: new Date(T0.getTime() - 120_000),
      connectedAt: new Date(T0.getTime() - 90_000),
    });

    await executor.insert(sessionEvents).values({
      tenantId: TENANT,
      sessionId: id,
      eventType: SessionEventType.CALL_STARTED,
      actorType: 'SYSTEM',
      payload: {},
      serverTs: new Date(T0.getTime() - 60_000),
    });
  };

  const commandFor = (
    sessionId: string,
    over: Partial<SubmitVerdictCommand> = {},
  ): SubmitVerdictCommand => ({
    sessionId,
    tenantId: TENANT,
    agentId: AGENT,
    verdict: SessionStatus.APPROVED,
    now: T0,
    billCategory: 'SUCCESS',
    billAmountPaise: 2500,
    checklist: [
      { key: 'face_visible', checked: true },
      { key: 'document_shown', checked: true },
    ],
    aiSummary: {
      session_id: sessionId,
      liveness_score: 97,
      liveness_status: LivenessStatus.LIVE,
      face_match_score: 95,
      ocr_status: OcrStatus.PASS,
      model_versions: { liveness: 'demo-v1' },
      updated_at: T0.toISOString(),
    },
    events: [
      {
        type: SessionEventType.VERDICT_SUBMITTED,
        actorType: 'AGENT',
        actorId: AGENT,
        payload: { to: SessionStatus.APPROVED },
      },
      {
        type: SessionEventType.BILLING_CREATED,
        actorType: 'SYSTEM',
        actorId: null,
        payload: { category: 'SUCCESS', amount_paise: 2500 },
      },
    ],
    webhookEventType: 'session.completed',
    webhookPayload: {
      event: 'session.completed',
      session_id: sessionId,
      verdict: SessionStatus.APPROVED,
      bill_category: 'SUCCESS',
      bill_amount_paise: 2500,
      occurred_at: T0.toISOString(),
    },
    ...over,
  });

  const insertFixtures = async (executor: PostgresJsDatabase): Promise<void> => {
    await executor.insert(tenants).values({
      id: TENANT,
      slug: `vv-${runId}`,
      name: `verify verdict ${runId}`,
      status: 'ACTIVE',
    });

    await executor.insert(users).values([
      {
        id: AGENT,
        tenantId: TENANT,
        email: `agent-${runId}@verify.local`,
        role: 'AGENT',
        status: 'ACTIVE',
      },
      {
        id: OTHER_AGENT,
        tenantId: TENANT,
        email: `other-${runId}@verify.local`,
        role: 'AGENT',
        status: 'ACTIVE',
      },
    ]);

    await executor
      .insert(checklistTemplates)
      .values({ id: TEMPLATE, tenantId: TENANT, version: 1, items: ITEMS, active: true });

    await executor.insert(webhookEndpoints).values({
      id: ENDPOINT,
      tenantId: TENANT,
      url: 'http://127.0.0.1:4010/webhooks/vcip',
      secretRef: 'env:VCIP_VERIFY_SECRET',
      active: true,
    });
  };

  const committed: string[] = [];

  try {
    // ------------------------------------------------------------ half one
    //
    // Everything one connection can answer, inside a transaction that is
    // rolled back. Nothing here survives the run.
    section('A verdict that commits, in one transaction');

    await db
      .transaction(async (tx) => {
        const executor = tx as unknown as PostgresJsDatabase;
        await insertFixtures(executor);

        const repo = new DrizzleSessionRepository(executor, eventWriter);
        const sessionId = randomUUID();
        await seedSession(executor, sessionId);

        const outcome = await repo.submitVerdict(commandFor(sessionId));

        check(outcome.kind === 'COMMITTED', 'the guard matched and the verdict committed');

        const [row] = await executor
          .select({
            status: sessions.status,
            verdict: sessions.verdict,
            verdictAt: sessions.verdictAt,
            endedAt: sessions.endedAt,
            talkMs: sessions.talkMs,
            billCategory: sessions.billCategory,
            billAmountPaise: sessions.billAmountPaise,
            exportStatus: sessions.exportStatus,
            version: sessions.version,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId));

        check(row?.status === SessionStatus.APPROVED, 'the session is APPROVED');
        check(row?.verdict === SessionStatus.APPROVED, 'the verdict column is written');
        check(row?.verdictAt !== null && row?.endedAt !== null, 'verdict_at and ended_at are set');
        check(row?.billCategory === 'SUCCESS', 'the denormalised bill_category is written');
        check(row?.billAmountPaise === 2500, 'the denormalised bill_amount_paise is written');
        check(row?.exportStatus === 'EXPORTING', 'export_status moved to EXPORTING (§45)');
        check((row?.version ?? 0) > 1, 'the version was bumped');
        // 60 seconds between the seeded CALL_STARTED and T0.
        check(row?.talkMs === 60_000, 'talk_ms is measured from CALL_STARTED');

        const answers = await executor
          .select({ key: sessionChecklistItems.itemKey, checked: sessionChecklistItems.checked })
          .from(sessionChecklistItems)
          .where(eq(sessionChecklistItems.sessionId, sessionId));

        check(answers.length === 2, 'both checklist answers were written');
        check(
          answers.every((answer) => answer.checked),
          'the answers hold what was submitted',
        );

        const [summary] = await executor
          .select({
            liveness: sessionAiSummaries.livenessScore,
            versions: sessionAiSummaries.modelVersions,
          })
          .from(sessionAiSummaries)
          .where(eq(sessionAiSummaries.sessionId, sessionId));

        check(Number(summary?.liveness) === 97, 'the AI summary was snapshotted');
        check(
          JSON.stringify(summary?.versions) === JSON.stringify({ liveness: 'demo-v1' }),
          'model_versions survived the snapshot',
        );

        const [bill] = await executor
          .select({
            category: billingEntries.category,
            amount: billingEntries.amountPaise,
            month: billingEntries.invoiceMonth,
          })
          .from(billingEntries)
          .where(eq(billingEntries.sessionId, sessionId));

        check(bill?.category === 'SUCCESS', 'one billing row, charged as SUCCESS');
        check(bill?.amount === 2500, 'the billing row charges Rs 25');
        check(String(bill?.month).startsWith('2026-09'), 'the invoice month follows the verdict');

        const events = await executor
          .select({ type: sessionEvents.eventType })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, sessionId));
        const types = events.map((event) => event.type);

        check(types.includes(SessionEventType.VERDICT_SUBMITTED), 'VERDICT_SUBMITTED is appended');
        check(types.includes(SessionEventType.BILLING_CREATED), 'BILLING_CREATED is appended');

        const [outbox] = await executor
          .select({
            endpointId: webhookEvents.endpointId,
            eventType: webhookEvents.eventType,
            status: webhookEvents.status,
            payload: webhookEvents.payload,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.sessionId, sessionId));

        check(outbox?.endpointId === ENDPOINT, 'the outbox row names the active endpoint');
        check(outbox?.eventType === 'session.completed', 'the outbox row is session.completed');
        check(outbox?.status === 'PENDING', 'the outbox row is PENDING');
        const payload = (outbox?.payload ?? {}) as Record<string, unknown>;
        check(
          !('video_key' in payload) && !('evidence_available' in payload),
          'the payload carries no evidence keys yet (D21)',
        );

        section('The guard, in the statement rather than in the service');

        const alreadyTerminal = randomUUID();
        await seedSession(executor, alreadyTerminal, {
          status: SessionStatus.DROPPED_IN_CALL,
          verdict: undefined,
        });
        const lost = await repo.submitVerdict(commandFor(alreadyTerminal));
        check(lost.kind === 'LOST', 'a session that already ended matches nothing (D17)');

        const someoneElses = randomUUID();
        await seedSession(executor, someoneElses, { agentId: OTHER_AGENT });
        const notMine = await repo.submitVerdict(commandFor(someoneElses));
        check(notMine.kind === 'LOST', "another agent's call matches nothing");

        const alreadyDecided = randomUUID();
        await seedSession(executor, alreadyDecided, { verdict: SessionStatus.APPROVED });
        const twice = await repo.submitVerdict(commandFor(alreadyDecided));
        check(twice.kind === 'LOST', 'a row that already holds a verdict matches nothing');

        section('A verdict that loses writes nothing at all (§46)');

        for (const [id, label] of [
          [alreadyTerminal, 'the already-ended session'],
          [someoneElses, "another agent's session"],
          [alreadyDecided, 'the already-decided session'],
        ] as const) {
          const bills = await executor
            .select({ id: billingEntries.sessionId })
            .from(billingEntries)
            .where(eq(billingEntries.sessionId, id));
          const answersWritten = await executor
            .select({ key: sessionChecklistItems.itemKey })
            .from(sessionChecklistItems)
            .where(eq(sessionChecklistItems.sessionId, id));
          const outboxWritten = await executor
            .select({ id: webhookEvents.id })
            .from(webhookEvents)
            .where(eq(webhookEvents.sessionId, id));

          check(
            bills.length === 0 && answersWritten.length === 0 && outboxWritten.length === 0,
            `${label} was charged nothing and recorded nothing`,
          );
        }

        section('No AI is recorded as no AI, never as zero (T32)');

        const noAi = randomUUID();
        await seedSession(executor, noAi);
        await repo.submitVerdict(commandFor(noAi, { aiSummary: null }));

        const summaries = await executor
          .select({ id: sessionAiSummaries.sessionId })
          .from(sessionAiSummaries)
          .where(eq(sessionAiSummaries.sessionId, noAi));
        check(summaries.length === 0, 'no summary row exists for a call the AI never analysed');

        const [stillBilled] = await executor
          .select({ amount: billingEntries.amountPaise })
          .from(billingEntries)
          .where(eq(billingEntries.sessionId, noAi));
        check(stillBilled?.amount === 2500, 'and the verdict is billed regardless (D6)');

        section('Every billable outcome, at the amount the table names');

        for (const [verdict, category, amount] of [
          [SessionStatus.REJECTED, 'FAILED', 500],
          [SessionStatus.ABORTED, 'FAILED', 500],
        ] as const) {
          const id = randomUUID();
          await seedSession(executor, id);
          await repo.submitVerdict(
            commandFor(id, { verdict, billCategory: category, billAmountPaise: amount }),
          );

          const [charged] = await executor
            .select({ category: billingEntries.category, amount: billingEntries.amountPaise })
            .from(billingEntries)
            .where(eq(billingEntries.sessionId, id));

          check(
            charged?.category === category && charged.amount === amount,
            `${verdict} is charged ${String(amount)} paise as ${category}`,
          );
        }

        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    // ------------------------------------------------------------ half two
    //
    // The primary key on `billing_entries` is a claim about committed data, so
    // this half commits and cleans up in the `finally`.
    section('One billing row per session, enforced by the database');

    await insertFixtures(db);
    const repo = new DrizzleSessionRepository(db, eventWriter);

    const sessionId = randomUUID();
    committed.push(sessionId);
    await seedSession(db, sessionId);

    const first = await repo.submitVerdict(commandFor(sessionId));
    check(first.kind === 'COMMITTED', 'the first verdict commits');

    const second = await repo.submitVerdict(commandFor(sessionId));
    check(second.kind === 'LOST', 'a second verdict on the same session is refused');

    const bills = await db
      .select({ id: billingEntries.sessionId })
      .from(billingEntries)
      .where(eq(billingEntries.sessionId, sessionId));
    check(bills.length === 1, 'exactly one billing row exists');

    // The constraint itself, not merely the guard in front of it. If the guard
    // ever regressed, this is what would still stop a second charge.
    let duplicateRefused = false;
    try {
      await db.execute(sql`
        INSERT INTO billing_entries (session_id, tenant_id, category, amount_paise, invoice_month)
        VALUES (${sessionId}::uuid, ${TENANT}::uuid, 'SUCCESS', 2500, date_trunc('month', now())::date)
      `);
    } catch {
      duplicateRefused = true;
    }
    check(duplicateRefused, 'the primary key refuses a second billing row outright');
  } finally {
    // Committed fixtures only. The rolled-back half left nothing behind.
    for (const sessionId of committed) {
      await db.delete(webhookEvents).where(eq(webhookEvents.sessionId, sessionId));
      await db.delete(billingEntries).where(eq(billingEntries.sessionId, sessionId));
      await db.delete(sessionAiSummaries).where(eq(sessionAiSummaries.sessionId, sessionId));
      await db.delete(sessionChecklistItems).where(eq(sessionChecklistItems.sessionId, sessionId));
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, ENDPOINT));
    await db.delete(checklistTemplates).where(eq(checklistTemplates.id, TEMPLATE));
    await db.delete(users).where(inArray(users.id, [AGENT, OTHER_AGENT]));
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
