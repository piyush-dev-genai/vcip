/**
 * The queue projection against real PostgreSQL and real Redis.
 *
 * Several of T15's properties are claims about two servers agreeing, and no
 * fake can establish them: that `ZADD` at an unchanged score really does leave
 * a member where it was, that `ZRANK` orders by score the way FIFO needs, that
 * two tenants' keys are genuinely separate keyspaces, and that a session
 * committed to PostgreSQL and missing from Redis is restored to its original
 * place. Everything provable without a server is in `src/queue/*.spec.ts`.
 *
 * Like `verify-events.ts`, this lives in `scripts/` rather than `db/`, so that
 * `git status -- apps/api/db/` stays a clean "no schema change" signal.
 *
 * PostgreSQL work happens inside one transaction that is rolled back at the
 * end. Redis has no transaction to roll back, so every key this script touches
 * is namespaced by a run id and deleted in a `finally` — the seeded demo data
 * and any real queue are never touched.
 *
 *   pnpm --filter @vcip/api db:verify-queue
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { SessionStatus } from '@vcip/shared';
import { createLogger } from '../src/common/logging/logger.js';
import { queueKey, scoreFor } from '../src/queue/queue.keys.js';
import type { QueueEntry, QueueMember, QueueRepository } from '../src/queue/queue.repository.js';
import { RedisQueueRepository } from '../src/queue/queue.repository.js';
import type { WaitingAhead } from '../src/queue/queue.service.js';
import { QueueService } from '../src/queue/queue.service.js';
import type { SessionRow } from '../src/sessions/session.repository.js';
import { DrizzleSessionRepository } from '../src/sessions/session.repository.js';

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

const section = (label: string): void => {
  process.stdout.write(`\n${label}\n`);
};

/**
 * Raw `execute` returns driver-shaped rows.
 *
 * A `timestamptz` may arrive as a `Date` or as an ISO string depending on the
 * parser in play, and the property under test is the instant, not the
 * JavaScript type it happened to arrive as. Same coercion as
 * `verify-events.ts`.
 */
const asDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

/** A repository that fails on demand, for the post-commit failure case. */
class FaultyQueueRepository implements QueueRepository {
  failing = false;

  constructor(private readonly inner: QueueRepository) {}

  add(entry: QueueEntry): Promise<void> {
    if (this.failing) return Promise.reject(new Error('ECONNREFUSED'));
    return this.inner.add(entry);
  }

