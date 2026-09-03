/**
 * The two Day 5 races against real PostgreSQL (T36, T37).
 *
 * `verdict-race.spec.ts` proves how the services behave once a statement has
 * won or lost. It cannot prove the one thing the gates are actually about,
 * because that claim belongs to PostgreSQL: that two guarded UPDATEs issued at
 * the same instant, on two separate connections, against the same row, produce
 * exactly one winner.
 *
 * Nothing here is simulated. Two `postgres` clients, two transactions started
 * inside one `Promise.all`, and the row lock decides. Under READ COMMITTED the
 * second UPDATE blocks until the first commits and then re-evaluates its WHERE
 * clause against the new row — which is the whole mechanism behind D17, and is
 * either true of this schema or is not.
 *
 * Three races, each run several times, because a race that passes once passes
 * by luck:
 *
 *   - verdict against verdict (T36) -> one verdict, one billing row
 *   - verdict against a disconnect  (T37) -> one terminal outcome, loser refused
 *   - verdict against a customer abort (D17) -> same, from the other direction
 *
 * Committed fixtures, deleted in the `finally`: a race cannot be observed
 * inside one rolled-back transaction, since two connections would never see
 * each other's uncommitted rows.
 *
 *   pnpm --filter @vcip/api db:verify-verdict-race
 */

import { randomUUID } from 'node:crypto';
import { LivenessStatus, OcrStatus, SessionEventType, SessionStatus } from '@vcip/shared';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
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

