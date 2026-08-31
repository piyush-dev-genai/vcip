/**
 * The agent claim against real PostgreSQL and real Redis.
 *
 * The unit and HTTP suites prove the rules against fakes, and a fake can only
 * be as right as the person who wrote it. T18's central claims are claims about
 * a real database, and three of them cannot be made anywhere else:
 *
 *   - that a conditional `UPDATE ... WHERE status = 'QUEUED'` really lets
 *     exactly one of two simultaneous agents through (D5),
 *   - that locking the agent's own `users` row really serialises that agent's
 *     concurrent claims, so `max_concurrent` holds under a double-submit —
 *     a plain count does not, because READ COMMITTED gives each statement its
 *     own snapshot and two claims touch different session rows,
 *   - and that the session update and its `session_events` row really commit
 *     or roll back together.
 *
 * Two halves, for that reason:
 *
 *   1. **Rolled back.** Everything that one connection can answer runs inside a
 *      transaction that is thrown away, so no fixture persists.
 *   2. **Committed, then deleted.** Concurrency needs two connections seeing
 *      each other's work, which a single uncommitted transaction cannot
 *      provide. These fixtures are committed and removed in the `finally`,
 *      keyed by UUIDs generated in this process so they cannot collide with
 *      seeded data.
 *
 * Redis has no rollback either, so every presence key this run touches is
 * deleted the same way.
 *
 *   pnpm --filter @vcip/api db:verify-agent-claim
 */

import { randomUUID } from 'node:crypto';
import { AgentPresence, SessionEventType, SessionStatus } from '@vcip/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { agentProfiles, sessionEvents, sessions, tenants, users } from '../db/schema.js';
import { DrizzleAgentRepository } from '../src/agents/agent.repository.js';
import { AgentClaimService } from '../src/agents/agent-claim.service.js';
import { offerExpiresAt } from '../src/agents/agent-claim.rules.js';
import { RedisPresenceRepository } from '../src/agents/presence.repository.js';
import { PresenceService } from '../src/agents/presence.service.js';
import { ActorRole } from '../src/common/auth/auth-context.js';
import type { AgentActor } from '../src/common/auth/auth-context.js';
import { TenantScope } from '../src/common/auth/tenant-scope.js';
import { DrizzleSessionEventWriter } from '../src/common/events/index.js';
import { createLogger } from '../src/common/logging/logger.js';
import { presenceKey } from '../src/agents/presence.keys.js';
import { queueKey } from '../src/queue/queue.keys.js';
import { RedisQueueRepository } from '../src/queue/queue.repository.js';
import { DrizzleSessionRepository } from '../src/sessions/session.repository.js';
import { DrizzleTenantConfigStore } from '../src/tenants/tenant-config.store.js';
import { TenantsService } from '../src/tenants/tenants.service.js';

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

/** Thrown to roll back the first half without reporting an error. */
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

/** The code a thrown domain error carries, whatever its class. */
const codeOf = (error: unknown): string => {
  const response = (error as { response?: { code?: string }; code?: string } | undefined) ?? {};
  return response.code ?? response.response?.code ?? '';
};

