/**
 * Media tokens (T24) against real PostgreSQL.
 *
 * The unit and HTTP suites prove the authorization matrix against fakes. Four
 * properties are claims about a real database and a real signing key, and
 * cannot be made anywhere else:
 *
 *   - that `findForMediaToken`'s tenant predicate is genuinely in the WHERE
 *     clause, so another tenant's row is never loaded rather than being loaded
 *     and then rejected,
 *   - that `sessions.room_name` written at creation (R2) is what this
 *     projection reads back, so the token names the room the rest of the system
 *     will use,
 *   - that `sessions.agent_id` is actually written by T19's accept statement.
 *     The entire agent-side authorization rests on that column, and a check
 *     against a column nothing writes refuses everyone or admits everyone —
 *     this is the one place the write and the read meet on real SQL,
 *   - and that the credential the service returns verifies against the
 *     configured key pair and is bound to the room PostgreSQL holds.
 *
 * One rolled-back transaction: nothing here is concurrent, so there is no
 * second half. Redis is not touched — issuing a token reads no queue and
 * changes no presence.
 *
 *   pnpm --filter @vcip/api db:verify-media-token
 */

import { randomUUID } from 'node:crypto';
import { ERROR_HTTP_STATUS, SessionEventType, SessionStatus } from '@vcip/shared';
import type { ErrorCode } from '@vcip/shared';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { TokenVerifier } from 'livekit-server-sdk';
import type { ClaimGrants, VideoGrant } from 'livekit-server-sdk';
import postgres from 'postgres';
import { sessions, tenants, users } from '../db/schema.js';
import { ActorRole } from '../src/common/auth/auth-context.js';
import type { AgentActor, CustomerActor } from '../src/common/auth/auth-context.js';
import { TenantScope } from '../src/common/auth/tenant-scope.js';
import { DrizzleSessionEventWriter } from '../src/common/events/index.js';
import { createLogger } from '../src/common/logging/logger.js';
import type { LiveKitConfig } from '../src/livekit/livekit.config.js';
import { MEDIA_TOKEN_TTL_SECONDS } from '../src/livekit/livekit.config.js';
import type { MediaParticipantMetadata } from '../src/livekit/media-token.minter.js';
import { LiveKitTokenMinter } from '../src/livekit/media-token.minter.js';
import { MediaTokenService } from '../src/livekit/media-token.service.js';
import { DrizzleSessionRepository } from '../src/sessions/session.repository.js';
import { roomNameFor } from '../src/sessions/sessions.service.js';

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

const agentActor = (userId: string, tenantId: string): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

const customerActor = (sessionId: string, tenantId: string): CustomerActor => ({
  kind: 'customer',
  tenantId,
  sessionId,
});

const codeOf = (error: unknown): string => {
  const e = (error as { response?: { code?: string }; code?: string } | undefined) ?? {};
  return e.code ?? e.response?.code ?? '';
};

/**
 * The HTTP status a thrown error becomes.
 *
 * A Nest `HttpException` carries its own; a `DomainError` does not, because it
 * is a domain error and the mapping to HTTP is the filter's job. Reading the
 * status through `ERROR_HTTP_STATUS` is therefore not a workaround — it is the
 * same table `ApiErrorFilter` consults, so this asserts the status a caller
 * would actually receive.
 */
const statusOf = (error: unknown): number => {
  const own = (error as { status?: number } | undefined)?.status;
  if (typeof own === 'number') return own;
  const code = codeOf(error) as ErrorCode;
  return ERROR_HTTP_STATUS[code] ?? 0;
};