  rank(member: QueueMember): Promise<number | null> {
    if (this.failing) return Promise.reject(new Error('ECONNREFUSED'));
    return this.inner.rank(member);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  const redis = new Redis(redisUrl, { db: Number(process.env['REDIS_DB'] ?? 0) });

  // Every key this run creates carries this id, so cleanup can be exact and a
  // real queue on the same Redis is never at risk.
  const runId = randomUUID();
  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();
  const touchedKeys = new Set<string>();

  /**
   * Everybody ranked ahead is still waiting.
   *
   * The baseline for the ordering checks: with no stale members a position is
   * the rank plus one, so every FIFO property below is asserted against exactly
   * the numbers it always was.
   */
  const allWaiting: WaitingAhead = async (ids) => ids.length;

  /** Only these sessions are still `QUEUED`, as far as the caller can tell. */
  const onlyWaiting =
    (...stillQueued: readonly string[]): WaitingAhead =>
    async (ids) => {
      const waiting = new Set(stillQueued);
      return ids.filter((id) => waiting.has(id)).length;
    };

  const repository = new RedisQueueRepository(redis);
  const faulty = new FaultyQueueRepository(repository);
  const logger = createLogger({ level: 'silent' });
  const service = new QueueService(repository, logger);
  const faultyService = new QueueService(faulty, logger);

  /** A session row, built without touching the database. */
  const row = (overrides: Partial<SessionRow> = {}): SessionRow => {
    const base: SessionRow = {
      id: randomUUID(),
      tenantId: TENANT_A,
      externalRef: `verify-${runId}`,
      status: SessionStatus.QUEUED,
      version: 2,
      // Namespaced so the ZSET key cannot collide with a real `en` queue.
      language: `qa-${runId.slice(0, 8)}`,
      roomName: null,
      checklistTemplateId: null,
      consentOk: true,
      consentVersion: 'v1',
      consentAt: new Date(),
      preflightOk: true,
      preflightAt: new Date(),
      geoOk: true,
      gpsAccuracyM: 20,
      geoCheckedAt: new Date(),
      ipCountry: 'IN',
      queuedAt: new Date(),
      connectedAt: null,
      endedAt: null,
      verdict: null,
      exportStatus: 'NOT_STARTED',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    touchedKeys.add(queueKey(base.tenantId, base.language));
    return base;
  };

  try {
    section('[ping] redis reachable');
    check((await redis.ping()) === 'PONG', 'redis answers PING');

    // ------------------------------------------------------ key and score

    section('[key] queue:{tenant_id}:{language}');
    const first = row({ queuedAt: new Date(Date.now() - 3 * 60_000) });
    const key = queueKey(first.tenantId, first.language);

    check(
      (await service.enqueue(first, allWaiting)) === 1,
      'an enqueued session reports position 1',
    );
    check((await redis.exists(key)) === 1, `the ZSET ${key.slice(0, 24)}… exists`);
    check((await redis.type(key)) === 'zset', 'the key is a sorted set');
    check((await redis.zcard(key)) === 1, 'it holds exactly one member');

    const storedScore = await redis.zscore(key, first.id);
    check(
      Number(storedScore) === first.queuedAt?.getTime(),
      'the score equals sessions.queued_at in milliseconds',
    );
    check(
      Number(storedScore) < Date.now() - 60_000,
      'the score is the historical queued_at, not the time of the enqueue',
    );

    // ---------------------------------------------------------- ordering

    section('[fifo] ordering by queued_at');
    const older = row({ queuedAt: new Date(Date.now() - 10 * 60_000), language: first.language });
    const newer = row({ queuedAt: new Date(Date.now() - 1 * 60_000), language: first.language });
    // Inserted newest-first, so any FIFO result comes from the score.
    await service.enqueue(newer, allWaiting);
    await service.enqueue(older, allWaiting);

    check(
      (await service.positionFor(older, allWaiting)) === 1,
      'the oldest queued_at is position 1',
    );
    check((await service.positionFor(first, allWaiting)) === 2, 'the middle session is position 2');
    check((await service.positionFor(newer, allWaiting)) === 3, 'the newest is position 3');

    const ordered = await redis.zrange(key, 0, -1);
    check(
      ordered[0] === older.id && ordered[2] === newer.id,
      'ZRANGE returns the members in queued_at order',
    );

    section('[fifo] equal scores are deterministic');
    const sameTime = new Date(Date.now() - 5 * 60_000);
    const tieKeyLanguage = `${first.language}-tie`;
    const tieA = row({
      queuedAt: sameTime,
      language: tieKeyLanguage,
      id: `00000000-${runId.slice(9)}`,
    });
    const tieB = row({
      queuedAt: sameTime,
      language: tieKeyLanguage,
      id: `ffffffff-${runId.slice(9)}`,
    });
    await service.enqueue(tieB, allWaiting);
    await service.enqueue(tieA, allWaiting);
    const tieFirst = await service.positionFor(tieA, allWaiting);
    const tieSecond = await service.positionFor(tieB, allWaiting);
    check(tieFirst === 1 && tieSecond === 2, 'equal scores fall back to lexical member order');
    check(
      (await service.positionFor(tieA, allWaiting)) === tieFirst,
      'the same queue state yields the same position on a repeat read',
    );

    // -------------------------------------------------------- idempotency

    section('[idempotent] repeated enqueue');
    const before = await redis.zcard(key);
    await service.enqueue(first, allWaiting);
    await service.enqueue(first, allWaiting);
    check((await redis.zcard(key)) === before, 'a repeated ZADD does not duplicate the member');
    check(
      Number(await redis.zscore(key, first.id)) === first.queuedAt?.getTime(),
      'a repeated ZADD does not move the score',
    );

    // ----------------------------------------------------------- isolation

    section('[isolation] tenants and languages');
    const otherTenant = row({ tenantId: TENANT_B, language: first.language });
    await service.enqueue(otherTenant, allWaiting);
    check(
      (await service.positionFor(otherTenant, allWaiting)) === 1,
      'another tenant with the same language starts its own queue at position 1',
    );
    check(
      (await redis.zscore(key, otherTenant.id)) === null,
      "the other tenant's session is absent from this tenant's key",
    );
    check(
      (await redis.zcard(queueKey(TENANT_B, first.language))) === 1,
      "the other tenant's key holds only its own session",
    );

    const otherLanguage = row({ language: `${first.language}-x` });
    await service.enqueue(otherLanguage, allWaiting);
    check(
      (await service.positionFor(otherLanguage, allWaiting)) === 1,
      'another language starts its own queue at position 1',
    );

    // --------------------------------------------- post-commit failure

    section('[failure] redis unavailable after the database commits');
    const stranded = row({
      queuedAt: new Date(Date.now() - 8 * 60_000),
      language: `${first.language}-strand`,
    });
    faulty.failing = true;
    const failedPosition = await faultyService.enqueue(stranded, allWaiting);
    check(failedPosition === null, 'a failed enqueue reports no position rather than throwing');
    check(failedPosition !== 0, 'it does not report position zero');

    const strandedKey = queueKey(stranded.tenantId, stranded.language);
    check((await redis.exists(strandedKey)) === 0, 'nothing was written to Redis');

    // ------------------------------------------------- lazy reconciliation

    section('[reconcile] restoring a queued session Redis never received');
    faulty.failing = false;
    // A newer session arrives first, while the stranded one is still missing.
    const arrivedLater = row({
      queuedAt: new Date(Date.now() - 2 * 60_000),
      language: stranded.language,
    });
    await service.enqueue(arrivedLater, allWaiting);
    check(
      (await service.positionFor(arrivedLater, allWaiting)) === 1,
      'the newer session is alone at 1',
    );

    const restored = await service.positionFor(stranded, allWaiting);
    check(restored === 1, 'the reconciled session takes the place its queued_at earned');
    check(
      (await service.positionFor(arrivedLater, allWaiting)) === 2,
      'the session that arrived later moves to 2',
    );
    check(
      Number(await redis.zscore(strandedKey, stranded.id)) === stranded.queuedAt?.getTime(),
      'reconciliation used the original queued_at, not the current time',
    );

    const countAfterOne = await redis.zcard(strandedKey);
    await service.reconcile(stranded, allWaiting);
    await service.reconcile(stranded, allWaiting);
    check(
      (await redis.zcard(strandedKey)) === countAfterOne,
      'reconciling repeatedly does not duplicate the member',
    );

    // ------------------------------------------ reconciliation is gated

    section('[reconcile] refuses any status that is not QUEUED');
    for (const status of [
      SessionStatus.CREATED,
      SessionStatus.OFFERED,
      SessionStatus.IN_CALL,
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
      SessionStatus.PREFLIGHT_FAILED,
    ]) {
      const gated = row({ status, language: `${first.language}-gate` });
      const gatedKey = queueKey(gated.tenantId, gated.language);
      const position = await service.reconcile(gated, allWaiting);
      check(
        position === null && (await redis.zscore(gatedKey, gated.id)) === null,
        `${status} is not reinserted`,
      );
    }

    // --------------------------------------- positions skip stale members

    section('[position] members left behind by a claim are not counted');
    // T18 does not ZREM on claim, so the ZSET holds members whose sessions are
    // long past QUEUED. Against a real server: ZRANGE must return exactly the
    // members ahead, and the position must reflect who is still waiting.
    const lineKey = queueKey(TENANT_A, `line-${runId.slice(0, 8)}`);
    touchedKeys.add(lineKey);
    const lineLanguage = `line-${runId.slice(0, 8)}`;
    const ahead1 = row({
      id: `aaaaaaaa-${runId.slice(9)}`,
      language: lineLanguage,
      queuedAt: new Date(Date.now() - 3000),
    });
    const ahead2 = row({
      id: `bbbbbbbb-${runId.slice(9)}`,
      language: lineLanguage,
      queuedAt: new Date(Date.now() - 2000),
    });
    const mine = row({
      id: `cccccccc-${runId.slice(9)}`,
      language: lineLanguage,
      queuedAt: new Date(Date.now() - 1000),
    });
    for (const waiting of [ahead1, ahead2, mine]) await service.enqueue(waiting, allWaiting);

    check((await service.positionFor(mine, allWaiting)) === 3, 'three waiting: the last is at 3');
    check(
      (await service.positionFor(mine, onlyWaiting(mine.id))) === 1,
      'with both ahead claimed, the last customer is at 1',
    );
    check(
      (await service.positionFor(mine, onlyWaiting(ahead2.id, mine.id))) === 2,
      'the position counts down as customers ahead are served',
    );
    check(
      (await redis.zcard(lineKey)) === 3,
      'and every member is still in the ZSET — reading a position removes nothing',
    );

    // What the filter is actually handed, from the real ZRANGE.
    let offered: readonly string[] = [];
    await service.positionFor(mine, async (ids) => {
      offered = ids;
      return ids.length;
    });
    check(
      offered.length === 2 && offered[0] === ahead1.id && offered[1] === ahead2.id,
      'the members offered for confirmation are exactly those ranked ahead, in order',
    );
    check(!offered.includes(mine.id), 'the session itself is never among them');

    const frontRankCalls = repository instanceof RedisQueueRepository;
    let askedForFront = 0;
    check(
      (await service.positionFor(ahead1, async (ids) => {
        askedForFront += 1;
        return ids.length;
      })) === 1 &&
        askedForFront === 0 &&
        frontRankCalls,
      'the session at the front is position 1 without any confirmation at all',
    );

    check(
      (await service.positionFor(mine, () => Promise.reject(new Error('ECONNREFUSED')))) === null,
      'an unavailable confirmation reports no position rather than the raw rank',
    );

    // ------------------------------------------ postgresql remains truth

    section('[postgresql] the transition and its event, then rollback');
    await db
      .transaction(async (tx) => {
        const tenantId = randomUUID();
        const sessionId = randomUUID();
        await tx.execute(sql`
        INSERT INTO tenants (id, slug, name, status)
        VALUES (${tenantId}::uuid, ${`verify-queue-${runId}`}, 'verify-queue', 'ACTIVE')`);
        await tx.execute(sql`
        INSERT INTO sessions (id, tenant_id, external_ref, status, language, consent_ok, preflight_ok, geo_ok)
        VALUES (${sessionId}::uuid, ${tenantId}::uuid, ${`verify-${runId}`}, 'CREATED', 'en', true, true, true)`);

        const queuedAt = new Date();
        await tx.execute(sql`
        UPDATE sessions
           SET status = 'QUEUED', queued_at = ${queuedAt.toISOString()}::timestamptz, version = version + 1
         WHERE id = ${sessionId}::uuid AND tenant_id = ${tenantId}::uuid AND status = 'CREATED'`);
        await tx.execute(sql`
        INSERT INTO session_events (tenant_id, session_id, event_type, actor_type, actor_id, payload, server_ts)
        VALUES (${tenantId}::uuid, ${sessionId}::uuid, 'SESSION_QUEUED', 'CUSTOMER', NULL, ${JSON.stringify({ language: 'en' })}::jsonb, now())`);

        const stored = await tx.execute<{ status: string; queued_at: Date; version: number }>(sql`
        SELECT status, queued_at, version FROM sessions WHERE id = ${sessionId}::uuid`);
        const persisted = stored[0];
        check(persisted?.status === 'QUEUED', 'the session is QUEUED inside the transaction');
        check(persisted?.queued_at !== null, 'queued_at is set');
        check(Number(persisted?.version) === 2, 'version was incremented');

        const events = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM session_events
         WHERE session_id = ${sessionId}::uuid AND event_type = 'SESSION_QUEUED'`);
        check(Number(events[0]?.n) === 1, 'exactly one SESSION_QUEUED event was appended');

        // The score the queue would use is the value PostgreSQL stored, read back
        // from the row rather than taken from the variable that produced it.
        //
        // Coerced, because a raw `execute` returns driver-shaped rows: a
        // `timestamptz` may arrive as a Date or as an ISO string depending on the
        // parser in play, and the property under test is the instant, not the
        // JavaScript type it arrived as.
        const readBack = asDate(persisted?.queued_at);
        check(
          readBack !== null && scoreFor(readBack) === queuedAt.getTime(),
          'the Redis score would equal the stored queued_at exactly',
        );

        // ------------------------------------------------------------------
        // The filter against the real database, over a real ZSET.
        //
        // Two sessions in one tenant's queue: this one, still QUEUED, and one
        // moved to OFFERED the way a claim moves it. Redis holds both members,
        // because nothing removed either. The position must count one.
        const claimedId = randomUUID();
        await tx.execute(sql`
        INSERT INTO sessions (id, tenant_id, external_ref, status, language, consent_ok, preflight_ok, geo_ok, queued_at, offered_to_agent_id)
        VALUES (${claimedId}::uuid, ${tenantId}::uuid, ${`verify-claimed-${runId}`}, 'OFFERED', 'en', true, true, true, ${new Date(queuedAt.getTime() - 1000).toISOString()}::timestamptz, NULL)`);

        const dbRepo = new DrizzleSessionRepository(tx as unknown as PostgresJsDatabase, {
          append: () => {
            throw new Error('a position lookup must not append an event');
          },
        });
        /** The real thing: `findQueued`, tenant and status in the WHERE clause. */
        const fromDatabase: WaitingAhead = async (ids) =>
          (await dbRepo.findQueued(tenantId, ids)).length;

        const dbKey = queueKey(tenantId, 'en');
        touchedKeys.add(dbKey);
        await redis.zadd(dbKey, queuedAt.getTime() - 1000, claimedId);
        await redis.zadd(dbKey, queuedAt.getTime(), sessionId);

        const dbRow = row({ id: sessionId, tenantId, language: 'en', queuedAt });
        check(
          (await service.positionFor(dbRow, allWaiting)) === 2,
          'unfiltered, the claimed session ahead would put this customer at 2',
        );
        check(
          (await service.positionFor(dbRow, fromDatabase)) === 1,
          'PostgreSQL says the one ahead is OFFERED, so the customer is at 1',
        );
        check((await redis.zcard(dbKey)) === 2, 'and both members are still in Redis');

        check(
          (await dbRepo.findQueued(randomUUID(), [sessionId, claimedId])).length === 0,
          'the confirmation is tenant-scoped: another tenant counts nothing (I8)',
        );

        // Roll back: nothing this block created outlives the script.
        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    const leftover = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM sessions WHERE external_ref = ${`verify-${runId}`}`);
    check(Number(leftover[0]?.n) === 0, 'the rolled-back session left no row behind');
    check(
      (await redis.zscore(key, `never-enqueued-${runId}`)) === null,
      'a rolled-back transition produced no Redis membership',
    );
  } finally {
    // Redis has no rollback. Delete exactly the keys this run created.
    if (touchedKeys.size > 0) await redis.del(...touchedKeys);
    await redis.quit();
    await client.end();
  }

  section(
    failed === 0
      ? `ALL QUEUE CHECKS PASSED (${passed})`
      : `${failed} CHECK(S) FAILED (${passed} passed)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

/** Thrown to roll back the PostgreSQL block without reporting an error. */
class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

main().catch((error: unknown) => {
  process.stdout.write(
    `\nVERIFY QUEUE FAILED: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exit(1);
});