/** How many times each race runs. One pass proves nothing about a race. */
const ROUNDS = 5;

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

  // Three pools of one. Two contenders and a third for the assertions, so a
  // reader is never waiting behind a lock a contender is holding.
  const clientOne = postgres(databaseUrl, { max: 1 });
  const clientTwo = postgres(databaseUrl, { max: 1 });
  const clientRead = postgres(databaseUrl, { max: 1 });

  const dbOne = drizzle(clientOne);
  const dbTwo = drizzle(clientTwo);
  const db = drizzle(clientRead);

  const eventWriter = new DrizzleSessionEventWriter();
  const repoOne = new DrizzleSessionRepository(dbOne, eventWriter);
  const repoTwo = new DrizzleSessionRepository(dbTwo, eventWriter);

  const runId = randomUUID().slice(0, 8);
  const TENANT = randomUUID();
  const AGENT = randomUUID();
  const TEMPLATE = randomUUID();
  const ENDPOINT = randomUUID();

  const T0 = new Date('2026-09-03T12:00:00.000Z');
  const seeded: string[] = [];

  /** A session `IN_CALL` with this agent, and the `CALL_STARTED` fact. */
  const seedSession = async (): Promise<string> => {
    const id = randomUUID();
    seeded.push(id);

    await db.insert(sessions).values({
      id,
      tenantId: TENANT,
      externalRef: `verify-race-${runId}`,
      status: SessionStatus.IN_CALL,
      language: 'en',
      roomName: `vcip_${id}`,
      checklistTemplateId: TEMPLATE,
      agentId: AGENT,
      queuedAt: new Date(T0.getTime() - 120_000),
      connectedAt: new Date(T0.getTime() - 90_000),
      version: 1,
    });

    await db.insert(sessionEvents).values({
      tenantId: TENANT,
      sessionId: id,
      eventType: SessionEventType.CALL_STARTED,
      actorType: 'SYSTEM',
      payload: {},
      serverTs: new Date(T0.getTime() - 60_000),
    });

    return id;
  };

  const verdictCommand = (
    sessionId: string,
    verdict: SessionStatus = SessionStatus.APPROVED,
  ): SubmitVerdictCommand => ({
    sessionId,
    tenantId: TENANT,
    agentId: AGENT,
    verdict,
    now: T0,
    billCategory: verdict === SessionStatus.APPROVED ? 'SUCCESS' : 'FAILED',
    billAmountPaise: verdict === SessionStatus.APPROVED ? 2500 : 500,
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
        payload: { to: verdict },
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
      verdict,
      occurred_at: T0.toISOString(),
    },
  });

  /** The disconnect path: what the call sweeper issues when nobody came back. */
  const endCallOn = (repo: DrizzleSessionRepository, sessionId: string) =>
    repo.endCall({
      sessionId,
      tenantId: TENANT,
      status: SessionStatus.DROPPED_IN_CALL,
      now: T0,
      billCategory: 'FAILED',
      billAmountPaise: 500,
      event: {
        type: SessionEventType.CALL_ENDED,
        actorType: 'SYSTEM',
        actorId: null,
        payload: { to: SessionStatus.DROPPED_IN_CALL, reason: 'customer_disconnected' },
      },
    });

  /**
   * The customer abort path: guarded on version and status, and it bills.
   *
   * Rs 5 in the same transaction as the transition, exactly as the verdict and
   * the sweeper do. Racing it against a verdict is the sharpest test of that,
   * because both contenders now want to insert into `billing_entries` and only
   * one transition can commit.
   */
  const abortOn = (repo: DrizzleSessionRepository, sessionId: string) =>
    repo.abortSession({
      sessionId,
      tenantId: TENANT,
      expectedStatus: SessionStatus.IN_CALL,
      expectedVersion: 1,
      status: SessionStatus.ABORTED,
      now: T0,
      billCategory: 'FAILED',
      billAmountPaise: 500,
      events: [
        {
          type: SessionEventType.SESSION_ABORTED,
          actorType: 'CUSTOMER',
          actorId: null,
          payload: { to: SessionStatus.ABORTED, reason: 'CUSTOMER_ABORT' },
        },
        {
          type: SessionEventType.BILLING_CREATED,
          actorType: 'SYSTEM',
          actorId: null,
          payload: { category: 'FAILED', amount_paise: 500 },
        },
      ],
    });

  const countRows = async (sessionId: string) => {
    const [billing, events, checklist, outbox, summaries, [row]] = await Promise.all([
      db
        .select({ id: billingEntries.sessionId })
        .from(billingEntries)
        .where(eq(billingEntries.sessionId, sessionId)),
      db
        .select({ type: sessionEvents.eventType })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId)),
      db
        .select({ key: sessionChecklistItems.itemKey })
        .from(sessionChecklistItems)
        .where(eq(sessionChecklistItems.sessionId, sessionId)),
      db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(eq(webhookEvents.sessionId, sessionId)),
      db
        .select({ id: sessionAiSummaries.sessionId })
        .from(sessionAiSummaries)
        .where(eq(sessionAiSummaries.sessionId, sessionId)),
      db
        .select({ status: sessions.status, verdict: sessions.verdict })
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ]);

    return {
      billing: billing.length,
      verdictEvents: events.filter((event) => event.type === SessionEventType.VERDICT_SUBMITTED)
        .length,
      endedEvents: events.filter((event) => event.type === SessionEventType.CALL_ENDED).length,
      abortEvents: events.filter((event) => event.type === SessionEventType.SESSION_ABORTED).length,
      checklist: checklist.length,
      outbox: outbox.length,
      summaries: summaries.length,
      status: row?.status ?? null,
      verdict: row?.verdict ?? null,
    };
  };

  /** Report a failing round once rather than once per round. */
  const all = <T>(rounds: readonly T[], predicate: (round: T) => boolean): boolean =>
    rounds.every(predicate);

  try {
    await db.insert(tenants).values({
      id: TENANT,
      slug: `vvr-${runId}`,
      name: `verify verdict race ${runId}`,
      status: 'ACTIVE',
    });
    await db.insert(users).values({
      id: AGENT,
      tenantId: TENANT,
      email: `agent-${runId}@verify.local`,
      role: 'AGENT',
      status: 'ACTIVE',
    });
    await db
      .insert(checklistTemplates)
      .values({ id: TEMPLATE, tenantId: TENANT, version: 1, items: ITEMS, active: true });
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      tenantId: TENANT,
      url: 'http://127.0.0.1:4010/webhooks/vcip',
      secretRef: 'env:VCIP_VERIFY_SECRET',
      active: true,
    });

    // =================================================================== T36
    section(`[T36] two verdicts on two connections, ${String(ROUNDS)} rounds`);

    const duplicates: Awaited<ReturnType<typeof countRows>>[] = [];
    let bothCommitted = 0;
    let neitherCommitted = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const sessionId = await seedSession();

      // Both statements issued before either is awaited. This is the race.
      const [one, two] = await Promise.all([
        repoOne.submitVerdict(verdictCommand(sessionId, SessionStatus.APPROVED)),
        repoTwo.submitVerdict(verdictCommand(sessionId, SessionStatus.REJECTED)),
      ]);

      const won = [one, two].filter((outcome) => outcome.kind === 'COMMITTED').length;
      if (won === 2) bothCommitted += 1;
      if (won === 0) neitherCommitted += 1;

      duplicates.push(await countRows(sessionId));
    }

    check(bothCommitted === 0, 'never two winners: the second UPDATE matched nothing');
    check(neitherCommitted === 0, 'never nought winners: somebody always commits');
    check(
      all(duplicates, (row) => row.billing === 1),
      'exactly one billing row, every round',
    );
    check(
      all(duplicates, (row) => row.verdictEvents === 1),
      'exactly one VERDICT_SUBMITTED',
    );
    check(
      all(duplicates, (row) => row.outbox === 1),
      'exactly one outbox row',
    );
    check(
      all(duplicates, (row) => row.checklist === ITEMS.length),
      'one set of checklist answers',
    );
    check(
      all(duplicates, (row) => row.summaries === 1),
      'one AI summary',
    );
    check(
      all(duplicates, (row) => row.status === row.verdict),
      'the status and the verdict agree — one decision, not a mix of two',
    );
    check(
      all(
        duplicates,
        (row) => row.status === SessionStatus.APPROVED || row.status === SessionStatus.REJECTED,
      ),
      'the session holds one of the two verdicts asked for',
    );

    // =================================================================== T37
    section(`[T37] a verdict against a disconnect, ${String(ROUNDS)} rounds`);

    const disconnects: Awaited<ReturnType<typeof countRows>>[] = [];
    let verdictWins = 0;
    let disconnectWins = 0;
    let bothWon = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const sessionId = await seedSession();

      // Alternate which statement is *issued* first — not merely which
      // connection carries it. Both transactions are open together either way;
      // what changes is which one takes the row lock, and both orders have to
      // produce a single winner or the guard only works one way round.
      const verdictFirst = round % 2 === 0;
      let verdict;
      let ended;
      if (verdictFirst) {
        const first = repoOne.submitVerdict(verdictCommand(sessionId));
        const second = endCallOn(repoTwo, sessionId);
        [verdict, ended] = await Promise.all([first, second]);
      } else {
        const first = endCallOn(repoOne, sessionId);
        const second = repoTwo.submitVerdict(verdictCommand(sessionId));
        [ended, verdict] = await Promise.all([first, second]);
      }

      if (verdict.kind === 'COMMITTED') verdictWins += 1;
      if (ended !== null) disconnectWins += 1;
      if (verdict.kind === 'COMMITTED' && ended !== null) bothWon += 1;

      disconnects.push(await countRows(sessionId));
    }

    check(bothWon === 0, 'the verdict and the disconnect never both commit');
    check(verdictWins + disconnectWins === ROUNDS, 'exactly one of the two wins each round');
    check(
      all(disconnects, (row) => row.billing === 1),
      'exactly one billing row, every round',
    );
    check(
      all(
        disconnects,
        (row) =>
          row.status === SessionStatus.APPROVED || row.status === SessionStatus.DROPPED_IN_CALL,
      ),
      'the session ends as one terminal outcome, not a hybrid',
    );
    check(
      all(disconnects, (row) => row.verdictEvents + row.endedEvents === 1),
      'exactly one of VERDICT_SUBMITTED and CALL_ENDED is in the history',
    );
    check(
      all(disconnects, (row) =>
        row.status === SessionStatus.APPROVED
          ? row.verdict === SessionStatus.APPROVED && row.checklist === ITEMS.length
          : row.verdict === null && row.checklist === 0,
      ),
      'the loser wrote nothing: no verdict and no checklist behind a dropped call',
    );
    check(
      all(disconnects, (row) =>
        row.status === SessionStatus.APPROVED ? row.outbox === 1 : row.outbox === 0,
      ),
      'no session.completed is queued for a call the agent never completed',
    );
    // Which side wins a genuine race is not ours to choose: both statements
    // carry the same correlated subquery for `talk_ms`, so the lock goes to
    // whichever plan reaches the row first, and that varies run to run. The
    // invariants above hold either way, which is the point. Reported, not
    // asserted -- an assertion on it would be a flake, and a flaky race test is
    // worse than none because it teaches people to re-run until it is green.
    process.stdout.write(
      `   note  the verdict won ${String(verdictWins)} of ${String(ROUNDS)} rounds,` +
        ` the disconnect ${String(disconnectWins)}\n`,
    );

    // Both orders, deterministically. The loser's behaviour is the half of D17
    // that matters to a caller, so it is proved by sequencing rather than left
    // to whichever way the race happened to fall.
    section('[T37] each side losing, deterministically');

    const verdictFirstId = await seedSession();
    const won = await repoOne.submitVerdict(verdictCommand(verdictFirstId));
    const lateDisconnect = await endCallOn(repoTwo, verdictFirstId);
    const afterVerdict = await countRows(verdictFirstId);

    check(won.kind === 'COMMITTED', 'the verdict commits when it arrives first');
    check(lateDisconnect === null, 'a disconnect arriving after it matches nothing');
    check(afterVerdict.status === SessionStatus.APPROVED, 'the session keeps the verdict');
    check(afterVerdict.billing === 1, 'and is charged once, at the verdict rate');
    check(afterVerdict.endedEvents === 0, 'no CALL_ENDED is written behind a committed verdict');

    const disconnectFirstId = await seedSession();
    const ended = await endCallOn(repoOne, disconnectFirstId);
    const lateVerdict = await repoTwo.submitVerdict(verdictCommand(disconnectFirstId));
    const afterDisconnect = await countRows(disconnectFirstId);

    check(ended !== null, 'the disconnect commits when it arrives first');
    check(lateVerdict.kind === 'LOST', 'a verdict arriving after it is refused (409 to the agent)');
    check(
      afterDisconnect.status === SessionStatus.DROPPED_IN_CALL,
      'the session keeps the dropped outcome',
    );
    check(afterDisconnect.billing === 1, 'and is charged once, at the dropped rate');
    check(
      afterDisconnect.verdict === null &&
        afterDisconnect.checklist === 0 &&
        afterDisconnect.outbox === 0,
      'the refused verdict wrote no verdict, no checklist and no outbox row',
    );

    // ============================================================== D17 abort
    section(`[D17] a verdict against a customer abort, ${String(ROUNDS)} rounds`);

    const aborts: Awaited<ReturnType<typeof countRows>>[] = [];
    let abortBothWon = 0;
    let abortWinners = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const sessionId = await seedSession();

      const verdictFirst = round % 2 === 0;
      let verdict;
      let aborted;
      if (verdictFirst) {
        const first = repoOne.submitVerdict(verdictCommand(sessionId));
        const second = abortOn(repoTwo, sessionId);
        [verdict, aborted] = await Promise.all([first, second]);
      } else {
        const first = abortOn(repoOne, sessionId);
        const second = repoTwo.submitVerdict(verdictCommand(sessionId));
        [aborted, verdict] = await Promise.all([first, second]);
      }

      if (verdict.kind === 'COMMITTED' && aborted !== null) abortBothWon += 1;
      if (aborted !== null) abortWinners += 1;

      aborts.push(await countRows(sessionId));
    }

    check(abortBothWon === 0, 'the verdict and the abort never both commit');
    check(
      all(
        aborts,
        (row) => row.status === SessionStatus.APPROVED || row.status === SessionStatus.ABORTED,
      ),
      'the session ends as one terminal outcome',
    );
    check(
      all(aborts, (row) => row.verdictEvents + row.abortEvents === 1),
      'exactly one of VERDICT_SUBMITTED and SESSION_ABORTED is in the history',
    );
    check(
      all(aborts, (row) => row.billing === 1),
      // Whichever side won. This assertion used to say the opposite -- that a
      // winning abort was charged nothing -- because the abort path reported an
      // amount and wrote no ledger row. Fixing that is what makes the invariant
      // uniform: every terminal outcome past the queue carries exactly one
      // charge, no matter which writer got there first.
      'exactly one billing row whichever side won',
    );
    process.stdout.write(
      `   note  the abort won ${String(abortWinners)} of ${String(ROUNDS)} rounds\n`,
    );
  } finally {
    for (const sessionId of seeded) {
      await db.delete(webhookEvents).where(eq(webhookEvents.sessionId, sessionId));
      await db.delete(billingEntries).where(eq(billingEntries.sessionId, sessionId));
      await db.delete(sessionAiSummaries).where(eq(sessionAiSummaries.sessionId, sessionId));
      await db.delete(sessionChecklistItems).where(eq(sessionChecklistItems.sessionId, sessionId));
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, ENDPOINT));
    await db.delete(checklistTemplates).where(eq(checklistTemplates.id, TEMPLATE));
    await db.delete(users).where(inArray(users.id, [AGENT]));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
    await Promise.all([clientOne.end(), clientTwo.end(), clientRead.end()]);
  }

  process.stdout.write(`\n=== RESULT: ${String(passed)} passed, ${String(failed)} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stdout.write(`\nVERIFY FAILED: ${String(error)}\n`);
  process.exit(1);
});