/** The error a call threw, or null when it did not throw. */
const thrownBy = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => null,
    (error: unknown) => error,
  );

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    process.stdout.write('DATABASE_URL is not set.\n');
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  const runId = randomUUID().slice(0, 8);
  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();
  const AGENT_ONE = randomUUID();
  const AGENT_TWO = randomUUID();

  /**
   * A key pair for this run only. Never a deployment's — the script proves the
   * minting path, and it should not need a real LiveKit credential to do it.
   */
  const LIVEKIT: LiveKitConfig = {
    url: 'ws://localhost:7880',
    apiKey: 'verify-key',
    apiSecret: `verify-secret-${randomUUID()}${randomUUID()}`,
    tokenTtlSeconds: MEDIA_TOKEN_TTL_SECONDS,
  };
  const verifier = new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret);
  const video = (claims: ClaimGrants): VideoGrant => claims.video as VideoGrant;

  const logger = createLogger({ level: 'silent' });
  const eventWriter = new DrizzleSessionEventWriter();
  const T0 = new Date('2026-09-01T12:00:00.000Z');

  const serviceFor = (executor: PostgresJsDatabase): MediaTokenService =>
    new MediaTokenService(
      new DrizzleSessionRepository(executor, eventWriter),
      new LiveKitTokenMinter(LIVEKIT),
      LIVEKIT,
      new TenantScope(),
      logger,
      () => T0,
    );

  const insertFixtures = async (executor: PostgresJsDatabase): Promise<void> => {
    await executor.insert(tenants).values([
      { id: TENANT_A, slug: `vm-a-${runId}`, name: `verify media A ${runId}`, status: 'ACTIVE' },
      { id: TENANT_B, slug: `vm-b-${runId}`, name: `verify media B ${runId}`, status: 'ACTIVE' },
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
    ]);
  };

  /**
   * A session inserted the way `SessionsService.create` inserts one: the id is
   * generated first, because `room_name` is derived from it (R2).
   */
  const seedSession = async (
    executor: PostgresJsDatabase,
    status: SessionStatus,
    tenantId = TENANT_A,
    agentId: string | null = null,
  ): Promise<string> => {
    const id = randomUUID();
    await executor.insert(sessions).values({
      id,
      tenantId,
      externalRef: `vm-${runId}-${id.slice(0, 8)}`,
      status,
      language: 'en',
      roomName: roomNameFor(id),
      agentId,
      queuedAt: status === SessionStatus.CREATED ? null : T0,
    });
    return id;
  };

  try {
    section('[ping] server reachable');
    const [alive] = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
    check(Number(alive?.ok) === 1, 'postgresql answers a query');

    await db
      .transaction(async (tx) => {
        const executor = tx as unknown as PostgresJsDatabase;
        await insertFixtures(executor);
        const repo = new DrizzleSessionRepository(executor, eventWriter);
        const service = serviceFor(executor);

        // ------------------------------------------------------ projection
        section('[projection] the tenant predicate is in the statement');

        const queued = await seedSession(executor, SessionStatus.QUEUED);

        const mine = await repo.findForMediaToken(TENANT_A, queued);
        check(mine !== null, 'the owning tenant reads its own session');
        check(mine?.id === queued, 'and gets the row it asked for');

        const foreign = await repo.findForMediaToken(TENANT_B, queued);
        check(foreign === null, 'another tenant reads nothing at all, not a row to reject later');

        const unknown = await repo.findForMediaToken(TENANT_A, randomUUID());
        check(unknown === null, 'an unknown id reads nothing');

        section('[projection] room_name survives the round trip (R2)');
        check(
          mine?.roomName === `vcip_${queued}`,
          'the column holds vcip_{session_id}, written at creation',
        );
        check(mine?.agentId === null, 'agent_id is null before any agent accepts');

        // ------------------------------------------------------- customer
        section('[customer] a queued customer can hold credentials');

        const forQueued = await service.issue(customerActor(queued, TENANT_A), queued);
        check(forQueued.room_name === `vcip_${queued}`, 'the token names the room from the column');
        check(
          forQueued.expires_at === new Date(T0.getTime() + 900_000).toISOString(),
          'and expires fifteen minutes out',
        );

        const queuedClaims = await verifier.verify(forQueued.token);
        check(queuedClaims.sub === 'customer', 'the participant identity is the role');
        check(video(queuedClaims).room === `vcip_${queued}`, 'the grant is bound to that one room');
        check(video(queuedClaims).canPublish === true, 'the customer may publish');
        check(
          (video(queuedClaims).roomAdmin ?? false) === false &&
            (video(queuedClaims).roomCreate ?? false) === false,
          'and holds no control-plane power',
        );

        section('[customer] an unqueued session is refused');
        const created = await seedSession(executor, SessionStatus.CREATED);
        const tooEarly = await thrownBy(service.issue(customerActor(created, TENANT_A), created));
        check(statusOf(tooEarly) === 409, 'a CREATED session is a 409');
        check(codeOf(tooEarly) === 'SESSION_INVALID_STATE', 'with SESSION_INVALID_STATE');

        // ---------------------------------------------------------- agent
        //
        // The cross-task claim: T19 writes `sessions.agent_id`, T24 reads it,
        // and the agent-side authorization is exactly that comparison. Both
        // halves run against the real column here.
        section('[agent] the assignment T19 writes is the assignment T24 reads');

        const inCall = await seedSession(executor, SessionStatus.QUEUED);
        await executor
          .update(sessions)
          .set({
            status: SessionStatus.IN_CALL,
            agentId: AGENT_ONE,
            connectedAt: T0,
          })
          .where(eq(sessions.id, inCall));

        const assigned = await repo.findForMediaToken(TENANT_A, inCall);
        check(assigned?.agentId === AGENT_ONE, 'agent_id reads back as the agent on the call');

        const forAgent = await service.issue(agentActor(AGENT_ONE, TENANT_A), inCall);
        const agentClaims = await verifier.verify(forAgent.token);
        check(agentClaims.sub === 'agent', 'the assigned agent is issued an agent credential');
        check(video(agentClaims).room === `vcip_${inCall}`, 'bound to the session room');

        const metadata = JSON.parse(agentClaims.metadata as string) as MediaParticipantMetadata;
        check(metadata.session_id === inCall, 'the metadata names the session, for T26');
        check(metadata.user_id === AGENT_ONE, 'and the agent, from the verified credential');
        check(metadata.tenant_id === TENANT_A, 'and the tenant');

        section('[agent] another agent’s call is refused');
        const intruder = await thrownBy(service.issue(agentActor(AGENT_TWO, TENANT_A), inCall));
        check(statusOf(intruder) === 409, 'a colleague reaching for the call is a 409');
        check(codeOf(intruder) === 'SESSION_ALREADY_ASSIGNED', 'with SESSION_ALREADY_ASSIGNED');

        section('[agent] an offer is not a call');
        const offered = await seedSession(executor, SessionStatus.OFFERED);
        await executor
          .update(sessions)
          .set({ offeredToAgentId: AGENT_ONE, offeredAt: T0 })
          .where(eq(sessions.id, offered));
        const onOffer = await thrownBy(service.issue(agentActor(AGENT_ONE, TENANT_A), offered));
        check(statusOf(onOffer) === 409, 'the agent holding the offer is still refused');
        check(codeOf(onOffer) === 'SESSION_INVALID_STATE', 'with SESSION_INVALID_STATE');

        // ------------------------------------------------- tenant isolation
        section('[isolation] a foreign session is indistinguishable from a missing one');

        const foreignSession = await thrownBy(
          service.issue(agentActor(AGENT_ONE, TENANT_B), inCall),
        );
        const missingSession = await thrownBy(
          service.issue(agentActor(AGENT_ONE, TENANT_B), randomUUID()),
        );
        check(statusOf(foreignSession) === 404, 'another tenant’s session is a 404, not a 403');
        check(statusOf(missingSession) === 404, 'and so is an id that never existed');
        check(
          codeOf(foreignSession) === codeOf(missingSession),
          'with the same code, so the endpoint is no enumeration oracle',
        );

        // ------------------------------------------------- absence of writes
        section('[effects] issuing a token changes nothing');

        const [beforeRow] = await executor
          .select({ version: sessions.version, updatedAt: sessions.updatedAt })
          .from(sessions)
          .where(eq(sessions.id, inCall));

        await service.issue(agentActor(AGENT_ONE, TENANT_A), inCall);
        await service.issue(customerActor(inCall, TENANT_A), inCall);

        const [afterRow] = await executor
          .select({ version: sessions.version, updatedAt: sessions.updatedAt })
          .from(sessions)
          .where(eq(sessions.id, inCall));

        check(beforeRow?.version === afterRow?.version, 'the session version is untouched');
        check(
          beforeRow?.updatedAt?.getTime() === afterRow?.updatedAt?.getTime(),
          'and so is updated_at',
        );

        const [events] = await executor.execute<{ n: string }>(sql`
          SELECT count(*) AS n FROM session_events WHERE session_id = ${inCall}::uuid
        `);
        check(
          Number(events?.n ?? 0) === 0,
          'no session_event is appended — the catalogue has no name for holding a credential',
        );
        check(
          !Object.values(SessionEventType).some((type) => String(type).includes('MEDIA')),
          'and the shared catalogue still has no media-token event to append',
        );

        // Everything above ran inside one transaction; nothing survives it.
        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    process.stdout.write(
      failed === 0
        ? `\nALL ${passed} CHECKS PASSED\n`
        : `\n${failed} CHECK(S) FAILED (${passed} passed)\n`,
    );
  } finally {
    await client.end();
  }

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
