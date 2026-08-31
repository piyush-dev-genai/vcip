/**
 * The Day 2 gate, end to end (T22, T23).
 *
 * `docs/05-development-plan.md`:
 *
 *   > Gate (mandatory): two concurrent claims produce one 200 and one 409.
 *   > Offer timeout returns the session to the queue unbilled.
 *
 * Both sentences are about HTTP. The other verification scripts prove the
 * underlying properties at the service and repository level against a real
 * database, and the HTTP suites prove the status mapping against fakes — but
 * neither of those is the gate. "One 200 and one 409" is a claim about two real
 * requests arriving at a real server at the same time, and this is the only
 * artifact that makes it.
 *
 * So this spawns the **actual built server** — `dist/src/main.js`, the same
 * entry point production runs, with every guard, interceptor, pipe and filter
 * in place — on a free port against real PostgreSQL and real Redis, and drives
 * it with nothing but `fetch`. Spawning rather than bootstrapping in-process is
 * deliberate: it is the artifact that ships, and nothing about this test can
 * accidentally construct a friendlier application than the real one.
 *
 * It needs a current build. `pnpm --filter @vcip/api build` first, or use the
 * package script, which does it.
 *
 * The sessions it claims come from the genuine customer flow: create, consent,
 * preflight, location, queue. Nothing is planted.
 *
 * Its tenant sets `offer_timeout_seconds = 1`, so the expiry half of the gate
 * takes a second rather than half a minute. Everything it creates is deleted in
 * the `finally`.
 *
 *   pnpm --filter @vcip/api db:verify-day2-gate
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionEventType, SessionStatus } from '@vcip/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import {
  agentProfiles,
  checklistTemplates,
  sessionEvents,
  sessions,
  tenantApiKeys,
  tenants,
  users,
} from '../db/schema.js';
import { presenceKey } from '../src/agents/presence.keys.js';
import { hashApiKey } from '../src/common/auth/api-key.store.js';
import { hashPassword } from '../src/common/auth/password.js';
import { queueKey } from '../src/queue/queue.keys.js';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A port the OS says is free right now. Good enough: nothing else is racing. */
const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });

