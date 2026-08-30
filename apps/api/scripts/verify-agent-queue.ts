/**
 * The agent queue view against real PostgreSQL and real Redis.
 *
 * The unit and HTTP suites prove the rules against fakes, and a fake queue can
 * only be as right as the person who wrote it. Several of T17's properties are
 * claims about a real server:
 *
 *   - that `ZRANGE key 0 N-1 WITHSCORES` really returns the N *oldest* members
 *     with parseable scores, and really stops at N,
 *   - that a real ZSET really breaks equal scores lexically by member, which is
 *     the tiebreak the merged view reproduces,
 *   - that `queue:{tenant}:{language}` really isolates two tenants holding the
 *     same session-shaped ids at the same language,
 *   - that a real `id IN (...)` with a tenant and status predicate really drops
 *     a stale member rather than returning a row the ORM then has to filter,
 *   - and that reading all of this really writes nothing: no row, no version
 *     bump, no `session_events`, no `billing_entries`.
 *
 * The last one is the reason a mocked test could never settle this. "No write
 * happened" is a statement about a database, and only a database can make it.
 *
 * Like `verify-events.ts`, `verify-queue.ts`, and `verify-presence.ts`, this
 * lives in `scripts/` rather than `db/`, so `git status -- apps/api/db/` stays
 * a clean "no schema change" signal.
 *
 * PostgreSQL work happens inside one transaction that is rolled back, so the
 * tenants, agents, and sessions it needs never persist. Redis has no rollback,
 * so every key this run touches is deleted in a `finally`; the keys are built
 * from freshly generated tenant UUIDs, so they cannot collide with seeded data
 * or with a real queue.
 *
 *   pnpm --filter @vcip/api db:verify-agent-queue
 */

import { randomUUID } from 'node:crypto';
import { SessionStatus } from '@vcip/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { agentProfiles, sessions, tenants, users } from '../db/schema.js';
import { DrizzleAgentRepository } from '../src/agents/agent.repository.js';
import { AGENT_QUEUE_LIMIT } from '../src/agents/agent-queue.rules.js';
import { AgentQueueService } from '../src/agents/agent-queue.service.js';
import { ActorRole } from '../src/common/auth/auth-context.js';
import type { AgentActor } from '../src/common/auth/auth-context.js';
import { createLogger } from '../src/common/logging/logger.js';
import { queueKey } from '../src/queue/queue.keys.js';
import { RedisQueueRepository } from '../src/queue/queue.repository.js';
import { DrizzleSessionRepository } from '../src/sessions/session.repository.js';
import type { SessionEventWriter } from '../src/common/events/index.js';

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
 * An event writer that refuses.
 *
 * `DrizzleSessionRepository` requires one. The queue view never writes an
 * event, so any call here is a defect — and this turns it into a thrown error
 * rather than a row nobody notices.
 */
const refusingEventWriter: SessionEventWriter = {
  append: () => {
    throw new Error('the agent queue view must not append a session event');
  },
};

/** Thrown to roll back the PostgreSQL block without reporting an error. */
class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