const statusOf = (error: unknown): number =>
  (error as { status?: number } | undefined)?.status ?? 0;

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const redisDb = Number(process.env['REDIS_DB'] ?? 0);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  const redis = new Redis(redisUrl, { db: redisDb });

  const runId = randomUUID().slice(0, 8);
  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();
  const AGENT_ONE = randomUUID();
  const AGENT_TWO = randomUUID();
  const AGENT_MULTI = randomUUID();
  const AGENT_B = randomUUID();
  const ADMIN_A = randomUUID();

  const ALL_AGENTS = [AGENT_ONE, AGENT_TWO, AGENT_MULTI, AGENT_B, ADMIN_A];
  const ALL_TENANTS = [TENANT_A, TENANT_B];

  const touchedKeys = new Set<string>(ALL_AGENTS.map(presenceKey));
  for (const tenantId of ALL_TENANTS) {
    // 'en-in' is here because the R13 check seeds a regional variant, and a
    // language this run touches but does not list would be a key it leaks.
    for (const language of ['en', 'hi', 'ta', 'en-IN']) {
      touchedKeys.add(queueKey(tenantId, language));
    }
  }

  const presenceRepo = new RedisPresenceRepository(redis);
  const queueRepo = new RedisQueueRepository(redis);
  const logger = createLogger({ level: 'silent' });
  const eventWriter = new DrizzleSessionEventWriter();

  const NOW = new Date('2026-08-31T12:00:00.000Z');
  const OFFER_TIMEOUT = 30;

  /** Put an agent at their desk, as `POST /availability` would. */
  const goAvailable = async (agentId: string, tenantId: string): Promise<void> => {
    await presenceRepo.set({
      agentId,
      tenantId,
      status: AgentPresence.AVAILABLE,
      languages: ['en'],
      lastSeen: NOW,
    });
  };

  /** Build the service against one executor, so a transaction can be used. */
  const serviceFor = (executor: PostgresJsDatabase): AgentClaimService =>
    new AgentClaimService(
      new DrizzleSessionRepository(executor, eventWriter),
      new DrizzleAgentRepository(executor),
      new PresenceService(presenceRepo, new DrizzleAgentRepository(executor), logger, () => NOW),
      new TenantsService(new DrizzleTenantConfigStore(executor)),
      new TenantScope(),
      logger,
      () => NOW,
    );

  /** Fixtures both halves need, inserted through whichever executor is given. */
  const insertFixtures = async (executor: PostgresJsDatabase): Promise<void> => {
    await executor.insert(tenants).values([
      {
        id: TENANT_A,
        slug: `vc-a-${runId}`,
        name: `verify claim A ${runId}`,
        status: 'ACTIVE',
        offerTimeoutSeconds: OFFER_TIMEOUT,
      },
      {
        id: TENANT_B,
        slug: `vc-b-${runId}`,
        name: `verify claim B ${runId}`,
        status: 'ACTIVE',
        offerTimeoutSeconds: OFFER_TIMEOUT,
      },
    ]);

    await executor.insert(users).values([
      {
        id: AGENT_ONE,
        tenantId: TENANT_A,
        email: `one-${runId}@verify.local`,
        role: 'AGENT',
        status: 'ACTIVE',
      },
      {
        id: AGENT_TWO,
        tenantId: TENANT_A,
        email: `two-${runId}@verify.local`,
        role: 'AGENT',
        status: 'ACTIVE',
      },
      {
        id: AGENT_MULTI,
        tenantId: TENANT_A,
        email: `multi-${runId}@verify.local`,
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

    // Mixed case on purpose: nothing normalises this column on write.
    await executor.insert(agentProfiles).values([
      { userId: AGENT_ONE, languages: ['EN', 'hi'], maxConcurrent: 1 },
      { userId: AGENT_TWO, languages: ['en'], maxConcurrent: 1 },
      { userId: AGENT_MULTI, languages: ['en'], maxConcurrent: 3 },
      { userId: AGENT_B, languages: ['en'], maxConcurrent: 1 },
    ]);
    // ADMIN_A deliberately gets no agent_profiles row.
  };

  /** Insert a queued session and place its member in Redis, as T15 does. */
  const seedQueued = async (
    executor: PostgresJsDatabase,
    tenantId: string,
    language: string,
    status: SessionStatus = SessionStatus.QUEUED,
    queuedAt: Date = new Date(NOW.getTime() - 60_000),
  ): Promise<string> => {
    const [row] = await executor
      .insert(sessions)
      .values({
        tenantId,
        externalRef: `vc-${runId}-${randomUUID().slice(0, 8)}`,
        status,
        language,
        queuedAt,
      })
      .returning({ id: sessions.id });
    if (row === undefined) throw new Error('session insert failed');
    await queueRepo.add({ tenantId, language, sessionId: row.id, score: queuedAt.getTime() });
    return row.id;
  };

  try {
    section('[ping] servers reachable');
    check((await redis.ping()) === 'PONG', 'redis answers PING');
    const [alive] = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
    check(Number(alive?.ok) === 1, 'postgresql answers a query');

    // ================================================================ part 1
    // Everything one connection can answer, thrown away afterwards.

    await db
      .transaction(async (tx) => {
        const executor = tx as unknown as PostgresJsDatabase;
        await insertFixtures(executor);
        const service = serviceFor(executor);

        await goAvailable(AGENT_ONE, TENANT_A);
        await goAvailable(AGENT_TWO, TENANT_A);
        await goAvailable(AGENT_MULTI, TENANT_A);
        await goAvailable(AGENT_B, TENANT_B);
        await goAvailable(ADMIN_A, TENANT_A);

        section('[claim] a queued session becomes OFFERED');
        const first = await seedQueued(executor, TENANT_A, 'en');
        const result = await service.claim(actor(AGENT_ONE, TENANT_A), first);

        check(result.status === SessionStatus.OFFERED, 'the response reports OFFERED');
        check(result.session_id === first, 'the response names the session claimed');
        check(result.offered_to_agent_id === AGENT_ONE, 'the offer belongs to the caller');
        check(
          result.offer_expires_at === offerExpiresAt(NOW, OFFER_TIMEOUT).toISOString(),
          'the expiry is offered_at plus the tenant timeout',
        );
        check(
          Object.keys(result).sort().join(',') ===
            'offer_expires_at,offered_to_agent_id,session_id,status',
          'the response carries exactly the four contract fields',
        );

        const [stored] = await executor
          .select({
            status: sessions.status,
            offeredTo: sessions.offeredToAgentId,
            offeredAt: sessions.offeredAt,
            agentId: sessions.agentId,
            version: sessions.version,
          })
          .from(sessions)
          .where(eq(sessions.id, first));

        check(stored?.status === SessionStatus.OFFERED, 'postgresql stored OFFERED');
        check(stored?.offeredTo === AGENT_ONE, 'postgresql stored offered_to_agent_id');
        check(stored?.offeredAt !== null, 'postgresql stored offered_at');
        check(
          stored?.agentId === null,
          'agent_id is still null — a claim is not an assignment (T19 sets it)',
        );
        check(Number(stored?.version) === 2, 'the version was bumped exactly once');

        section('[events] the offer is explained in the audit trail');
        const events = await executor
          .select({ type: sessionEvents.eventType, actor: sessionEvents.actorId })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, first));

        check(events.length === 1, 'exactly one event was appended');
        check(
          events[0]?.type === SessionEventType.SESSION_ASSIGNED,
          'the event is the canonical SESSION_ASSIGNED, not a new name',
        );
        check(events[0]?.actor === AGENT_ONE, 'the event names the claiming agent');

        section('[queue] the projection is left alone');
        const stillQueued = await redis.zscore(queueKey(TENANT_A, 'en'), first);
        check(stillQueued !== null, 'the member is still in the ZSET — no ZREM on claim');
        check(
          Number(stillQueued) === NOW.getTime() - 60_000,
          'its score is unchanged, so T20 can restore the original position',
        );

        section('[presence] BUSY follows the commit');
        const presence = await presenceRepo.read(AGENT_ONE);
        check(presence?.status === AgentPresence.BUSY, 'the agent is BUSY in redis');
        check(presence?.tenantId === TENANT_A, 'the presence still carries its tenant');

        section('[capacity] max_concurrent is enforced against postgresql');
        const second = await seedQueued(executor, TENANT_A, 'en');
        await goAvailable(AGENT_ONE, TENANT_A); // looks free again in redis
        let capacityCode = '';
        try {
          await service.claim(actor(AGENT_ONE, TENANT_A), second);
        } catch (error) {
          capacityCode = codeOf(error);
        }
        check(capacityCode === 'CONFLICT', 'a second claim is refused while one offer is held');
        const [untouched] = await executor
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, second));
        check(untouched?.status === SessionStatus.QUEUED, 'the refused session is still QUEUED');

        const multiFirst = await seedQueued(executor, TENANT_A, 'en');
        const multiSecond = await seedQueued(executor, TENANT_A, 'en');
        await service.claim(actor(AGENT_MULTI, TENANT_A), multiFirst);
        await goAvailable(AGENT_MULTI, TENANT_A);
        const twoOfThree = await service.claim(actor(AGENT_MULTI, TENANT_A), multiSecond);
        check(
          twoOfThree.status === SessionStatus.OFFERED,
          'an agent whose profile allows three may hold two',
        );

        section('[capacity] a call in progress counts too');
        const inCall = await seedQueued(executor, TENANT_A, 'en');
        await executor
          .update(sessions)
          .set({ status: SessionStatus.IN_CALL, agentId: AGENT_TWO })
          .where(eq(sessions.id, inCall));
        const blocked = await seedQueued(executor, TENANT_A, 'en');
        let inCallCode = '';
        try {
          await service.claim(actor(AGENT_TWO, TENANT_A), blocked);
        } catch (error) {
          inCallCode = codeOf(error);
        }
        check(inCallCode === 'CONFLICT', 'an agent already IN_CALL cannot claim');

        // End that call, so the capacity this section consumed does not leak
        // into the language checks below — which are about language.
        await executor
          .update(sessions)
          .set({ status: SessionStatus.APPROVED })
          .where(eq(sessions.id, inCall));
        const freed = await seedQueued(executor, TENANT_A, 'en');
        await goAvailable(AGENT_TWO, TENANT_A);
        const afterCall = await service.claim(actor(AGENT_TWO, TENANT_A), freed);
        check(
          afterCall.status === SessionStatus.OFFERED,
          'capacity is released when the call ends',
        );
        await executor
          .update(sessions)
          .set({ status: SessionStatus.APPROVED, offeredToAgentId: null })
          .where(eq(sessions.id, freed));

        section('[status] only a queued session can be claimed');
        for (const status of [
          SessionStatus.CREATED,
          SessionStatus.OFFERED,
          SessionStatus.IN_CALL,
          SessionStatus.DROPPED_QUEUED,
          SessionStatus.APPROVED,
          SessionStatus.REJECTED,
          SessionStatus.ABORTED,
        ]) {
          const id = await seedQueued(executor, TENANT_A, 'en', status);
          await goAvailable(AGENT_TWO, TENANT_A);
          let refused = false;
          try {
            await service.claim(actor(AGENT_TWO, TENANT_A), id);
          } catch {
            refused = true;
          }
          const [after] = await executor
            .select({ status: sessions.status })
            .from(sessions)
            .where(eq(sessions.id, id));
          check(refused && after?.status === status, `a ${status} session cannot be claimed`);
        }

        section('[tenant] isolation is enforced in sql, not after the fact');
        const tenantBSession = await seedQueued(executor, TENANT_B, 'en');
        await goAvailable(AGENT_TWO, TENANT_A);
        let crossStatus = 0;
        try {
          await service.claim(actor(AGENT_TWO, TENANT_A), tenantBSession);
        } catch (error) {
          crossStatus = statusOf(error);
        }
        check(crossStatus === 404, "another tenant's session is a 404, not a 403");
        const [foreign] = await executor
          .select({ status: sessions.status, offeredTo: sessions.offeredToAgentId })
          .from(sessions)
          .where(eq(sessions.id, tenantBSession));
        check(foreign?.status === SessionStatus.QUEUED, "the other tenant's session is untouched");
        check(foreign?.offeredTo === null, 'and was not offered to the foreign agent');

        section('[language] the agent must speak it, normalised on both sides');
        const tamil = await seedQueued(executor, TENANT_A, 'ta');
        await goAvailable(AGENT_TWO, TENANT_A);
        let languageStatus = 0;
        try {
          await service.claim(actor(AGENT_TWO, TENANT_A), tamil);
        } catch (error) {
          languageStatus = statusOf(error);
        }
        check(languageStatus === 403, 'a language the agent lacks is refused');

        // AGENT_ONE's profile stores 'EN'; the session stores 'en'.
        const upper = await seedQueued(executor, TENANT_A, 'en');
        await executor
          .update(sessions)
          .set({ status: SessionStatus.QUEUED })
          .where(eq(sessions.id, upper));
        await goAvailable(AGENT_TWO, TENANT_A);
        const normalised = await service.claim(actor(AGENT_TWO, TENANT_A), upper);
        check(
          normalised.status === SessionStatus.OFFERED,
          "a profile storing 'EN' still matches a session storing 'en'",
        );

        const regional = await seedQueued(executor, TENANT_A, 'en-IN');
        await goAvailable(AGENT_ONE, TENANT_A);
        let regionalStatus = 0;
        try {
          await service.claim(actor(AGENT_ONE, TENANT_A), regional);
        } catch (error) {
          regionalStatus = statusOf(error);
        }
        check(regionalStatus === 403, 'en-IN is a different language from en (R13)');

        section('[presence] an absent or wrong presence blocks the claim');
        const noPresence = await seedQueued(executor, TENANT_A, 'en');
        await presenceRepo.remove(AGENT_MULTI);
        let absentCode = '';
        try {
          await service.claim(actor(AGENT_MULTI, TENANT_A), noPresence);
        } catch (error) {
          absentCode = codeOf(error);
        }
        check(absentCode === 'CONFLICT', 'an agent with no live presence cannot claim');

        await presenceRepo.set({
          agentId: AGENT_MULTI,
          tenantId: TENANT_A,
          status: AgentPresence.UNAVAILABLE,
          languages: ['en'],
          lastSeen: NOW,
        });
        let unavailableCode = '';
        try {
          await service.claim(actor(AGENT_MULTI, TENANT_A), noPresence);
        } catch (error) {
          unavailableCode = codeOf(error);
        }
        check(unavailableCode === 'CONFLICT', 'an UNAVAILABLE agent cannot claim');

        const [stillWaiting] = await executor
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, noPresence));
        check(stillWaiting?.status === SessionStatus.QUEUED, 'neither refusal touched the session');

        section('[profile] a user without an agent profile is refused');
        const forAdmin = await seedQueued(executor, TENANT_A, 'en');
        await goAvailable(ADMIN_A, TENANT_A);
        let adminStatus = 0;
        try {
          await service.claim(actor(ADMIN_A, TENANT_A), forAdmin);
        } catch (error) {
          adminStatus = statusOf(error);
        }
        check(adminStatus === 403, 'a tenant admin cannot claim');

        section('[repository] the guards live in the SQL, not only in the service');
        // Straight at the port, bypassing the service entirely. The service
        // rejects a cross-tenant session with a 404 long before the UPDATE
        // runs, which means nothing above this point exercises the tenant
        // predicate in the statement itself. These checks do — so removing any
        // one of the three guards fails here rather than passing quietly as
        // defence-in-depth nobody tests.
        const portRepo = new DrizzleSessionRepository(executor, eventWriter);
        const foreignQueued = await seedQueued(executor, TENANT_B, 'en');
        const command = {
          sessionId: foreignQueued,
          tenantId: TENANT_A,
          agentId: AGENT_TWO,
          // High on purpose: these checks isolate the tenant and status
          // predicates, and a capacity refusal would mask both.
          maxConcurrent: 99,
          offeredAt: NOW,
          event: {
            type: SessionEventType.SESSION_ASSIGNED,
            actorType: 'AGENT' as const,
            actorId: AGENT_TWO,
            payload: { from: SessionStatus.QUEUED, to: SessionStatus.OFFERED },
          },
        };

        // Wrapped, so a regression reports rather than aborting the run: with
        // the predicate removed the UPDATE succeeds and T13's event writer then
        // refuses the mismatched tenant, which is a throw rather than a value.
        let crossTenantKind: string;
        try {
          crossTenantKind = (await portRepo.claim(command)).kind;
        } catch {
          crossTenantKind = 'threw';
        }
        check(
          crossTenantKind === 'LOST',
          "the UPDATE's tenant predicate refuses another tenant's queued session",
        );
        const [foreignAfter] = await executor
          .select({ status: sessions.status, offeredTo: sessions.offeredToAgentId })
          .from(sessions)
          .where(eq(sessions.id, foreignQueued));
        check(
          foreignAfter?.status === SessionStatus.QUEUED && foreignAfter.offeredTo === null,
          'and left that row exactly as it was',
        );

        const notQueued = await seedQueued(executor, TENANT_A, 'en', SessionStatus.CREATED);
        const wrongStatus = await portRepo.claim({ ...command, sessionId: notQueued });
        check(
          wrongStatus.kind === 'LOST',
          "the UPDATE's status predicate refuses a session that never queued",
        );

        const overCapacity = await seedQueued(executor, TENANT_A, 'en');
        const capped = await portRepo.claim({
          ...command,
          sessionId: overCapacity,
          agentId: AGENT_ONE, // already holds an offer from the section above
          maxConcurrent: 1,
        });
        check(
          capped.kind === 'AT_CAPACITY',
          'the capacity count refuses an agent already at max_concurrent',
        );

        const stillFree = await portRepo.claim({ ...command, sessionId: overCapacity });
        check(
          stillFree.kind === 'CLAIMED',
          'and the same session is claimable by an agent who is not',
        );

        section('[billing] a claim is not a billable outcome');
        const [{ billed }] = await executor.execute<{ billed: string }>(sql`
          SELECT count(*)::text AS billed FROM billing_entries
           WHERE tenant_id = ${TENANT_A}::uuid
        `);
        check(Number(billed) === 0, 'no billing row was written by any claim');

        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    section('[rollback] the first half left nothing behind');
    const [{ leftover }] = await db.execute<{ leftover: string }>(sql`
      SELECT count(*)::text AS leftover FROM tenants WHERE id = ${TENANT_A}::uuid
    `);
    check(Number(leftover) === 0, 'the rolled-back transaction persisted no tenant');

    // ================================================================ part 2
    // Concurrency. Needs committed rows and two connections.

    section('[concurrency] two agents, one session');
    await insertFixtures(db);

    const contested = await seedQueued(db, TENANT_A, 'en');
    await goAvailable(AGENT_ONE, TENANT_A);
    await goAvailable(AGENT_TWO, TENANT_A);

    const clientOne = postgres(databaseUrl, { max: 1 });
    const clientTwo = postgres(databaseUrl, { max: 1 });
    const serviceOne = serviceFor(drizzle(clientOne));
    const serviceTwo = serviceFor(drizzle(clientTwo));

    const settle = async (run: Promise<unknown>): Promise<{ won: boolean; code: string }> => {
      try {
        await run;
        return { won: true, code: '' };
      } catch (error) {
        return { won: false, code: codeOf(error) };
      }
    };

    const [one, two] = await Promise.all([
      settle(serviceOne.claim(actor(AGENT_ONE, TENANT_A), contested)),
      settle(serviceTwo.claim(actor(AGENT_TWO, TENANT_A), contested)),
    ]);

    const winners = [one, two].filter((r) => r.won);
    const losers = [one, two].filter((r) => !r.won);
    check(winners.length === 1, 'exactly one agent won the claim');
    check(losers.length === 1, 'exactly one agent lost it');
    check(
      losers[0]?.code === 'SESSION_ALREADY_ASSIGNED',
      'the loser is told the session was already claimed (D5)',
    );

    const [contestedRow] = await db
      .select({ status: sessions.status, offeredTo: sessions.offeredToAgentId })
      .from(sessions)
      .where(eq(sessions.id, contested));
    check(contestedRow?.status === SessionStatus.OFFERED, 'the session is OFFERED exactly once');
    check(
      contestedRow?.offeredTo === AGENT_ONE || contestedRow?.offeredTo === AGENT_TWO,
      'it is offered to one of the two contenders',
    );

    const contestedEvents = await db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, contested));
    check(
      contestedEvents.length === 1,
      'the loser appended no event — its transaction rolled back',
    );

    section('[concurrency] one agent, two sessions, max_concurrent = 1');
    // The property a plain count cannot provide: under READ COMMITTED the two
    // statements below take different snapshots and touch different session
    // rows, so nothing but the agent row lock stops both from committing.
    const raceA = await seedQueued(db, TENANT_A, 'en');
    const raceB = await seedQueued(db, TENANT_A, 'en');
    await goAvailable(AGENT_TWO, TENANT_A);

    const [claimA, claimB] = await Promise.all([
      settle(serviceOne.claim(actor(AGENT_TWO, TENANT_A), raceA)),
      settle(serviceTwo.claim(actor(AGENT_TWO, TENANT_A), raceB)),
    ]);

    const held = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.status, SessionStatus.OFFERED), eq(sessions.offeredToAgentId, AGENT_TWO)),
      );

    check(
      [claimA, claimB].filter((r) => r.won).length === 1,
      'only one of two simultaneous claims by one agent succeeded',
    );
    check(held.length === 1, 'the agent ended up holding exactly one offer');
    check(
      [claimA, claimB].filter((r) => !r.won)[0]?.code === 'CONFLICT',
      'the refused one cites capacity, not a lost race',
    );

    await clientOne.end();
    await clientTwo.end();

    process.stdout.write(
      failed === 0
        ? `\nALL AGENT CLAIM CHECKS PASSED (${passed})\n`
        : `\n${failed} CHECK(S) FAILED (${passed} passed)\n`,
    );
  } finally {
    // Part 2 committed. Remove every row and key it created, in dependency
    // order, keyed by ids generated in this process.
    const ourSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.tenantId, ALL_TENANTS));
    const sessionIds = ourSessions.map((row) => row.id);

    if (sessionIds.length > 0) {
      await db.delete(sessionEvents).where(inArray(sessionEvents.sessionId, sessionIds));
      await db.execute(sql`
        DELETE FROM billing_entries WHERE session_id IN ${sql`(${sql.join(
          sessionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`}
      `);
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    await db.delete(agentProfiles).where(inArray(agentProfiles.userId, ALL_AGENTS));
    await db.delete(users).where(inArray(users.id, ALL_AGENTS));
    await db.delete(tenants).where(inArray(tenants.id, ALL_TENANTS));

    if (touchedKeys.size > 0) await redis.del(...touchedKeys);

    await redis.quit();
    await client.end();
  }

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
