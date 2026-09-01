/**
 * Accept (T19) and the offer sweeper (T20) against real PostgreSQL and Redis.
 *
 * The unit and HTTP suites prove the rules against fakes. Four properties are
 * claims about a real database and cannot be made anywhere else:
 *
 *   - that `sessions.offer_expires_at` is actually written by a claim — the
 *     column and its partial index exist for the sweeper, and a sweeper
 *     querying a column nothing writes finds nothing and reports success,
 *   - that an accept and a sweep racing for the same row produce exactly one
 *     winner, with the loser matching nothing rather than overwriting,
 *   - that two sweepers running at once take disjoint batches and expire each
 *     offer exactly once, which is what makes the interval safe to run on every
 *     instance with no lock,
 *   - and that the accept's guards live in the statement, not only in the
 *     service that calls it.
 *
 * Two halves, as `verify-agent-claim.ts` has: a rolled-back transaction for
 * everything one connection can answer, then committed fixtures — deleted in
 * the `finally` — for the concurrent parts.
 *
 *   pnpm --filter @vcip/api db:verify-agent-accept
 */

import { randomUUID } from 'node:crypto';
import { AgentPresence, SessionEventType, SessionStatus } from '@vcip/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { agentProfiles, sessionEvents, sessions, tenants, users } from '../db/schema.js';
import { DrizzleAgentRepository } from '../src/agents/agent.repository.js';
import { AgentAcceptService } from '../src/agents/agent-accept.service.js';
import { AgentClaimService } from '../src/agents/agent-claim.service.js';
import { OfferSweeper } from '../src/agents/offer-sweeper.service.js';
import { presenceKey } from '../src/agents/presence.keys.js';
import { RedisPresenceRepository } from '../src/agents/presence.repository.js';
import { PresenceService } from '../src/agents/presence.service.js';
import { ActorRole } from '../src/common/auth/auth-context.js';
import type { AgentActor } from '../src/common/auth/auth-context.js';
import { TenantScope } from '../src/common/auth/tenant-scope.js';
import { DrizzleSessionEventWriter } from '../src/common/events/index.js';
import { createLogger } from '../src/common/logging/logger.js';
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

const section = (label: string): void => process.stdout.write(`\n${label}\n`);

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