const actor = (userId: string, tenantId: string): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

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

  const runId = randomUUID().slice(0, 8);
  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();
  const AGENT_EN_HI = randomUUID();
  const AGENT_TA = randomUUID();
  const AGENT_B = randomUUID();
  const ADMIN_A = randomUUID();

  // Every key this run could touch, deleted in the `finally`.
  const touchedKeys = new Set<string>();
  for (const tenantId of [TENANT_A, TENANT_B]) {
    for (const language of ['en', 'hi', 'ta']) touchedKeys.add(queueKey(tenantId, language));
  }

  const queueRepo = new RedisQueueRepository(redis);
  const logger = createLogger({ level: 'silent' });

  /** Frozen so wait_seconds is exact rather than racing the test. */
  const NOW = new Date('2026-08-31T12:00:00.000Z');
  const secondsAgo = (n: number): Date => new Date(NOW.getTime() - n * 1000);

  try {
    section('[ping] servers reachable');
    check((await redis.ping()) === 'PONG', 'redis answers PING');
    const [alive] = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
    check(Number(alive?.ok) === 1, 'postgresql answers a query');

    section('[keys] the queue key is tenant-scoped and never wildcarded');
    check(queueKey(TENANT_A, 'en') === `queue:${TENANT_A}:en`, 'the key is queue:{tenant}:{lang}');
    check(
      queueKey(TENANT_A, 'en') !== queueKey(TENANT_B, 'en'),
      'two tenants at the same language get different keys',
    );
    check(!queueKey(TENANT_A, 'en').includes('*'), 'the key contains no wildcard');
    check(queueKey(TENANT_A, 'EN') === queueKey(TENANT_A, 'en'), 'the language is normalised');

    await db
      .transaction(async (tx) => {
        // ------------------------------------------------------ fixtures

        await tx.insert(tenants).values([
          { id: TENANT_A, slug: `vq-a-${runId}`, name: `verify A ${runId}`, status: 'ACTIVE' },
          { id: TENANT_B, slug: `vq-b-${runId}`, name: `verify B ${runId}`, status: 'ACTIVE' },
        ]);

        await tx.insert(users).values([
          {
            id: AGENT_EN_HI,
            tenantId: TENANT_A,
            email: `enhi-${runId}@verify.local`,
            role: 'AGENT',
            status: 'ACTIVE',
          },
          {
            id: AGENT_TA,
            tenantId: TENANT_A,
            email: `ta-${runId}@verify.local`,
            role: 'AGENT',
            status: 'ACTIVE',
          },
          {
            id: AGENT_B,
            tenantId: TENANT_B,
            email: `b-${runId}@verify.local`,
            role: 'AGENT',
            status: 'ACTIVE',
          },
          {
            id: ADMIN_A,
            tenantId: TENANT_A,
            email: `admin-${runId}@verify.local`,
            role: 'TENANT_ADMIN',
            status: 'ACTIVE',
          },
        ]);

        // Deliberately mixed case on one profile: nothing normalises this
        // column on write, so the service has to.
        await tx.insert(agentProfiles).values([
          { userId: AGENT_EN_HI, languages: ['EN', 'hi'], maxConcurrent: 1 },
          { userId: AGENT_TA, languages: ['ta'], maxConcurrent: 2 },
          { userId: AGENT_B, languages: ['en'], maxConcurrent: 1 },
        ]);
        // ADMIN_A deliberately gets no agent_profiles row.

        const agentRepo = new DrizzleAgentRepository(tx);
        const sessionRepo = new DrizzleSessionRepository(tx, refusingEventWriter);
        const service = new AgentQueueService(queueRepo, sessionRepo, agentRepo, logger, () => NOW);

        /** Insert a session and place it in its queue at its own queued_at. */
        const seed = async (
          tenantId: string,
          language: string,
          status: SessionStatus,
          queuedAt: Date,
          priority = 0,
        ): Promise<string> => {
          const [row] = await tx
            .insert(sessions)
            .values({
              tenantId,
              externalRef: `vq-${runId}-${randomUUID().slice(0, 8)}`,
              status,
              language,
              priority,
              queuedAt,
            })
            .returning({ id: sessions.id });
          if (row === undefined) throw new Error('session insert failed');
          await queueRepo.add({
            tenantId,
            language,
            sessionId: row.id,
            score: queuedAt.getTime(),
          });
          return row.id;
        };

        const idsFor = async (who: AgentActor): Promise<string[]> =>
          (await service.view(who)).sessions.map((s) => s.session_id);

        // ------------------------------------------------ redis ordering
        section('[redis] the real ZSET orders and bounds the way the merge assumes');

        const enOld = await seed(TENANT_A, 'en', SessionStatus.QUEUED, secondsAgo(300));
        const hiMid = await seed(TENANT_A, 'hi', SessionStatus.QUEUED, secondsAgo(200));
        const enNew = await seed(TENANT_A, 'en', SessionStatus.QUEUED, secondsAgo(100));

        const enRange = await queueRepo.range(TENANT_A, 'en', AGENT_QUEUE_LIMIT);
        check(enRange.length === 2, 'ZRANGE returned both en members');
        check(enRange[0]?.sessionId === enOld, 'the oldest en member ranks first');
        check(
          enRange[0]?.score === secondsAgo(300).getTime(),
          'the score really is queued_at in milliseconds',
        );
        check(
          (await queueRepo.range(TENANT_A, 'en', 1)).length === 1,
          'a limit of one really returns one member, not the whole set',
        );
        check(
          (await queueRepo.range(TENANT_A, 'en', 0)).length === 0,
          'a limit of zero reads nothing rather than the whole set',
        );
        check(
          (await queueRepo.range(TENANT_A, 'fr', AGENT_QUEUE_LIMIT)).length === 0,
          'an absent queue key reads as empty, not as an error',
        );

        // ------------------------------------------------------ language
        section('[language] eligibility comes from agent_profiles');

        const merged = await idsFor(actor(AGENT_EN_HI, TENANT_A));
        check(merged.length === 3, 'the multi-language agent sees all three sessions');
        check(
          merged[0] === enOld && merged[1] === hiMid && merged[2] === enNew,
          'the merged list is FIFO across languages, not grouped by language',
        );
        check(
          merged.indexOf(hiMid) === 1,
          'a hi session sits between two en sessions by enqueue time',
        );

        const taOnly = await idsFor(actor(AGENT_TA, TENANT_A));
        check(taOnly.length === 0, 'the ta-only agent sees none of the en or hi sessions');

        const taSession = await seed(TENANT_A, 'ta', SessionStatus.QUEUED, secondsAgo(150));
        check(
          (await idsFor(actor(AGENT_TA, TENANT_A))).join() === taSession,
          'the ta-only agent sees exactly the ta session',
        );
        check(
          !(await idsFor(actor(AGENT_EN_HI, TENANT_A))).includes(taSession),
          'the en/hi agent does not see the ta session',
        );

        // The profile says `EN`; the key is `en`. Both had to be normalised.
        check(
          (await idsFor(actor(AGENT_EN_HI, TENANT_A))).includes(enOld),
          'a profile language stored as EN still matches the en queue',
        );

        const regional = await seed(TENANT_A, 'en-IN', SessionStatus.QUEUED, secondsAgo(250));
        check(
          !(await idsFor(actor(AGENT_EN_HI, TENANT_A))).includes(regional),
          'en-IN is a different queue from en, as R13 shards it',
        );
        touchedKeys.add(queueKey(TENANT_A, 'en-IN'));

        // ------------------------------------------------ tenant isolation
        section('[tenant] one tenant queue is invisible to another');

        const bSession = await seed(TENANT_B, 'en', SessionStatus.QUEUED, secondsAgo(500));
        const aIds = await idsFor(actor(AGENT_EN_HI, TENANT_A));
        const bIds = await idsFor(actor(AGENT_B, TENANT_B));

        check(!aIds.includes(bSession), 'the tenant A agent does not see the tenant B session');
        check(bIds.join() === bSession, 'the tenant B agent sees only its own session');
        check(
          bIds.every((id) => !aIds.includes(id)),
          'the two tenants share no session at all',
        );
        // The profile lookup is scoped by (user_id, tenant_id), so a token
        // naming a tenant this user does not belong to finds no profile and is
        // refused outright — it never reaches a queue read at all.
        let crossTenantRefused = false;
        try {
          await service.view(actor(AGENT_EN_HI, TENANT_B));
        } catch {
          crossTenantRefused = true;
        }
        check(
          crossTenantRefused,
          'a tenant A agent presenting a tenant B tenant id is refused, not answered',
        );

        // A member planted in tenant A's key whose row belongs to tenant B.
        // Redis alone would hand it over; the SQL tenant predicate must not.
        await queueRepo.add({
          tenantId: TENANT_A,
          language: 'en',
          sessionId: bSession,
          score: secondsAgo(500).getTime(),
        });
        check(
          !(await idsFor(actor(AGENT_EN_HI, TENANT_A))).includes(bSession),
          'a cross-tenant member planted in this tenant key is not returned',
        );

        // --------------------------------------------- postgres authority
        section('[postgres] a stale Redis member never becomes an eligible session');

        const stale: Array<[SessionStatus, string]> = [
          [SessionStatus.CREATED, 'CREATED'],
          [SessionStatus.PREFLIGHT_FAILED, 'PREFLIGHT_FAILED'],
          [SessionStatus.OFFERED, 'OFFERED'],
          [SessionStatus.IN_CALL, 'IN_CALL'],
          [SessionStatus.APPROVED, 'APPROVED'],
          [SessionStatus.REJECTED, 'REJECTED'],
          [SessionStatus.ABORTED, 'ABORTED'],
          [SessionStatus.DROPPED_QUEUED, 'DROPPED_QUEUED'],
          [SessionStatus.DROPPED_IN_CALL, 'DROPPED_IN_CALL'],
        ];
        const staleIds: string[] = [];
        for (const [status, label] of stale) {
          const id = await seed(TENANT_A, 'en', status, secondsAgo(400));
          staleIds.push(id);
          const visible = await idsFor(actor(AGENT_EN_HI, TENANT_A));
          check(!visible.includes(id), `a ${label} session in Redis is not returned`);
        }

        const membersNow = await queueRepo.range(TENANT_A, 'en', 100);
        check(
          staleIds.every((id) => membersNow.some((m) => m.sessionId === id)),
          'every stale member is still in Redis — T17 removes nothing',
        );

        // A member with no row at all.
        const ghost = randomUUID();
        await queueRepo.add({
          tenantId: TENANT_A,
          language: 'en',
          sessionId: ghost,
          score: secondsAgo(450).getTime(),
        });
        check(
          !(await idsFor(actor(AGENT_EN_HI, TENANT_A))).includes(ghost),
          'a member with no session row is not returned',
        );

        // QUEUED in PostgreSQL, absent from Redis: the documented limitation.
        const [orphan] = await tx
          .insert(sessions)
          .values({
            tenantId: TENANT_A,
            externalRef: `vq-orphan-${runId}`,
            status: SessionStatus.QUEUED,
            language: 'en',
            queuedAt: secondsAgo(600),
          })
          .returning({ id: sessions.id });
        check(
          orphan !== undefined && !(await idsFor(actor(AGENT_EN_HI, TENANT_A))).includes(orphan.id),
          'a queued session missing from Redis is invisible (no reconciliation on a GET)',
        );
        check(
          (await queueRepo.rank({
            tenantId: TENANT_A,
            language: 'en',
            sessionId: orphan?.id ?? '',
          })) === null,
          'and the view did not add it — the GET performed no ZADD',
        );

        // --------------------------------------------------- derived values
        section('[derived] wait_seconds and priority');

        const view = await service.view(actor(AGENT_EN_HI, TENANT_A));
        const oldest = view.sessions[0];
        check(oldest?.session_id === enOld, 'the oldest session is still first');
        check(oldest?.wait_seconds === 300, 'wait_seconds is derived from the server clock');
        check(
          view.sessions.every((s) => s.wait_seconds >= 0),
          'no wait_seconds is negative',
        );
        check(
          view.sessions.every((s) => Object.keys(s).length === 5),
          'each row carries exactly the five contract fields',
        );
        check(
          view.sessions.every((s) => !('position' in s) && !('external_ref' in s)),
          'no position and no external_ref reach the agent',
        );

        const priority = await seed(TENANT_A, 'en', SessionStatus.QUEUED, secondsAgo(50), 9);
        const withPriority = await service.view(actor(AGENT_EN_HI, TENANT_A));
        check(
          withPriority.sessions.find((s) => s.session_id === priority)?.priority === 9,
          'the stored priority is reported',
        );
        check(
          withPriority.sessions.at(-1)?.session_id === priority,
          'a high priority does not move a newer session up the FIFO list',
        );

        // ---------------------------------------------------------- bounded
        section('[bounded] the result and the Redis read are both capped');

        for (let i = 0; i < AGENT_QUEUE_LIMIT * 2; i += 1) {
          await seed(TENANT_B, 'en', SessionStatus.QUEUED, new Date(NOW.getTime() - 900_000 + i));
        }
        const bounded = await service.view(actor(AGENT_B, TENANT_B));
        check(
          bounded.sessions.length === AGENT_QUEUE_LIMIT,
          `at most ${AGENT_QUEUE_LIMIT} sessions are returned from a longer queue`,
        );
        const bTotal = await queueRepo.range(TENANT_B, 'en', 1000);
        check(
          bTotal.length > AGENT_QUEUE_LIMIT,
          'the underlying queue really is longer than the bound',
        );
        check(
          bounded.sessions[0]?.session_id === bTotal[0]?.sessionId,
          'the bounded result starts at the head of the queue',
        );

        // ------------------------------------------------------ equal scores
        section('[ties] equal scores order deterministically');

        const tie = new Date(NOW.getTime() - 77_000);
        const tieA = await seed(TENANT_A, 'en', SessionStatus.QUEUED, tie);
        const tieB = await seed(TENANT_A, 'hi', SessionStatus.QUEUED, tie);
        const firstRead = await idsFor(actor(AGENT_EN_HI, TENANT_A));
        const secondRead = await idsFor(actor(AGENT_EN_HI, TENANT_A));
        check(firstRead.join() === secondRead.join(), 'two identical reads agree exactly');
        const lower = tieA < tieB ? tieA : tieB;
        check(
          firstRead.indexOf(lower) < firstRead.indexOf(tieA === lower ? tieB : tieA),
          'equal scores break on session id, as Redis does within one queue',
        );

        // ------------------------------------------------------- authorisation
        section('[authorisation] a user with no agent profile is refused');

        let refused = false;
        try {
          await service.view(actor(ADMIN_A, TENANT_A));
        } catch {
          refused = true;
        }
        check(
          refused,
          'a TENANT_ADMIN with no agent_profiles row is refused, not given an empty list',
        );

        // ---------------------------------------------------------- read-only
        section('[read-only] the whole run wrote nothing');

        const countsBefore = await tx.execute<{
          sessions: number;
          events: number;
          billing: number;
          versions: number;
        }>(sql`
          SELECT
            (SELECT count(*)::int FROM sessions WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS sessions,
            (SELECT count(*)::int FROM session_events WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS events,
            (SELECT count(*)::int FROM billing_entries WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS billing,
            (SELECT coalesce(sum(version), 0)::int FROM sessions WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS versions`);

        // Ten more reads across every agent, then the same counts again.
        for (let i = 0; i < 10; i += 1) {
          await service.view(actor(AGENT_EN_HI, TENANT_A));
          await service.view(actor(AGENT_TA, TENANT_A));
          await service.view(actor(AGENT_B, TENANT_B));
        }

        const countsAfter = await tx.execute<{
          sessions: number;
          events: number;
          billing: number;
          versions: number;
        }>(sql`
          SELECT
            (SELECT count(*)::int FROM sessions WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS sessions,
            (SELECT count(*)::int FROM session_events WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS events,
            (SELECT count(*)::int FROM billing_entries WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS billing,
            (SELECT coalesce(sum(version), 0)::int FROM sessions WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})) AS versions`);

        const before = countsBefore[0];
        const after = countsAfter[0];
        check(Number(before?.sessions) === Number(after?.sessions), 'no session row was created');
        check(Number(before?.events) === Number(after?.events), 'no session_event was created');
        check(Number(before?.billing) === Number(after?.billing), 'no billing_entry was created');
        check(
          Number(before?.versions) === Number(after?.versions),
          'no session version was bumped',
        );
        check(Number(after?.events) === 0, 'the run created no session_events at all');
        check(Number(after?.billing) === 0, 'the run created no billing_entries at all');

        const [statuses] = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM sessions
           WHERE tenant_id = ${TENANT_A} AND status = 'OFFERED' AND offered_to_agent_id IS NOT NULL`);
        check(Number(statuses?.n) === 0, 'no session was offered to an agent');

        const [assigned] = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM sessions
           WHERE tenant_id IN (${TENANT_A}, ${TENANT_B}) AND agent_id IS NOT NULL`);
        check(Number(assigned?.n) === 0, 'no session was assigned to an agent');

        // Redis membership is unchanged too: the reads added nothing.
        const enAfter = await queueRepo.range(TENANT_A, 'en', 1000);
        check(
          enAfter.length === membersNow.length + 3,
          'the en queue grew only by the members this script added after the snapshot',
        );

        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    section('[rollback] the fixtures left no rows behind');
    const [leftover] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM sessions WHERE external_ref LIKE ${`vq-%${runId}%`}`);
    check(Number(leftover?.n) === 0, 'the rolled-back sessions are gone');
    const [leftTenants] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tenants WHERE slug LIKE ${`vq-%-${runId}`}`);
    check(Number(leftTenants?.n) === 0, 'the rolled-back tenants are gone');
  } finally {
    // Redis has no rollback. Delete exactly the keys this run created.
    await redis.del(...touchedKeys);
    await redis.quit();
    await client.end();
  }

  section(
    failed === 0
      ? `ALL AGENT QUEUE CHECKS PASSED (${passed})`
      : `${failed} CHECK(S) FAILED (${passed} passed)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `\nVERIFY AGENT QUEUE FAILED: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exit(1);
});
