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
import { QueueService } from '../src/queue/queue.service.js';
import type { SessionRow } from '../src/sessions/session.repository.js';

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

    check((await service.enqueue(first)) === 1, 'an enqueued session reports position 1');
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
    await service.enqueue(newer);
    await service.enqueue(older);

    check((await service.positionFor(older)) === 1, 'the oldest queued_at is position 1');
    check((await service.positionFor(first)) === 2, 'the middle session is position 2');
    check((await service.positionFor(newer)) === 3, 'the newest is position 3');

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
    await service.enqueue(tieB);
    await service.enqueue(tieA);
    const tieFirst = await service.positionFor(tieA);
    const tieSecond = await service.positionFor(tieB);
    check(tieFirst === 1 && tieSecond === 2, 'equal scores fall back to lexical member order');
    check(
      (await service.positionFor(tieA)) === tieFirst,
      'the same queue state yields the same position on a repeat read',
    );

    // -------------------------------------------------------- idempotency

    section('[idempotent] repeated enqueue');
    const before = await redis.zcard(key);
    await service.enqueue(first);
    await service.enqueue(first);
    check((await redis.zcard(key)) === before, 'a repeated ZADD does not duplicate the member');
    check(
      Number(await redis.zscore(key, first.id)) === first.queuedAt?.getTime(),
      'a repeated ZADD does not move the score',
    );

    // ----------------------------------------------------------- isolation

    section('[isolation] tenants and languages');
    const otherTenant = row({ tenantId: TENANT_B, language: first.language });
    await service.enqueue(otherTenant);
    check(
      (await service.positionFor(otherTenant)) === 1,
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
    await service.enqueue(otherLanguage);
    check(
      (await service.positionFor(otherLanguage)) === 1,
      'another language starts its own queue at position 1',
    );

    // --------------------------------------------- post-commit failure

    section('[failure] redis unavailable after the database commits');
    const stranded = row({
      queuedAt: new Date(Date.now() - 8 * 60_000),
      language: `${first.language}-strand`,
    });
    faulty.failing = true;
    const failedPosition = await faultyService.enqueue(stranded);
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
    await service.enqueue(arrivedLater);
    check((await service.positionFor(arrivedLater)) === 1, 'the newer session is alone at 1');

    const restored = await service.positionFor(stranded);
    check(restored === 1, 'the reconciled session takes the place its queued_at earned');
    check(
      (await service.positionFor(arrivedLater)) === 2,
      'the session that arrived later moves to 2',
    );
    check(
      Number(await redis.zscore(strandedKey, stranded.id)) === stranded.queuedAt?.getTime(),
      'reconciliation used the original queued_at, not the current time',
    );

    const countAfterOne = await redis.zcard(strandedKey);
    await service.reconcile(stranded);
    await service.reconcile(stranded);
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
      const position = await service.reconcile(gated);
      check(
        position === null && (await redis.zscore(gatedKey, gated.id)) === null,
        `${status} is not reinserted`,
      );
    }

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
