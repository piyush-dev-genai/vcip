/**
 * The call-start timeout against real PostgreSQL and Redis.
 *
 * The unit suites prove the arming and the sweep against fakes. Three things
 * are claims about a real deployment and can be made nowhere else:
 *
 *   - that a deadline member carrying `start` survives a round trip through a
 *     real ZSET and is read back by the sweeper — the two departure reasons
 *     have always worked, and a third that parsed only in a fake would be a
 *     timeout that never fires,
 *   - that a session nobody joined actually reaches `DROPPED_IN_CALL` with a
 *     billing row and a null `talk_ms`,
 *   - and that a *started* call with a late deadline is left alone, which is
 *     the failure that would matter: ending a live verification on a stale
 *     timer.
 *
 * Committed fixtures, deleted in the `finally`. The sweeper's transitions are
 * committed writes, so there is no rolled-back half here.
 *
 *   pnpm --filter @vcip/api db:verify-call-start
 */

import { randomUUID } from 'node:crypto';
import { AgentPresence, SessionEventType, SessionStatus } from '@vcip/shared';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { billingEntries, sessionEvents, sessions, tenants, users } from '../db/schema.js';
import { DrizzleAgentRepository } from '../src/agents/agent.repository.js';
import { presenceKey } from '../src/agents/presence.keys.js';
import { RedisPresenceRepository } from '../src/agents/presence.repository.js';
import { PresenceService } from '../src/agents/presence.service.js';
import { DrizzleSessionEventWriter } from '../src/common/events/index.js';
import { createLogger } from '../src/common/logging/logger.js';
import { CallSweeper } from '../src/livekit/call-sweeper.service.js';
import {
  CALL_START_TIMEOUT_SECONDS,
  CallDeadline,
  DEADLINES_KEY,
} from '../src/livekit/call.keys.js';
import { RedisCallRepository } from '../src/livekit/call.repository.js';
import { RecordingNotifications } from '../src/realtime/notifications.testing.js';
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

const section = (label: string): void => process.stdout.write(`\n${label}\n`);

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client);
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
    db: Number(process.env['REDIS_DB'] ?? 0),
  });

  const runId = randomUUID().slice(0, 8);
  const TENANT = randomUUID();
  const AGENT = randomUUID();
  const NEVER_JOINED = randomUUID();
  const DID_START = randomUUID();

  const logger = createLogger({ level: 'silent' });
  const calls = new RedisCallRepository(redis);
  const repo = new DrizzleSessionRepository(db, new DrizzleSessionEventWriter());
  const presenceRepo = new RedisPresenceRepository(redis);
  const presence = new PresenceService(
    presenceRepo,
    new DrizzleAgentRepository(db),
    repo,
    logger,
    () => new Date(),
  );
  const sweeper = new CallSweeper(
    repo,
    calls,
    presence,
    new RecordingNotifications(),
    logger,
    false,
    () => new Date(),
  );

  const seedSession = async (id: string, withCallStarted: boolean): Promise<void> => {
    await db.insert(sessions).values({
      id,
      tenantId: TENANT,
      externalRef: `verify-call-start-${runId}`,
      status: SessionStatus.IN_CALL,
      language: 'en',
      roomName: `vcip_${id}`,
      agentId: AGENT,
      queuedAt: new Date(Date.now() - 300_000),
      connectedAt: new Date(Date.now() - 240_000),
    });

    if (withCallStarted) {
      await db.insert(sessionEvents).values({
        tenantId: TENANT,
        sessionId: id,
        eventType: SessionEventType.CALL_STARTED,
        actorType: 'SYSTEM',
        payload: {},
        serverTs: new Date(Date.now() - 200_000),
      });
    }
  };

  try {
    await db.insert(tenants).values({
      id: TENANT,
      slug: `vcs-${runId}`,
      name: `verify call start ${runId}`,
      status: 'ACTIVE',
    });
    await db.insert(users).values({
      id: AGENT,
      tenantId: TENANT,
      email: `agent-${runId}@verify.local`,
      role: 'AGENT',
      status: 'ACTIVE',
    });

    await seedSession(NEVER_JOINED, false);
    await seedSession(DID_START, true);

    await presenceRepo.set({
      agentId: AGENT,
      tenantId: TENANT,
      status: AgentPresence.BUSY,
      languages: ['en'],
      lastSeen: new Date(),
    });

    section('The window is armed and read back through a real ZSET');

    const due = Date.now() - 1_000;
    await calls.armDeadline(NEVER_JOINED, CallDeadline.START, due);
    await calls.armDeadline(DID_START, CallDeadline.START, due);

    const armed = await redis.zscore(DEADLINES_KEY, `${NEVER_JOINED}:start`);
    check(armed !== null, 'a start deadline survives a round trip through Redis');
    check(CALL_START_TIMEOUT_SECONDS === 120, 'the window is two minutes');

    section('A call nobody joined');

    const result = await sweeper.sweep();
    check(result.due >= 2, 'the sweeper saw both deadlines');

    const [dropped] = await db
      .select({
        status: sessions.status,
        talkMs: sessions.talkMs,
        endedAt: sessions.endedAt,
        verdict: sessions.verdict,
      })
      .from(sessions)
      .where(eq(sessions.id, NEVER_JOINED));

    check(dropped?.status === SessionStatus.DROPPED_IN_CALL, 'ends as DROPPED_IN_CALL');
    check(dropped?.talkMs === null, 'has no talk time, because the call never began');
    check(dropped?.endedAt !== null, 'is stamped with an end');
    check(dropped?.verdict === null, 'carries no verdict: nobody decided anything');

    const [bill] = await db
      .select({ amount: billingEntries.amountPaise, category: billingEntries.category })
      .from(billingEntries)
      .where(eq(billingEntries.sessionId, NEVER_JOINED));
    check(bill?.amount === 500 && bill.category === 'FAILED', 'is billed Rs 5 as FAILED');

    const events = await db
      .select({ type: sessionEvents.eventType, payload: sessionEvents.payload })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, NEVER_JOINED));
    const ended = events.find((event) => event.type === SessionEventType.CALL_ENDED);
    check(
      (ended?.payload as { reason?: string } | null)?.reason === 'call_never_started',
      'says in the history that the call never began',
    );

    const freed = await presenceRepo.read(AGENT);
    check(freed?.status === AgentPresence.AVAILABLE, 'frees the agent (R5)');

    section('A call that did start is left alone');

    const [survivor] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, DID_START));
    check(survivor?.status === SessionStatus.IN_CALL, 'a started call is still in call');

    const bills = await db
      .select({ id: billingEntries.sessionId })
      .from(billingEntries)
      .where(eq(billingEntries.sessionId, DID_START));
    check(bills.length === 0, 'and was charged nothing');

    const leftover = await redis.zscore(DEADLINES_KEY, `${DID_START}:start`);
    check(leftover === null, 'its stale deadline was taken so it cannot fire again');
  } finally {
    for (const id of [NEVER_JOINED, DID_START]) {
      await redis.zrem(DEADLINES_KEY, `${id}:start`);
      await db.delete(billingEntries).where(eq(billingEntries.sessionId, id));
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, id));
      await db.delete(sessions).where(eq(sessions.id, id));
    }
    await redis.del(presenceKey(AGENT));
    await db.delete(users).where(inArray(users.id, [AGENT]));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
    await client.end();
    redis.disconnect();
  }

  process.stdout.write(`\n=== RESULT: ${String(passed)} passed, ${String(failed)} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stdout.write(`\nVERIFY FAILED: ${String(error)}\n`);
  process.exit(1);
});
