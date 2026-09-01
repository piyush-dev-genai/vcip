/**
 * Agent identity and presence against real PostgreSQL and real Redis.
 *
 * Several of T16's properties are claims about a real server that no fake can
 * establish. The in-memory presence store in `agents.e2e.spec.ts` expires keys
 * because it was written to; Redis expires them because it is Redis. The
 * difference matters for exactly the things this task rests on:
 *
 *   - that `agent:presence:{agent_id}` is really a HASH holding four fields,
 *   - that `EXPIRE` really removes it after the documented 15 seconds,
 *   - that the `touch` Lua script really refuses to create a key,
 *   - that `HSET` on one agent's key really leaves another's untouched,
 *   - that a scrypt hash written by the seed really verifies here.
 *
 * Everything provable without a server is in `src/agents/*.spec.ts`.
 *
 * Like `verify-events.ts` and `verify-queue.ts`, this lives in `scripts/`
 * rather than `db/`, so `git status -- apps/api/db/` stays a clean "no schema
 * change" signal.
 *
 * PostgreSQL work happens inside one transaction that is rolled back at the
 * end, so the two tenants and three users it needs never persist. Redis has no
 * rollback, so every key this run touches is deleted in a `finally` — the
 * seeded demo data and any real presence are never at risk.
 *
 *   pnpm --filter @vcip/api db:verify-presence
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { AgentPresence, SessionStatus } from '@vcip/shared';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { agentProfiles, sessions, tenants, users } from '../db/schema.js';
import { DrizzleAgentRepository } from '../src/agents/agent.repository.js';
import { AgentsService } from '../src/agents/agents.service.js';
import { presenceKey, PRESENCE_FIELDS, PRESENCE_TTL_SECONDS } from '../src/agents/presence.keys.js';
import { RedisPresenceRepository } from '../src/agents/presence.repository.js';
import { PresenceService } from '../src/agents/presence.service.js';
import { AGENT_ACTOR_CLAIM, AgentJwtGuard } from '../src/common/auth/agent-jwt.guard.js';
import type { AgentActor } from '../src/common/auth/auth-context.js';
import type { AuthConfig } from '../src/common/auth/auth.config.js';
import { hashPassword } from '../src/common/auth/password.js';
import { verifyJwt } from '../src/common/auth/tokens.js';
import { createLogger } from '../src/common/logging/logger.js';
// The availability guard asks PostgreSQL whether the agent holds work, so the
// presence service needs the session repository even on a path that never
// touches a session.
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake secrets, generated per run. They never leave this process. */
const TEST_AUTH_CONFIG: AuthConfig = {
  customerTokenSecret: `FAKE-customer-${randomUUID()}`,
  agentJwtSecret: `FAKE-agent-${randomUUID()}`,
  internalToken: `FAKE-internal-${randomUUID()}`,
  customerTokenTtlSeconds: 7200,
  agentJwtTtlSeconds: 3600,
};

/** Never a real credential. */
const PASSWORD = `FAKE-PASSWORD-${randomUUID()}`;