const codeOf = (error: unknown): string => {
  const e = (error as { response?: { code?: string }; code?: string } | undefined) ?? {};
  return e.code ?? e.response?.code ?? '';
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
  const AGENT_B = randomUUID();

  const ALL_AGENTS = [AGENT_ONE, AGENT_TWO, AGENT_B];
  const ALL_TENANTS = [TENANT_A, TENANT_B];

  const touchedKeys = new Set<string>(ALL_AGENTS.map(presenceKey));
  for (const tenantId of ALL_TENANTS) {
    for (const language of ['en', 'hi', 'ta']) touchedKeys.add(queueKey(tenantId, language));
  }

  const presenceRepo = new RedisPresenceRepository(redis);
  const queueRepo = new RedisQueueRepository(redis);
  const logger = createLogger({ level: 'silent' });
  const eventWriter = new DrizzleSessionEventWriter();

  const OFFER_TIMEOUT = 30;
  /** A fixed instant, so every expiry in this run is exact rather than raced. */
  const T0 = new Date('2026-09-01T12:00:00.000Z');
  const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

  const goAvailable = async (agentId: string, tenantId: string): Promise<void> => {
    await presenceRepo.set({
      agentId,
      tenantId,
      status: AgentPresence.AVAILABLE,
      languages: ['en'],
      lastSeen: T0,
    });
  };

  const presenceOf = async (agentId: string): Promise<string | null> =>
    (await presenceRepo.read(agentId))?.status ?? null;

  /** Services bound to one executor and one clock reading. */
  const servicesFor = (executor: PostgresJsDatabase, now: () => Date) => {
    const repo = new DrizzleSessionRepository(executor, eventWriter);
    const presence = new PresenceService(
      presenceRepo,
      new DrizzleAgentRepository(executor),
      repo,
      logger,
      now,
    );
    return {
      repo,
      claim: new AgentClaimService(
        repo,
        new DrizzleAgentRepository(executor),
        presence,
        new TenantsService(new DrizzleTenantConfigStore(executor)),
        new TenantScope(),
        logger,
        now,
      ),
      accept: new AgentAcceptService(repo, presence, new TenantScope(), logger, now),
      sweeper: new OfferSweeper(repo, presence, logger, false, now),
    };
  };

  const insertFixtures = async (executor: PostgresJsDatabase): Promise<void> => {
    await executor.insert(tenants).values([
      {
        id: TENANT_A,
        slug: `va-a-${runId}`,
        name: `verify accept A ${runId}`,
        status: 'ACTIVE',
        offerTimeoutSeconds: OFFER_TIMEOUT,
      },
      {
        id: TENANT_B,
        slug: `va-b-${runId}`,
        name: `verify accept B ${runId}`,
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
        id: AGENT_B,
        tenantId: TENANT_B,
        email: `b-${runId}@verify.local`,
        role: 'AGENT',
        status: 'ACTIVE',
      },
    ]);

    await executor.insert(agentProfiles).values([
      // Generous, because this script is about the offer lifecycle and not
      // about capacity — the sweeper batch test alone holds a dozen offers.
      { userId: AGENT_ONE, languages: ['en'], maxConcurrent: 50 },
      { userId: AGENT_TWO, languages: ['en'], maxConcurrent: 50 },
      { userId: AGENT_B, languages: ['en'], maxConcurrent: 50 },
    ]);
  };

  const seedQueued = async (
    executor: PostgresJsDatabase,
    tenantId = TENANT_A,
    language = 'en',
  ): Promise<string> => {
    const queuedAt = at(-60_000);
    const [row] = await executor
      .insert(sessions)
      .values({
        tenantId,
        externalRef: `va-${runId}-${randomUUID().slice(0, 8)}`,
        status: SessionStatus.QUEUED,
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

    // =============================================================== part 1
    await db
      .transaction(async (tx) => {
        const executor = tx as unknown as PostgresJsDatabase;
        await insertFixtures(executor);
        const svc = servicesFor(executor, () => T0);

        await goAvailable(AGENT_ONE, TENANT_A);
        await goAvailable(AGENT_TWO, TENANT_A);
        await goAvailable(AGENT_B, TENANT_B);

        section('[claim] the offer expiry is persisted, not only reported');
        const first = await seedQueued(executor);
        const claimed = await svc.claim.claim(actor(AGENT_ONE, TENANT_A), first);
        const [afterClaim] = await executor
          .select({ expires: sessions.offerExpiresAt, offeredAt: sessions.offeredAt })
          .from(sessions)
          .where(eq(sessions.id, first));

        check(afterClaim?.expires !== null, 'offer_expires_at is written to the row');
        check(
          afterClaim?.expires?.toISOString() === claimed.offer_expires_at,
          'and the agent was told exactly the instant the sweeper will act on',
        );
        check(
          afterClaim?.expires?.getTime() ===
            (afterClaim?.offeredAt?.getTime() ?? 0) + OFFER_TIMEOUT * 1000,
          'it is offered_at plus the tenant timeout',
        );

        section('[accept] the offer becomes a call');
        const accepted = await svc.accept.accept(actor(AGENT_ONE, TENANT_A), first);
        check(accepted.status === SessionStatus.IN_CALL, 'the response reports IN_CALL');
        check(accepted.agent_id === AGENT_ONE, 'and names the accepting agent');
        check(
          Object.keys(accepted).sort().join(',') === 'agent_id,room_name,session_id,status',
          'exactly the four contract fields',
        );

        const [row] = await executor
          .select({
            status: sessions.status,
            agentId: sessions.agentId,
            connectedAt: sessions.connectedAt,
            roomName: sessions.roomName,
            offeredTo: sessions.offeredToAgentId,
            offerExpires: sessions.offerExpiresAt,
            version: sessions.version,
          })
          .from(sessions)
          .where(eq(sessions.id, first));

        check(row?.status === SessionStatus.IN_CALL, 'postgresql stored IN_CALL');
        check(row?.agentId === AGENT_ONE, 'agent_id is assigned');
        check(
          row?.connectedAt?.toISOString() === T0.toISOString(),
          'connected_at is the accept instant',
        );
        check(accepted.room_name === row?.roomName, 'the room name returned is the stored one');
        check(
          Number(row?.version) === 3,
          'the version was bumped once by claim and once by accept',
        );
        check(
          row?.offeredTo === AGENT_ONE && row.offerExpires !== null,
          'the offer fields are kept as history, not cleared',
        );

        const events = await executor
          .select({ type: sessionEvents.eventType })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, first));
        check(events.length === 2, 'two events: the offer and the accept');
        check(
          events.some((e) => e.type === SessionEventType.AGENT_ACCEPTED),
          'the accept is AGENT_ACCEPTED, not CALL_STARTED',
        );

        section('[accept] retrying returns the same call');
        const again = await svc.accept.accept(actor(AGENT_ONE, TENANT_A), first);
        check(again.status === SessionStatus.IN_CALL, 'the retry succeeds');
        const [afterRetry] = await executor
          .select({ version: sessions.version, connectedAt: sessions.connectedAt })
          .from(sessions)
          .where(eq(sessions.id, first));
        check(Number(afterRetry?.version) === 3, 'the retry bumped no version');
        check(
          afterRetry?.connectedAt?.toISOString() === T0.toISOString(),
          'and did not push connected_at forward',
        );
        const retryEvents = await executor
          .select({ id: sessionEvents.id })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, first));
        check(retryEvents.length === 2, 'and appended no second AGENT_ACCEPTED');

        section('[accept] refusals');
        const other = await seedQueued(executor);
        await goAvailable(AGENT_TWO, TENANT_A);
        await svc.claim.claim(actor(AGENT_TWO, TENANT_A), other);
        let code = '';
        try {
          await svc.accept.accept(actor(AGENT_ONE, TENANT_A), other);
        } catch (error) {
          code = codeOf(error);
        }
        check(code === 'SESSION_ALREADY_ASSIGNED', "another agent's offer is refused");

        const queuedOnly = await seedQueued(executor);
        code = '';
        try {
          await svc.accept.accept(actor(AGENT_ONE, TENANT_A), queuedOnly);
        } catch (error) {
          code = codeOf(error);
        }
        check(code === 'SESSION_INVALID_STATE', 'a session with no offer is refused');

        const foreign = await seedQueued(executor, TENANT_B);
        let status = 0;
        try {
          await svc.accept.accept(actor(AGENT_ONE, TENANT_A), foreign);
        } catch (error) {
          status = statusOf(error);
        }
        check(status === 404, "another tenant's session is a 404");

        section('[accept] an offer that has lapsed');
        const stale = await seedQueued(executor);
        await goAvailable(AGENT_ONE, TENANT_A);
        await svc.claim.claim(actor(AGENT_ONE, TENANT_A), stale);
        // One second past the window, with no sweeper having run.
        const late = servicesFor(executor, () => at(OFFER_TIMEOUT * 1000 + 1_000));
        code = '';
        try {
          await late.accept.accept(actor(AGENT_ONE, TENANT_A), stale);
        } catch (error) {
          code = codeOf(error);
        }
        check(code === 'SESSION_INVALID_STATE', 'an expired offer cannot be accepted');
        const [staleRow] = await executor
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, stale));
        check(
          staleRow?.status === SessionStatus.OFFERED,
          'and the refusal alone does not requeue it — that is the sweeper',
        );

        section('[sweep] a lapsed offer returns to the queue');
        const swept = await late.sweeper.sweep();
        check(swept.expired >= 1, 'the sweep expired the stale offer');
        const [sweptRow] = await executor
          .select({
            status: sessions.status,
            offeredTo: sessions.offeredToAgentId,
            offeredAt: sessions.offeredAt,
            expires: sessions.offerExpiresAt,
          })
          .from(sessions)
          .where(eq(sessions.id, stale));
        check(sweptRow?.status === SessionStatus.QUEUED, 'the session is QUEUED again');
        check(
          sweptRow?.offeredTo === null && sweptRow.offeredAt === null && sweptRow.expires === null,
          'and all three offer fields are cleared',
        );

        const sweptEvents = await executor
          .select({ type: sessionEvents.eventType })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, stale));
        check(
          sweptEvents.some((e) => e.type === SessionEventType.OFFER_EXPIRED),
          'an OFFER_EXPIRED event explains why it reappeared',
        );
        check(
          !sweptEvents.some((e) => e.type === SessionEventType.SESSION_QUEUED),
          'and it is not recorded as the customer queueing again',
        );

        check(
          (await presenceOf(AGENT_ONE)) === AgentPresence.AVAILABLE,
          'the agent who let it lapse is AVAILABLE again, not BUSY for ever',
        );

        section('[sweep] the queue projection is untouched');
        const score = await redis.zscore(queueKey(TENANT_A, 'en'), stale);
        check(score !== null, 'the member is still in the ZSET');
        check(
          Number(score) === at(-60_000).getTime(),
          'at its original score, so the customer keeps their place',
        );

        section('[sweep] the accepted call is left alone');
        const [untouched] = await executor
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, first));
        check(untouched?.status === SessionStatus.IN_CALL, 'an IN_CALL session is never swept');

        section('[sweep] a live offer is left alone');
        const live = await seedQueued(executor);
        await goAvailable(AGENT_ONE, TENANT_A);
        await svc.claim.claim(actor(AGENT_ONE, TENANT_A), live);
        const early = await svc.sweeper.sweep();
        check(early.expired === 0, 'nothing is expired while the window is open');
        const [liveRow] = await executor
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, live));
        check(liveRow?.status === SessionStatus.OFFERED, 'and the offer still stands');

        section('[repository] the accept guards live in the SQL, not only in the service');
        // Straight at the port, bypassing the service. `requireOwnOffer` refuses
        // a foreign agent, an expired window, and a session with no offer long
        // before the UPDATE runs — so nothing above this point exercises the
        // predicates in the statement itself. Removing any one of them has to
        // fail here rather than pass as untested defence-in-depth.
        const portRepo = new DrizzleSessionRepository(executor, eventWriter);
        const guardEvent = {
          type: SessionEventType.AGENT_ACCEPTED,
          actorType: 'AGENT' as const,
          actorId: AGENT_ONE,
          payload: { from: SessionStatus.OFFERED, to: SessionStatus.IN_CALL },
        };

        const fresh = async (owner: string): Promise<{ id: string; expiresAt: Date }> => {
          const id = await seedQueued(executor);
          await goAvailable(owner, TENANT_A);
          const offer = await svc.claim.claim(actor(owner, TENANT_A), id);
          return { id, expiresAt: new Date(Date.parse(offer.offer_expires_at)) };
        };

        const foreignAgent = await fresh(AGENT_ONE);
        const wrongAgent = await portRepo.accept({
          sessionId: foreignAgent.id,
          tenantId: TENANT_A,
          agentId: AGENT_TWO,
          now: at(0),
          event: guardEvent,
        });
        check(
          wrongAgent.kind === 'LOST',
          'the offered_to_agent_id predicate refuses an agent who was not offered it',
        );

        const wrongTenantOffer = await fresh(AGENT_ONE);
        const wrongTenant = await portRepo.accept({
          sessionId: wrongTenantOffer.id,
          tenantId: TENANT_B,
          agentId: AGENT_ONE,
          now: at(0),
          event: guardEvent,
        });
        check(wrongTenant.kind === 'LOST', 'the tenant predicate refuses a foreign tenant id');

        const notOffered = await seedQueued(executor);
        const stillQueued = await portRepo.accept({
          sessionId: notOffered,
          tenantId: TENANT_A,
          agentId: AGENT_ONE,
          now: at(0),
          event: guardEvent,
        });
        check(stillQueued.kind === 'LOST', 'the status predicate refuses a session with no offer');

        // Keeping the offer fields as history (§17.3) is what makes the status
        // predicate load-bearing rather than redundant: an accepted session
        // still carries `offered_to_agent_id` and an unexpired
        // `offer_expires_at`, so every other predicate in the statement still
        // matches it. Only `status = 'OFFERED'` stops a second accept from
        // bumping the version, appending a second AGENT_ACCEPTED, and resetting
        // `connected_at` on a call already in progress.
        const twice = await fresh(AGENT_ONE);
        const firstAccept = await portRepo.accept({
          sessionId: twice.id,
          tenantId: TENANT_A,
          agentId: AGENT_ONE,
          now: at(0),
          event: guardEvent,
        });
        check(firstAccept.kind === 'ACCEPTED', 'an offer is accepted once');

        const secondAccept = await portRepo.accept({
          sessionId: twice.id,
          tenantId: TENANT_A,
          agentId: AGENT_ONE,
          now: at(1_000),
          event: guardEvent,
        });
        check(
          secondAccept.kind === 'LOST',
          'and the status predicate refuses a second accept, even though the offer fields survive',
        );

        const [twiceRow] = await executor
          .select({ version: sessions.version, connectedAt: sessions.connectedAt })
          .from(sessions)
          .where(eq(sessions.id, twice.id));
        check(
          twiceRow?.connectedAt?.toISOString() === at(0).toISOString(),
          'so connected_at still records the first accept, not the second attempt',
        );

        const twiceEvents = await executor
          .select({ id: sessionEvents.id })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, twice.id));
        check(twiceEvents.length === 2, 'and no second AGENT_ACCEPTED was appended');

        const boundary = await fresh(AGENT_ONE);
        const onTheDot = await portRepo.accept({
          sessionId: boundary.id,
          tenantId: TENANT_A,
          agentId: AGENT_ONE,
          now: boundary.expiresAt,
          event: guardEvent,
        });
        check(
          onTheDot.kind === 'LOST',
          'the expiry predicate refuses an offer expiring on this exact instant',
        );

        const justInTime = await portRepo.accept({
          sessionId: boundary.id,
          tenantId: TENANT_A,
          agentId: AGENT_ONE,
          now: new Date(boundary.expiresAt.getTime() - 1),
          event: guardEvent,
        });
        check(justInTime.kind === 'ACCEPTED', 'and admits the same offer one millisecond earlier');

        const wellPast = await fresh(AGENT_ONE);
        const late2 = await portRepo.accept({
          sessionId: wellPast.id,
          tenantId: TENANT_A,
          agentId: AGENT_ONE,
          now: new Date(wellPast.expiresAt.getTime() + 60_000),
          event: guardEvent,
        });
        check(late2.kind === 'LOST', 'and refuses one a minute past its window');

        section('[billing] neither an accept nor a sweep is billable');
        const [{ billed }] = await executor.execute<{ billed: string }>(sql`
          SELECT count(*)::text AS billed FROM billing_entries
           WHERE tenant_id = ${TENANT_A}::uuid
        `);
        check(Number(billed) === 0, 'no billing row was written');

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

    // =============================================================== part 2
    section('[race] one accept against one sweep, on two connections');
    await insertFixtures(db);
    await goAvailable(AGENT_ONE, TENANT_A);
    await goAvailable(AGENT_TWO, TENANT_A);

    const clientOne = postgres(databaseUrl, { max: 1 });
    const clientTwo = postgres(databaseUrl, { max: 1 });

    const contested = await seedQueued(db);
    const claimSvc = servicesFor(db, () => T0);
    await goAvailable(AGENT_ONE, TENANT_A);
    const claimedOffer = await claimSvc.claim.claim(actor(AGENT_ONE, TENANT_A), contested);
    const expiresAt = Date.parse(claimedOffer.offer_expires_at);

    // Both predicates pass at their own evaluation instants: the accept sees an
    // offer with a millisecond left, the sweeper sees one that has just run
    // out. Only the row lock can decide, which is exactly the point.
    const accepting = servicesFor(drizzle(clientOne), () => new Date(expiresAt - 1));
    const sweeping = servicesFor(drizzle(clientTwo), () => new Date(expiresAt));

    const settled = await Promise.allSettled([
      accepting.accept.accept(actor(AGENT_ONE, TENANT_A), contested),
      sweeping.sweeper.sweep(),
    ]);

    const acceptWon = settled[0].status === 'fulfilled';
    const sweepCount =
      settled[1].status === 'fulfilled' ? (settled[1].value as { expired: number }).expired : -1;

    const [contestedRow] = await db
      .select({ status: sessions.status, agentId: sessions.agentId })
      .from(sessions)
      .where(eq(sessions.id, contested));

    check(
      acceptWon !== (sweepCount === 1),
      `exactly one of accept and sweep won (accept=${acceptWon}, swept=${sweepCount})`,
    );
    check(
      acceptWon
        ? contestedRow?.status === SessionStatus.IN_CALL
        : contestedRow?.status === SessionStatus.QUEUED,
      'the row reflects the winner and not a blend of both',
    );
    check(
      acceptWon ? contestedRow?.agentId === AGENT_ONE : contestedRow?.agentId === null,
      'agent_id is set only if the accept won',
    );

    const contestedEvents = await db
      .select({ type: sessionEvents.eventType })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, contested));
    const outcomes = contestedEvents.filter(
      (e) =>
        e.type === SessionEventType.AGENT_ACCEPTED || e.type === SessionEventType.OFFER_EXPIRED,
    );
    check(outcomes.length === 1, 'exactly one outcome event — the loser rolled back');

    section('[race] two sweepers at once take disjoint batches');
    const many: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = await seedQueued(db);
      await goAvailable(AGENT_TWO, TENANT_A);
      await claimSvc.claim.claim(actor(AGENT_TWO, TENANT_A), id);
      many.push(id);
    }
    const past = new Date(expiresAt + 60_000);
    const sweeperOne = servicesFor(drizzle(clientOne), () => past);
    const sweeperTwo = servicesFor(drizzle(clientTwo), () => past);

    const [a, b] = await Promise.all([sweeperOne.sweeper.sweep(), sweeperTwo.sweeper.sweep()]);
    check(
      a.expired + b.expired === 12,
      `the twelve offers were expired once in total (${a.expired}+${b.expired})`,
    );

    const stillOffered = await db.select({ id: sessions.id }).from(sessions)
      .where(sql`${sessions.id} IN ${sql`(${sql.join(
      many.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`}
                 AND ${sessions.status} = ${SessionStatus.OFFERED}`);
    check(stillOffered.length === 0, 'none was left offered');

    const [{ doubled }] = await db.execute<{ doubled: string }>(sql`
      SELECT count(*)::text AS doubled FROM (
        SELECT session_id FROM session_events
         WHERE event_type = ${SessionEventType.OFFER_EXPIRED}
           AND tenant_id = ${TENANT_A}::uuid
         GROUP BY session_id HAVING count(*) > 1) AS d
    `);
    check(Number(doubled) === 0, 'and no session was expired twice');

    section('[presence] the swept agent is free again');
    check((await presenceOf(AGENT_TWO)) === AgentPresence.AVAILABLE, 'the agent is AVAILABLE');

    await clientOne.end();
    await clientTwo.end();

    process.stdout.write(
      failed === 0
        ? `\nALL ACCEPT AND SWEEP CHECKS PASSED (${passed})\n`
        : `\n${failed} CHECK(S) FAILED (${passed} passed)\n`,
    );
  } finally {
    const ours = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.tenantId, ALL_TENANTS));
    const ids = ours.map((row) => row.id);

    if (ids.length > 0) {
      await db.delete(sessionEvents).where(inArray(sessionEvents.sessionId, ids));
      await db.execute(sql`
        DELETE FROM billing_entries WHERE session_id IN ${sql`(${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`}
      `);
      await db.delete(sessions).where(inArray(sessions.id, ids));
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