/** Wait for the spawned server to answer, or give up with what it printed. */
const waitForHealth = async (api: string, output: () => string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`${api}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(`the api did not become healthy:\n${output()}`);
};

/**
 * Development-only values, generated for this process.
 *
 * Set before the application module is read, because `auth.config.ts` reads the
 * environment at construction. They never leave this process and are not the
 * developer's own secrets.
 */
const TEST_ENV: Readonly<Record<string, string>> = {
  VCIP_AGENT_JWT_SECRET: `gate-agent-secret-${randomUUID()}`,
  VCIP_CUSTOMER_TOKEN_SECRET: `gate-customer-secret-${randomUUID()}`,
  VCIP_INTERNAL_TOKEN: `gate-internal-token-${randomUUID()}`,
  CUSTOMER_ORIGIN: 'http://localhost:3000',
  AGENT_ORIGIN: 'http://localhost:3002',
};

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;

  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const client = postgres(databaseUrl, { max: 4 });
  const db = drizzle(client);
  const redis = new Redis(redisUrl, { db: Number(process.env['REDIS_DB'] ?? 0) });

  const runId = randomUUID().slice(0, 8);
  const TENANT = randomUUID();
  const AGENT_ONE = randomUUID();
  const AGENT_TWO = randomUUID();
  const SLUG = `gate-${runId}`;
  const PASSWORD = `gate-password-${randomUUID()}`;
  const API_KEY = `vcip_gate${runId}_${randomUUID().replace(/-/g, '')}`;
  const API_KEY_PREFIX = API_KEY.slice(0, API_KEY.indexOf('_', 5));

  const touchedKeys = new Set<string>([presenceKey(AGENT_ONE), presenceKey(AGENT_TWO)]);
  for (const language of ['en', 'hi', 'ta']) touchedKeys.add(queueKey(TENANT, language));

  let server: ChildProcess | null = null;
  let serverOutput = '';

  try {
    section('[fixture] a tenant whose offers expire in one second');
    const hash = await hashPassword(PASSWORD);
    await db.insert(tenants).values({
      id: TENANT,
      slug: SLUG,
      name: `day 2 gate ${runId}`,
      status: 'ACTIVE',
      // The whole reason the expiry half of this gate runs in a second.
      offerTimeoutSeconds: 1,
    });
    await db.insert(users).values([
      {
        id: AGENT_ONE,
        tenantId: TENANT,
        email: `one-${runId}@gate.local`,
        role: 'AGENT',
        status: 'ACTIVE',
        passwordHash: hash,
      },
      {
        id: AGENT_TWO,
        tenantId: TENANT,
        email: `two-${runId}@gate.local`,
        role: 'AGENT',
        status: 'ACTIVE',
        passwordHash: hash,
      },
    ]);
    await db.insert(agentProfiles).values([
      { userId: AGENT_ONE, languages: ['en'], maxConcurrent: 1 },
      { userId: AGENT_TWO, languages: ['en'], maxConcurrent: 1 },
    ]);
    await db.insert(tenantApiKeys).values({
      tenantId: TENANT,
      keyPrefix: API_KEY_PREFIX,
      keyHash: hashApiKey(API_KEY),
      scopes: ['sessions:write'],
    });
    await db.insert(checklistTemplates).values({
      tenantId: TENANT,
      version: 1,
      items: [{ key: 'face_match', label: 'Face matches', required: true }],
      active: true,
    });
    check(true, 'tenant, two agents, api key and checklist created');

    section('[boot] the built server, as production runs it');
    const port = await freePort();
    const API = `http://127.0.0.1:${port}`;
    const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    server = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()));
    server.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()));

    await waitForHealth(API, () => serverOutput);
    check(true, `dist/src/main.js is serving on ${API}`);
    check(serverOutput.includes('/v1/agent/sessions/:id/accept'), 'with the accept route mapped');
    check(serverOutput.includes('/internal/offers/sweep'), 'and the sweep route mapped');

    // ------------------------------------------------------------ helpers

    const json = async (res: Response): Promise<Record<string, never>> => {
      const text = await res.text();
      try {
        return JSON.parse(text) as Record<string, never>;
      } catch {
        return {} as Record<string, never>;
      }
    };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${API}${path}`, { method: 'GET', headers });
    const bearer = (token: string): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
    });

    let keys = 0;
    const idem = (): string => `gate-${runId}-${(keys += 1)}`;

    /** The genuine customer path, over HTTP. */
    const queueOne = async (ref: string): Promise<string> => {
      const created = (await json(
        await post(
          '/v1/sessions',
          { external_ref: ref, language: 'en' },
          { ...bearer(API_KEY), 'Idempotency-Key': `create-${ref}` },
        ),
      )) as unknown as { data?: { session_id: string; customer_token: string } };
      const id = created.data?.session_id;
      const token = created.data?.customer_token;
      if (id === undefined || token === undefined) {
        throw new Error(`create failed: ${JSON.stringify(created)}`);
      }
      const h = bearer(token);
      await post(`/v1/sessions/${id}/consent`, { accepted: true, consent_version: 'v1' }, h);
      await post(
        `/v1/sessions/${id}/preflight`,
        {
          camera_width: 1280,
          camera_height: 720,
          microphone_level: 60,
          network_rtt_ms: 40,
          downlink_kbps: 5000,
          lighting_score: 80,
          stability_score: 80,
        },
        h,
      );
      await post(
        `/v1/sessions/${id}/location`,
        {
          latitude: 19.076,
          longitude: 72.8777,
          accuracy_m: 20,
          captured_at: new Date().toISOString(),
        },
        h,
      );
      await post(`/v1/sessions/${id}/queue`, {}, { ...h, 'Idempotency-Key': `queue-${ref}` });
      return id;
    };

    const login = async (email: string): Promise<string> => {
      const res = await post('/v1/agent/login', {
        tenant_slug: SLUG,
        email,
        password: PASSWORD,
      });
      const body = (await json(res)) as unknown as { data?: { access_token: string } };
      if (res.status !== 200 || body.data === undefined) {
        throw new Error(`login failed: ${res.status}`);
      }
      return body.data.access_token;
    };

    const goAvailable = (token: string) =>
      post('/v1/agent/availability', { status: 'AVAILABLE' }, bearer(token));

    const claim = (id: string, token: string) =>
      post(`/v1/agent/sessions/${id}/claim`, {}, { ...bearer(token), 'Idempotency-Key': idem() });

    const billingFor = async (sessionId: string): Promise<number> => {
      const [row] = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM billing_entries WHERE session_id = ${sessionId}::uuid
      `);
      return Number(row?.n ?? 0);
    };

    // ==================================================== T22: the claim race

    section('[T22] two concurrent claims produce one 200 and one 409');
    const tokenOne = await login(`one-${runId}@gate.local`);
    const tokenTwo = await login(`two-${runId}@gate.local`);
    await goAvailable(tokenOne);
    await goAvailable(tokenTwo);

    const contested = await queueOne(`gate-race-${runId}`);

    // Two real requests, in flight together, over the whole stack: guards,
    // idempotency interceptor, validation pipe, service, and the conditional
    // UPDATE that actually decides.
    const [first, second] = await Promise.all([
      claim(contested, tokenOne),
      claim(contested, tokenTwo),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    const bodies = await Promise.all([json(first), json(second)]);

    check(statuses[0] === 200, `exactly one claim returned 200 (got ${statuses.join(' and ')})`);
    check(statuses[1] === 409, `and exactly one returned 409 (got ${statuses.join(' and ')})`);

    const loser = bodies[first.status === 409 ? 0 : 1] as unknown as {
      error?: { code?: string };
    };
    check(
      loser.error?.code === 'SESSION_ALREADY_ASSIGNED',
      'the loser is told SESSION_ALREADY_ASSIGNED (D5)',
    );

    const winner = bodies[first.status === 200 ? 0 : 1] as unknown as {
      data?: { offered_to_agent_id?: string };
    };
    const winningAgent = winner.data?.offered_to_agent_id;
    check(
      winningAgent === AGENT_ONE || winningAgent === AGENT_TWO,
      'the winner is one of the two contenders',
    );

    const [raced] = await db
      .select({ status: sessions.status, offeredTo: sessions.offeredToAgentId })
      .from(sessions)
      .where(eq(sessions.id, contested));
    check(raced?.status === SessionStatus.OFFERED, 'the session is OFFERED exactly once');
    check(raced?.offeredTo === winningAgent, 'and offered to the agent that got the 200');

    const racedEvents = await db
      .select({ type: sessionEvents.eventType })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, contested));
    check(
      racedEvents.filter((e) => e.type === SessionEventType.SESSION_ASSIGNED).length === 1,
      'exactly one SESSION_ASSIGNED — the loser rolled back',
    );

    // ================================================== T23: the offer timeout

    section('[T23] an offer timeout returns the session to the queue, unbilled');
    const expiring = await queueOne(`gate-expire-${runId}`);

    // The winner of the race above is at max_concurrent, so claim with whoever
    // is still free.
    const freeToken = winningAgent === AGENT_ONE ? tokenTwo : tokenOne;
    const freeAgent = winningAgent === AGENT_ONE ? AGENT_TWO : AGENT_ONE;
    await goAvailable(freeToken);
    const held = await claim(expiring, freeToken);
    check(held.status === 200, 'the free agent claims it');

    const [beforeQueuedAt] = await db
      .select({ queuedAt: sessions.queuedAt })
      .from(sessions)
      .where(eq(sessions.id, expiring));

    const busy = (await json(
      await post('/v1/agent/heartbeat', {}, bearer(freeToken)),
    )) as unknown as { data?: { status?: string } };
    check(busy.data?.status === 'BUSY', 'and is BUSY while holding it');

    // One second of offer window, then a sweep. The interval would get there on
    // its own within five seconds; triggering it makes the check deterministic.
    await sleep(1_200);
    const sweptResponse = await post(
      '/internal/offers/sweep',
      {},
      { 'X-Internal-Token': TEST_ENV['VCIP_INTERNAL_TOKEN'] ?? '' },
    );
    const swept = (await json(sweptResponse)) as unknown as {
      data?: { expired?: number; freed?: number };
    };
    check(sweptResponse.status === 200, 'the sweep runs');
    check((swept.data?.expired ?? 0) >= 1, 'and expires the lapsed offer');

    const [afterSweep] = await db
      .select({
        status: sessions.status,
        offeredTo: sessions.offeredToAgentId,
        offeredAt: sessions.offeredAt,
        expires: sessions.offerExpiresAt,
        queuedAt: sessions.queuedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, expiring));

    check(afterSweep?.status === SessionStatus.QUEUED, 'the session is back in the queue');
    check(
      afterSweep?.offeredTo === null &&
        afterSweep.offeredAt === null &&
        afterSweep.expires === null,
      'with every offer field cleared',
    );
    check(
      afterSweep?.queuedAt?.getTime() === beforeQueuedAt?.queuedAt?.getTime(),
      'and its original queued_at, so the customer keeps their place',
    );

    check(await billingFor(expiring).then((n) => n === 0), 'no billing row was written for it');
    check(
      await billingFor(contested).then((n) => n === 0),
      'and none for the contested session either',
    );

    const expiredEvents = await db
      .select({ type: sessionEvents.eventType })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, expiring));
    check(
      expiredEvents.some((e) => e.type === SessionEventType.OFFER_EXPIRED),
      'an OFFER_EXPIRED event records why it came back',
    );

    const freedBeat = (await json(
      await post('/v1/agent/heartbeat', {}, bearer(freeToken)),
    )) as unknown as { data?: { status?: string } };
    check(freedBeat.data?.status === 'AVAILABLE', 'and the agent is free to work again');

    section('[T23] the returned session is workable');
    const queueView = (await json(await get('/v1/agent/queue', bearer(freeToken)))) as unknown as {
      data?: { sessions?: { session_id: string }[] };
    };
    check(
      (queueView.data?.sessions ?? []).some((s) => s.session_id === expiring),
      'it is visible in the agent queue again',
    );

    const reclaimed = await claim(expiring, freeToken);
    check(reclaimed.status === 200, 'and can be claimed again');
    const accepted = await post(
      `/v1/agent/sessions/${expiring}/accept`,
      {},
      { ...bearer(freeToken), 'Idempotency-Key': idem() },
    );
    check(accepted.status === 200, 'and accepted');
    const [inCall] = await db
      .select({ status: sessions.status, agentId: sessions.agentId })
      .from(sessions)
      .where(eq(sessions.id, expiring));
    check(
      inCall?.status === SessionStatus.IN_CALL && inCall.agentId === freeAgent,
      'ending IN_CALL with the agent assigned',
    );

    process.stdout.write(
      failed === 0
        ? `\nDAY 2 GATE PASSED (${passed} checks)\n`
        : `\n${failed} CHECK(S) FAILED (${passed} passed)\n`,
    );
  } finally {
    if (server !== null) {
      server.kill();
      // Give it a moment to release the port and close its pools.
      await sleep(300);
    }

    const ours = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.tenantId, TENANT));
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
    await db.delete(agentProfiles).where(inArray(agentProfiles.userId, [AGENT_ONE, AGENT_TWO]));
    await db.delete(tenantApiKeys).where(eq(tenantApiKeys.tenantId, TENANT));
    await db.delete(checklistTemplates).where(eq(checklistTemplates.tenantId, TENANT));
    await db.delete(users).where(inArray(users.id, [AGENT_ONE, AGENT_TWO]));
    await db.delete(tenants).where(eq(tenants.id, TENANT));

    if (touchedKeys.size > 0) await redis.del(...touchedKeys);

    // The idempotency records this run wrote. Their keys are
    // `idem:{actor}:{endpoint}:{key}` and the actor segment carries the tenant,
    // so a scan filtered on this run's tenant id finds exactly its own and
    // nothing belonging to a developer's real data. Not in `touchedKeys`
    // because the keys are only knowable after the requests that made them.
    const stale: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'idem:*', 'COUNT', 500);
      cursor = next;
      stale.push(...batch.filter((key) => key.includes(TENANT)));
    } while (cursor !== '0');
    if (stale.length > 0) await redis.del(...stale);

    await redis.quit();
    await client.end();
  }

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