/** The minimum an `AgentJwtGuard` needs to see. */
const contextWith = (authorization?: string): ExecutionContext => {
  const request: { headers: Record<string, string>; actor?: unknown } = {
    headers: authorization === undefined ? {} : { authorization },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

/** Thrown to roll back the PostgreSQL block without reporting an error. */
class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
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

  const runId = randomUUID().slice(0, 8);
  const AGENT_A1 = randomUUID();
  const AGENT_A2 = randomUUID();
  const AGENT_B1 = randomUUID();
  const ADMIN_A = randomUUID();
  const touchedKeys = new Set<string>([
    presenceKey(AGENT_A1),
    presenceKey(AGENT_A2),
    presenceKey(AGENT_B1),
    presenceKey(ADMIN_A),
  ]);

  const presenceRepo = new RedisPresenceRepository(redis);
  const logger = createLogger({ level: 'silent' });

  try {
    section('[ping] servers reachable');
    check((await redis.ping()) === 'PONG', 'redis answers PING');
    const [alive] = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
    check(Number(alive?.ok) === 1, 'postgresql answers a query');

    // The seed's own work, checked without knowing the password it chose.
    section('[seed] the development seed provisioned agent credentials');
    const [seeded] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users WHERE role = 'AGENT' AND password_hash IS NOT NULL`);
    check(
      Number(seeded?.n) > 0,
      'at least one seeded AGENT has a password hash (run db:seed if this fails)',
    );
    const [scheme] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users
       WHERE role = 'AGENT' AND password_hash IS NOT NULL AND password_hash NOT LIKE 'scrypt$%'`);
    check(Number(scheme?.n) === 0, 'every stored agent hash uses the scrypt encoding');

    await db
      .transaction(async (tx) => {
        // ------------------------------------------------------ fixtures
        //
        // Two tenants, because every cross-tenant claim in T16 is untestable
        // with one. The T08 seed provisions a single tenant, so these are
        // created here and rolled back rather than added to it.
        const passwordHash = await hashPassword(PASSWORD);

        const [tenantA] = await tx
          .insert(tenants)
          .values({ slug: `verify-a-${runId}`, name: `verify A ${runId}`, status: 'ACTIVE' })
          .returning({ id: tenants.id });
        const [tenantB] = await tx
          .insert(tenants)
          .values({ slug: `verify-b-${runId}`, name: `verify B ${runId}`, status: 'ACTIVE' })
          .returning({ id: tenants.id });
        if (tenantA === undefined || tenantB === undefined) throw new Error('tenant insert failed');

        await tx.insert(users).values([
          {
            id: AGENT_A1,
            tenantId: tenantA.id,
            // The same address in both tenants: the case the per-tenant unique
            // index permits and login has to disambiguate.
            email: `shared-${runId}@verify.local`,
            role: 'AGENT',
            status: 'ACTIVE',
            passwordHash,
          },
          {
            id: AGENT_A2,
            tenantId: tenantA.id,
            email: `second-${runId}@verify.local`,
            role: 'AGENT',
            status: 'ACTIVE',
            passwordHash,
          },
          {
            id: AGENT_B1,
            tenantId: tenantB.id,
            email: `shared-${runId}@verify.local`,
            role: 'AGENT',
            status: 'ACTIVE',
            passwordHash,
          },
          {
            id: ADMIN_A,
            tenantId: tenantA.id,
            email: `admin-${runId}@verify.local`,
            role: 'TENANT_ADMIN',
            status: 'ACTIVE',
            passwordHash,
          },
        ]);

        await tx.insert(agentProfiles).values([
          { userId: AGENT_A1, languages: ['en', 'hi'], maxConcurrent: 1 },
          { userId: AGENT_A2, languages: ['ta'], maxConcurrent: 2 },
          { userId: AGENT_B1, languages: ['en'], maxConcurrent: 1 },
        ]);

        const agentRepo = new DrizzleAgentRepository(tx);
        const sessionRepo = new DrizzleSessionRepository(tx, {
          append: () => {
            throw new Error('presence must not append a session event');
          },
        });
        const login = new AgentsService(agentRepo, TEST_AUTH_CONFIG);
        const presence = new PresenceService(presenceRepo, agentRepo, sessionRepo, logger);
        const guard = new AgentJwtGuard(TEST_AUTH_CONFIG);

        const actorA1: AgentActor = {
          kind: 'agent',
          tenantId: tenantA.id,
          userId: AGENT_A1,
          role: 'AGENT',
        };
        const actorA2: AgentActor = {
          kind: 'agent',
          tenantId: tenantA.id,
          userId: AGENT_A2,
          role: 'AGENT',
        };
        const actorB1: AgentActor = {
          kind: 'agent',
          tenantId: tenantB.id,
          userId: AGENT_B1,
          role: 'AGENT',
        };

        const rejects = async (promise: Promise<unknown>): Promise<boolean> =>
          promise.then(
            () => false,
            () => true,
          );

        // ------------------------------------------------------- login

        section('[login] real rows, real scrypt');
        const issued = await login.login({
          tenant_slug: `verify-a-${runId}`,
          email: `shared-${runId}@verify.local`,
          password: PASSWORD,
        });
        check(issued.token_type === 'Bearer', 'a valid login returns a Bearer token');
        check(
          Date.parse(issued.expires_at) > Date.now(),
          'expires_at is an ISO timestamp in the future',
        );
        check(!JSON.stringify(issued).includes('scrypt'), 'the response carries no password hash');

        const claims = verifyJwt(
          issued.access_token,
          TEST_AUTH_CONFIG.agentJwtSecret,
          AGENT_ACTOR_CLAIM,
        );
        check(claims['uid'] === AGENT_A1, 'the token carries the user id from the database row');
        check(
          claims['tid'] === tenantA.id,
          'the token carries the tenant from the row, not from the request',
        );
        check(claims['role'] === 'AGENT', 'the token carries the role');

        section('[login] rejections');
        check(
          await rejects(
            login.login({
              tenant_slug: `verify-a-${runId}`,
              email: `shared-${runId}@verify.local`,
              password: `${PASSWORD}-wrong`,
            }),
          ),
          'a wrong password is rejected',
        );
        check(
          await rejects(
            login.login({
              tenant_slug: `verify-a-${runId}`,
              email: `nobody-${runId}@verify.local`,
              password: PASSWORD,
            }),
          ),
          'an unknown email is rejected',
        );
        check(
          await rejects(
            login.login({
              tenant_slug: `verify-a-${runId}`,
              email: `admin-${runId}@verify.local`,
              password: PASSWORD,
            }),
          ),
          'a TENANT_ADMIN cannot log into the agent surface',
        );

        // Tenant B's slug with the shared address resolves to B's own user.
        const asB = await login.login({
          tenant_slug: `verify-b-${runId}`,
          email: `shared-${runId}@verify.local`,
          password: PASSWORD,
        });
        const claimsB = verifyJwt(
          asB.access_token,
          TEST_AUTH_CONFIG.agentJwtSecret,
          AGENT_ACTOR_CLAIM,
        );
        check(
          claimsB['uid'] === AGENT_B1 && claimsB['tid'] === tenantB.id,
          'the same email in two tenants resolves to the right user in each',
        );

        section('[guard] AgentJwtGuard against a freshly minted token');
        check(
          guard.canActivate(contextWith(`Bearer ${issued.access_token}`)),
          'the guard accepts a token issued by login',
        );
        for (const [label, header] of [
          ['no header', undefined],
          ['a malformed token', 'Bearer not.a.token'],
          ['a bare token with no scheme', issued.access_token],
        ] as const) {
          let accepted = true;
          try {
            guard.canActivate(contextWith(header));
          } catch {
            accepted = false;
          }
          check(!accepted, `the guard rejects ${label}`);
        }

        // ------------------------------------------------- availability

        section('[presence] AVAILABLE writes the documented key');
        await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        const key = presenceKey(AGENT_A1);

        check((await redis.exists(key)) === 1, `${key} exists`);
        check((await redis.type(key)) === 'hash', 'the key is a HASH');

        const stored = await redis.hgetall(key);
        check(
          Object.keys(stored).sort().join(',') === [...PRESENCE_FIELDS].sort().join(','),
          'the hash holds exactly status, languages, last_seen, tenant_id',
        );
        check(stored['status'] === 'AVAILABLE', 'status is AVAILABLE');
        check(
          stored['languages'] === '["en","hi"]',
          'languages are the snapshot from agent_profiles',
        );
        check(stored['tenant_id'] === tenantA.id, 'tenant_id is the authenticated tenant');
        check(
          !Number.isNaN(Date.parse(stored['last_seen'] ?? '')),
          'last_seen is a parseable timestamp',
        );
        const raw = JSON.stringify(stored);
        check(
          !raw.includes('verify.local') && !raw.includes('scrypt') && !raw.includes(PASSWORD),
          'the hash carries no email, hash, or credential',
        );
        check(!raw.includes('max_concurrent'), 'max_concurrent is not copied into Redis');

        section('[ttl] the documented 15 seconds');
        const ttl = await redis.ttl(key);
        check(
          ttl > 0 && ttl <= PRESENCE_TTL_SECONDS,
          `TTL is armed and at most ${PRESENCE_TTL_SECONDS}s (saw ${ttl})`,
        );
        check(ttl >= PRESENCE_TTL_SECONDS - 1, 'TTL is approximately the documented value');

        // ---------------------------------------------------- heartbeat

        section('[heartbeat] refreshes without recreating');
        const before = await redis.hget(key, 'last_seen');
        // Decay the TTL the way ten seconds of silence would, without waiting
        // ten seconds. The expiry itself is exercised for real below.
        await redis.expire(key, 4);
        check((await redis.ttl(key)) <= 4, 'the TTL decayed');

        await sleep(1100);
        const beat = await presence.heartbeat(actorA1);
        check((await redis.ttl(key)) >= PRESENCE_TTL_SECONDS - 1, 'the heartbeat re-armed the TTL');
        check(beat.status === 'AVAILABLE', 'the heartbeat reports the existing status');
        check(
          beat.last_seen !== before && (await redis.hget(key, 'last_seen')) === beat.last_seen,
          'the heartbeat advanced last_seen in Redis',
        );
        check(
          (await redis.hget(key, 'languages')) === '["en","hi"]',
          'the heartbeat left the languages snapshot alone',
        );

        // ------------------------------------------------------- expiry

        section('[expiry] Redis TTL is the liveness mechanism');
        await redis.expire(key, 1);
        await sleep(1400);
        check((await redis.exists(key)) === 0, 'the presence key really expired');

        const afterExpiry = await presence.heartbeat(actorA1);
        check(
          afterExpiry.status === 'UNAVAILABLE' && afterExpiry.last_seen === null,
          'a heartbeat after expiry reports the agent not live',
        );
        check(
          (await redis.exists(key)) === 0,
          'the heartbeat did NOT recreate the key (the Lua existence check holds)',
        );

        // -------------------------------------------------- unavailable

        section('[unavailable] the key is removed');
        await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        check((await redis.exists(key)) === 1, 'AVAILABLE recreated the presence');
        await presence.setAvailability(actorA1, AgentPresence.UNAVAILABLE);
        check((await redis.exists(key)) === 0, 'UNAVAILABLE deleted the key');

        await presence.setAvailability(actorA1, AgentPresence.UNAVAILABLE);
        check((await redis.exists(key)) === 0, 'repeating UNAVAILABLE is safe');

        const beatWhileGone = await presence.heartbeat(actorA1);
        check(
          beatWhileGone.status === 'UNAVAILABLE' && (await redis.exists(key)) === 0,
          'a heartbeat does not resurrect an agent who chose UNAVAILABLE',
        );

        // --------------------------------------------------------- busy

        section('[busy] the internal mechanism');
        check(
          (await presence.markBusy(AGENT_A1)) === false,
          'markBusy on no presence returns false',
        );
        check((await redis.exists(key)) === 0, 'markBusy created nothing');

        await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        check((await presence.markBusy(AGENT_A1)) === true, 'markBusy on a live presence succeeds');
        check((await redis.hget(key, 'status')) === 'BUSY', 'the stored status is BUSY');

        const beatWhileBusy = await presence.heartbeat(actorA1);
        check(
          beatWhileBusy.status === 'BUSY' && (await redis.hget(key, 'status')) === 'BUSY',
          'a heartbeat reports BUSY and does not clear it',
        );
        check(
          (await redis.hget(key, 'languages')) === '["en","hi"]',
          'the busy cycle preserved the languages snapshot',
        );

        check(
          (await presence.markAvailable(AGENT_A1)) === true,
          'markAvailable restores the agent',
        );
        check((await redis.hget(key, 'status')) === 'AVAILABLE', 'the stored status is AVAILABLE');

        // No route reaches BUSY: the availability path treats anything that is
        // not AVAILABLE as the removal branch.
        await presence.setAvailability(actorA1, AgentPresence.BUSY);
        check(
          (await redis.exists(key)) === 0,
          'availability called with BUSY does not produce a BUSY presence',
        );

        // ------------------------------------- availability while busy

        section('[availability] an agent holding work cannot go AVAILABLE');
        // The manual-E2E regression. R5 makes BUSY internal — "set on claim,
        // cleared on session end" — which is only true if AVAILABLE cannot
        // overwrite it. Redis is deliberately left saying AVAILABLE here, so
        // the refusal below can only come from PostgreSQL.
        await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);

        const [held] = await tx
          .insert(sessions)
          .values({
            tenantId: tenantA.id,
            externalRef: `vp-${runId}-busy`,
            status: SessionStatus.IN_CALL,
            language: 'en',
            agentId: AGENT_A1,
            connectedAt: new Date(),
          })
          .returning({ id: sessions.id });
        if (held === undefined) throw new Error('session insert failed');

        check(
          (await sessionRepo.countActiveWork(tenantA.id, AGENT_A1)) === 1,
          'postgresql reports the agent holding one session',
        );

        let refusedCode = '';
        try {
          await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        } catch (error) {
          refusedCode =
            (error as { code?: string; response?: { code?: string } }).code ??
            (error as { response?: { code?: string } }).response?.code ??
            '';
        }
        check(
          refusedCode === 'CONFLICT',
          'requesting AVAILABLE while IN_CALL is refused with CONFLICT',
        );
        check(
          (await redis.hget(key, 'status')) === 'AVAILABLE',
          'and the refusal wrote nothing — redis is exactly as it was',
        );

        await presence.markBusy(AGENT_A1);
        let refusedAgain = '';
        try {
          await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        } catch (error) {
          refusedAgain = (error as { code?: string }).code ?? '';
        }
        check(refusedAgain === 'CONFLICT', 'a BUSY agent is refused too');
        check(
          (await redis.hget(key, 'status')) === 'BUSY',
          'and BUSY survives — the bug was this reading AVAILABLE',
        );

        // Stepping away is always allowed: it releases no session.
        const stepAway = await presence.setAvailability(actorA1, AgentPresence.UNAVAILABLE);
        check(stepAway.status === 'UNAVAILABLE', 'a busy agent may still go UNAVAILABLE');
        check((await redis.exists(key)) === 0, 'and the key is removed');

        // An offer, not yet accepted, counts the same way.
        await tx
          .update(sessions)
          .set({
            status: SessionStatus.OFFERED,
            agentId: null,
            offeredToAgentId: AGENT_A1,
            offeredAt: new Date(),
            offerExpiresAt: new Date(Date.now() + 30_000),
          })
          .where(eq(sessions.id, held.id));

        let offeredCode = '';
        try {
          await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        } catch (error) {
          offeredCode = (error as { code?: string }).code ?? '';
        }
        check(offeredCode === 'CONFLICT', 'an unaccepted offer blocks AVAILABLE as well');

        // Ending the session releases the agent, and nothing about Redis
        // changed — only the answer PostgreSQL gives.
        await tx
          .update(sessions)
          .set({ status: SessionStatus.APPROVED, offeredToAgentId: null, offerExpiresAt: null })
          .where(eq(sessions.id, held.id));

        const freed = await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        check(freed.status === 'AVAILABLE', 'once the session ends, availability works normally');
        check(
          (await redis.hget(key, 'status')) === 'AVAILABLE',
          'and the presence is written again',
        );

        // AGENT_A2 has max_concurrent = 2, so one held session leaves room.
        await tx.insert(sessions).values({
          tenantId: tenantA.id,
          externalRef: `vp-${runId}-spare`,
          status: SessionStatus.IN_CALL,
          language: 'ta',
          agentId: AGENT_A2,
          connectedAt: new Date(),
        });
        const spare = await presence.setAvailability(actorA2, AgentPresence.AVAILABLE);
        check(
          spare.status === 'AVAILABLE',
          'an agent below max_concurrent may still go available (capacity preserved)',
        );

        // ---------------------------------------------------- isolation

        section('[isolation] agent and tenant');
        await presence.setAvailability(actorA1, AgentPresence.AVAILABLE);
        await presence.setAvailability(actorA2, AgentPresence.AVAILABLE);
        await presence.setAvailability(actorB1, AgentPresence.AVAILABLE);

        check(
          (await redis.hget(presenceKey(AGENT_A2), 'languages')) === '["ta"]',
          'each agent gets its own profile languages',
        );
        check(
          (await redis.hget(presenceKey(AGENT_B1), 'tenant_id')) === tenantB.id,
          'the other tenant’s agent records its own tenant',
        );

        const snapshotA2 = await redis.hgetall(presenceKey(AGENT_A2));
        const snapshotB1 = await redis.hgetall(presenceKey(AGENT_B1));
        await presence.setAvailability(actorA1, AgentPresence.UNAVAILABLE);
        await presence.heartbeat(actorA1);
        await presence.markBusy(AGENT_A1);

        check(
          JSON.stringify(await redis.hgetall(presenceKey(AGENT_A2))) === JSON.stringify(snapshotA2),
          'agent A1’s whole lifecycle left agent A2 byte-identical',
        );
        check(
          JSON.stringify(await redis.hgetall(presenceKey(AGENT_B1))) === JSON.stringify(snapshotB1),
          'and left the other tenant’s agent byte-identical',
        );

        check(
          await rejects(
            presence.setAvailability({ ...actorA1, tenantId: tenantB.id }, AgentPresence.AVAILABLE),
          ),
          'a token naming the wrong tenant for its user is refused',
        );
        check(
          await rejects(
            presence.setAvailability(
              { kind: 'agent', tenantId: tenantA.id, userId: ADMIN_A, role: 'TENANT_ADMIN' },
              AgentPresence.AVAILABLE,
            ),
          ),
          'a user with no agent profile is refused',
        );
        check(
          (await redis.exists(presenceKey(ADMIN_A))) === 0,
          'the refused admin got no presence key',
        );

        // ------------------------------------------- no business writes

        section('[postgresql] presence writes nothing durable');
        const [counts] = await tx.execute<{ sessions: number; events: number }>(sql`
          SELECT (SELECT count(*)::int FROM sessions) AS sessions,
                 (SELECT count(*)::int FROM session_events) AS events`);
        await presence.setAvailability(actorA2, AgentPresence.AVAILABLE);
        await presence.heartbeat(actorA2);
        await presence.heartbeat(actorA2);
        const [after] = await tx.execute<{ sessions: number; events: number }>(sql`
          SELECT (SELECT count(*)::int FROM sessions) AS sessions,
                 (SELECT count(*)::int FROM session_events) AS events`);
        check(
          Number(counts?.sessions) === Number(after?.sessions),
          'availability and heartbeat created no session',
        );
        check(
          Number(counts?.events) === Number(after?.events),
          'availability and heartbeat created no session_event',
        );

        const [profileUnchanged] = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM agent_profiles
           WHERE user_id = ${AGENT_A2} AND languages = ARRAY['ta']::text[]`);
        check(Number(profileUnchanged?.n) === 1, 'agent_profiles is unchanged by presence work');

        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    section('[rollback] the fixtures left no rows behind');
    const [leftover] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users WHERE email LIKE ${`%-${runId}@verify.local`}`);
    check(Number(leftover?.n) === 0, 'the rolled-back users are gone');
  } finally {
    // Redis has no rollback. Delete exactly the keys this run created.
    await redis.del(...touchedKeys);
    await redis.quit();
    await client.end();
  }

  section(
    failed === 0
      ? `ALL PRESENCE CHECKS PASSED (${passed})`
      : `${failed} CHECK(S) FAILED (${passed} passed)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `\nVERIFY PRESENCE FAILED: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exit(1);
});
