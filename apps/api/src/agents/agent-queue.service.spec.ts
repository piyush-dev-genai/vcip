/**
 * The agent queue view's behaviour, without a server.
 *
 * The two fakes are written to be *more* permissive than the real thing, not
 * less. The queue fake is a genuine ZSET with real ordering, and it will hand
 * back any member it holds — including members whose session has moved on, and
 * members belonging to a session in another tenant. The session fake applies
 * the tenant and status predicates the SQL applies. That asymmetry is the
 * point: if the service ever stopped validating Redis against PostgreSQL, these
 * tests would start returning sessions that do not exist.
 *
 * Real Redis and real PostgreSQL are exercised by
 * `scripts/verify-agent-queue.ts`.
 */

import { ForbiddenException } from '@nestjs/common';
import { SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActor } from '../common/auth/auth-context.js';
import { ActorRole } from '../common/auth/auth-context.js';
import { createLogger } from '../common/logging/logger.js';
import { queueKey } from '../queue/queue.keys.js';
import type {
  QueueCandidate,
  QueueEntry,
  QueueMember,
  QueueRepository,
} from '../queue/queue.repository.js';
import type {
  CreateSessionInput,
  ClaimableSessionRow,
  MediaTokenSessionRow,
  ClaimCommand,
  ExpiredOfferRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  GuardedUpdate,
  QueuedSessionRow,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import type { AgentProfileRow, AgentRepository, AgentCredentialRow } from './agent.repository.js';
import { AGENT_QUEUE_LIMIT } from './agent-queue.rules.js';
import { AgentQueueService } from './agent-queue.service.js';

// ------------------------------------------------------------------ fixtures

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_EN_HI = '00000000-0000-4000-8000-0000000000a1';
const AGENT_EN = '00000000-0000-4000-8000-0000000000a2';
const AGENT_B = '00000000-0000-4000-8000-0000000000b1';
const ADMIN = '00000000-0000-4000-8000-0000000000ad';

const NOW = Date.parse('2026-08-31T10:10:00.000Z');
const silentLogger = () => createLogger({ level: 'silent' });

const actor = (userId: string, tenantId: string): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

/** A stored session, as PostgreSQL holds it. */
interface StoredSession {
  id: string;
  tenantId: string;
  status: SessionStatus;
  language: string;
  priority: number;
  queuedAt: Date | null;
  version: number;
}

const stored = (over: Partial<StoredSession> & { id: string }): StoredSession => ({
  tenantId: TENANT_A,
  status: SessionStatus.QUEUED,
  language: 'en',
  priority: 0,
  queuedAt: new Date(NOW - 60_000),
  version: 2,
  ...over,
});

// --------------------------------------------------------------------- fakes

/** An in-memory ZSET with Redis's ordering and Redis's indifference to status. */
class FakeQueueRepository implements QueueRepository {
  readonly sets = new Map<string, Map<string, number>>();
  readonly rangeCalls: Array<{ key: string; limit: number }> = [];

  seed(tenantId: string, language: string, sessionId: string, score: number): void {
    const key = queueKey(tenantId, language);
    const set = this.sets.get(key) ?? new Map<string, number>();
    set.set(sessionId, score);
    this.sets.set(key, set);
  }

  add(entry: QueueEntry): Promise<void> {
    this.seed(entry.tenantId, entry.language, entry.sessionId, entry.score);
    return Promise.resolve();
  }

  rank(member: QueueMember): Promise<number | null> {
    const set = this.sets.get(queueKey(member.tenantId, member.language));
    if (set === undefined || !set.has(member.sessionId)) return Promise.resolve(null);
    return Promise.resolve(this.ordered(set).findIndex(([id]) => id === member.sessionId));
  }

  range(tenantId: string, language: string, limit: number): Promise<readonly QueueCandidate[]> {
    const key = queueKey(tenantId, language);
    this.rangeCalls.push({ key, limit });
    if (limit <= 0) return Promise.resolve([]);
    const set = this.sets.get(key);
    if (set === undefined) return Promise.resolve([]);
    return Promise.resolve(
      this.ordered(set)
        .slice(0, limit)
        .map(([sessionId, score]) => ({ sessionId, score })),
    );
  }

  private ordered(set: Map<string, number>): Array<[string, number]> {
    return [...set.entries()].sort(
      (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
  }
}

/** Applies exactly the predicates the SQL applies, and records every read. */
class FakeSessionRepository implements SessionRepository {
  readonly rows = new Map<string, StoredSession>();
  readonly queries: Array<{ tenantId: string; ids: readonly string[] }> = [];

  seed(session: StoredSession): void {
    this.rows.set(session.id, session);
  }

  findQueued(
    tenantId: string,
    sessionIds: readonly string[],
  ): Promise<readonly QueuedSessionRow[]> {
    this.queries.push({ tenantId, ids: [...sessionIds] });
    const wanted = new Set(sessionIds);
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            wanted.has(row.id) &&
            row.tenantId === tenantId &&
            row.status === SessionStatus.QUEUED &&
            row.queuedAt !== null,
        )
        // Deliberately NOT in queue order: the service must impose the Redis
        // order itself rather than inherit whatever the planner returned.
        .reverse()
        .map((row) => ({
          id: row.id,
          language: row.language,
          priority: row.priority,
          queuedAt: row.queuedAt as Date,
        })),
    );
  }

  create(_input: CreateSessionInput): Promise<SessionRow> {
    throw new Error('the queue view must not create sessions');
  }

  findById(_sessionId: string): Promise<SessionRow | null> {
    throw new Error('the queue view must not read sessions one at a time');
  }

  update(_command: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('the queue view must not update sessions');
  }

  claim(_command: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('the queue view must not claim sessions');
  }

  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('the queue view must not read the media-token projection');
  }

  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('the queue view must not read sessions one at a time');
  }

  accept(): Promise<SessionAcceptOutcome> {
    throw new Error('the queue view must not accept sessions');
  }

  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('the queue view must not sweep offers');
  }

  countActiveWork(): Promise<number> {
    throw new Error('the queue view must not count an agent work');
  }
}

const PROFILES: readonly AgentProfileRow[] = Object.freeze([
  { userId: AGENT_EN_HI, tenantId: TENANT_A, languages: ['en', 'hi'], maxConcurrent: 1 },
  { userId: AGENT_EN, tenantId: TENANT_A, languages: ['en'], maxConcurrent: 1 },
  { userId: AGENT_B, tenantId: TENANT_B, languages: ['en'], maxConcurrent: 1 },
]);

class FakeAgentRepository implements AgentRepository {
  findAgentByEmail(): Promise<AgentCredentialRow | null> {
    throw new Error('the queue view must not authenticate');
  }

  findProfile(userId: string, tenantId: string): Promise<AgentProfileRow | null> {
    return Promise.resolve(
      PROFILES.find((p) => p.userId === userId && p.tenantId === tenantId) ?? null,
    );
  }
}

// --------------------------------------------------------------------- suite

describe('AgentQueueService', () => {
  let queue: FakeQueueRepository;
  let sessions: FakeSessionRepository;
  let service: AgentQueueService;

  beforeEach(() => {
    queue = new FakeQueueRepository();
    sessions = new FakeSessionRepository();
    service = new AgentQueueService(
      queue,
      sessions,
      new FakeAgentRepository(),
      silentLogger(),
      () => new Date(NOW),
    );
  });

  /** Put a session in PostgreSQL and in its language queue, consistently. */
  const enqueue = (session: StoredSession): void => {
    sessions.seed(session);
    if (session.queuedAt !== null) {
      queue.seed(session.tenantId, session.language, session.id, session.queuedAt.getTime());
    }
  };

  const ids = async (who: AgentActor): Promise<string[]> =>
    (await service.view(who)).sessions.map((s) => s.session_id);

  describe('tenant scoping', () => {
    it('reads only the authenticated tenant queue keys', async () => {
      await service.view(actor(AGENT_EN_HI, TENANT_A));

      expect(queue.rangeCalls.length).toBeGreaterThan(0);
      for (const call of queue.rangeCalls) {
        expect(call.key.startsWith(`queue:${TENANT_A}:`)).toBe(true);
        expect(call.key).not.toContain(TENANT_B);
        expect(call.key).not.toContain('*');
      }
    });

    it('never sees another tenant queued session, even at the same language', async () => {
      enqueue(stored({ id: 'a-session', tenantId: TENANT_A }));
      enqueue(stored({ id: 'b-session', tenantId: TENANT_B }));

      expect(await ids(actor(AGENT_EN_HI, TENANT_A))).toEqual(['a-session']);
      expect(await ids(actor(AGENT_B, TENANT_B))).toEqual(['b-session']);
    });

    it('scopes the PostgreSQL validation to the token tenant too', async () => {
      enqueue(stored({ id: 'a-session' }));
      await service.view(actor(AGENT_EN_HI, TENANT_A));

      expect(sessions.queries.every((q) => q.tenantId === TENANT_A)).toBe(true);
    });

    it('drops a Redis member whose session belongs to another tenant', async () => {
      // The member is in tenant A's key; the row says tenant B. Redis alone
      // would leak it.
      sessions.seed(stored({ id: 'planted', tenantId: TENANT_B }));
      queue.seed(TENANT_A, 'en', 'planted', NOW - 60_000);

      expect(await ids(actor(AGENT_EN_HI, TENANT_A))).toEqual([]);
    });
  });

  describe('language filtering', () => {
    it('shows a single-language agent only its own language', async () => {
      enqueue(stored({ id: 'en-1', language: 'en' }));
      enqueue(stored({ id: 'hi-1', language: 'hi' }));

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual(['en-1']);
    });

    it('merges every configured language for a multi-language agent', async () => {
      enqueue(stored({ id: 'en-1', language: 'en' }));
      enqueue(stored({ id: 'hi-1', language: 'hi' }));

      expect((await ids(actor(AGENT_EN_HI, TENANT_A))).sort()).toEqual(['en-1', 'hi-1']);
    });

    it('never reads a queue key for a language the agent does not work', async () => {
      await service.view(actor(AGENT_EN, TENANT_A));

      expect(queue.rangeCalls.map((c) => c.key)).toEqual([queueKey(TENANT_A, 'en')]);
    });

    it('matches a session language whose case differs from the profile', async () => {
      // `createSessionSchema` does not normalise, so PostgreSQL can hold `EN`
      // while the member sits under `queue:{tenant}:en`.
      enqueue(stored({ id: 'shouty', language: 'EN' }));

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual(['shouty']);
    });

    it('does not treat en-IN as en', async () => {
      enqueue(stored({ id: 'regional', language: 'en-IN' }));

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual([]);
    });

    it('drops a member filed under an eligible key whose row says another language', async () => {
      // The two can only disagree if something went wrong: T15 files a member
      // under its own `sessions.language`. When they do, PostgreSQL is right.
      // Without the second check the session would be returned purely because
      // of the key it was found under.
      sessions.seed(stored({ id: 'misfiled', language: 'ta' }));
      queue.seed(TENANT_A, 'en', 'misfiled', NOW - 60_000);

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual([]);
    });

    it('keeps a correctly filed session alongside a misfiled one', async () => {
      enqueue(stored({ id: 'correct', language: 'en', queuedAt: new Date(NOW - 90_000) }));
      sessions.seed(stored({ id: 'misfiled', language: 'ta', queuedAt: new Date(NOW - 60_000) }));
      queue.seed(TENANT_A, 'en', 'misfiled', NOW - 60_000);

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual(['correct']);
    });

    it('returns nothing for an agent configured with no languages', async () => {
      const noLanguages = new AgentQueueService(
        queue,
        sessions,
        {
          findAgentByEmail: () => Promise.reject(new Error('unused')),
          findProfile: () =>
            Promise.resolve({
              userId: AGENT_EN,
              tenantId: TENANT_A,
              languages: [],
              maxConcurrent: 1,
            }),
        },
        silentLogger(),
        () => new Date(NOW),
      );
      enqueue(stored({ id: 'en-1' }));

      expect((await noLanguages.view(actor(AGENT_EN, TENANT_A))).sessions).toEqual([]);
      expect(queue.rangeCalls).toEqual([]);
    });
  });

  describe('FIFO ordering across merged queues', () => {
    it('orders by enqueue time, not by language', async () => {
      // en: A@10:00, C@10:05   hi: B@10:02, D@10:06
      enqueue(
        stored({ id: 'A', language: 'en', queuedAt: new Date(Date.parse('2026-08-31T10:00:00Z')) }),
      );
      enqueue(
        stored({ id: 'B', language: 'hi', queuedAt: new Date(Date.parse('2026-08-31T10:02:00Z')) }),
      );
      enqueue(
        stored({ id: 'C', language: 'en', queuedAt: new Date(Date.parse('2026-08-31T10:05:00Z')) }),
      );
      enqueue(
        stored({ id: 'D', language: 'hi', queuedAt: new Date(Date.parse('2026-08-31T10:06:00Z')) }),
      );

      expect(await ids(actor(AGENT_EN_HI, TENANT_A))).toEqual(['A', 'B', 'C', 'D']);
    });

    it('is deterministic when two sessions were queued in the same millisecond', async () => {
      const sameInstant = new Date(NOW - 30_000);
      enqueue(stored({ id: 'zzz', language: 'en', queuedAt: sameInstant }));
      enqueue(stored({ id: 'aaa', language: 'hi', queuedAt: sameInstant }));

      expect(await ids(actor(AGENT_EN_HI, TENANT_A))).toEqual(['aaa', 'zzz']);
      expect(await ids(actor(AGENT_EN_HI, TENANT_A))).toEqual(['aaa', 'zzz']);
    });

    it('keeps the queue order even though PostgreSQL returns rows reversed', async () => {
      enqueue(stored({ id: 'first', queuedAt: new Date(NOW - 300_000) }));
      enqueue(stored({ id: 'second', queuedAt: new Date(NOW - 200_000) }));
      enqueue(stored({ id: 'third', queuedAt: new Date(NOW - 100_000) }));

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual(['first', 'second', 'third']);
    });
  });

  describe('Redis membership is the candidate set, PostgreSQL is the authority', () => {
    it('does not return a queued session that is missing from Redis', async () => {
      // The documented limitation: a lost ZADD makes the session invisible to
      // agents. The queue view does not repair it, because that would be a
      // write on a GET.
      sessions.seed(stored({ id: 'orphan' }));

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual([]);
      expect(queue.sets.get(queueKey(TENANT_A, 'en'))).toBeUndefined();
    });

    it('asks PostgreSQL about exactly the ids Redis offered, and no others', async () => {
      enqueue(stored({ id: 'en-1' }));
      enqueue(stored({ id: 'en-2', queuedAt: new Date(NOW - 30_000) }));

      await service.view(actor(AGENT_EN, TENANT_A));

      expect(sessions.queries).toHaveLength(1);
      expect([...sessions.queries[0]!.ids].sort()).toEqual(['en-1', 'en-2']);
    });

    it('makes one PostgreSQL query however many candidates there are', async () => {
      for (let i = 0; i < 15; i += 1) {
        enqueue(stored({ id: `s-${i}`, queuedAt: new Date(NOW - 1000 * (30 - i)) }));
      }

      await service.view(actor(AGENT_EN, TENANT_A));

      expect(sessions.queries).toHaveLength(1);
    });

    it('does not query PostgreSQL at all when Redis offered nothing', async () => {
      await service.view(actor(AGENT_EN, TENANT_A));

      expect(sessions.queries).toEqual([]);
    });
  });

  describe('stale Redis members', () => {
    const staleStatuses: readonly SessionStatus[] = [
      SessionStatus.CREATED,
      SessionStatus.PREFLIGHT_FAILED,
      SessionStatus.OFFERED,
      SessionStatus.IN_CALL,
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ];

    for (const status of staleStatuses) {
      it(`excludes a member whose session is ${status}`, async () => {
        // In Redis, as T15 permits after the session left QUEUED.
        sessions.seed(stored({ id: 'moved-on', status }));
        queue.seed(TENANT_A, 'en', 'moved-on', NOW - 60_000);

        expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual([]);
      });
    }

    it('excludes a member with no session row at all', async () => {
      queue.seed(TENANT_A, 'en', 'ghost', NOW - 60_000);

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual([]);
    });

    it('returns the live sessions around a stale member without disturbing it', async () => {
      enqueue(stored({ id: 'live-1', queuedAt: new Date(NOW - 300_000) }));
      sessions.seed(stored({ id: 'stale', status: SessionStatus.DROPPED_QUEUED }));
      queue.seed(TENANT_A, 'en', 'stale', NOW - 200_000);
      enqueue(stored({ id: 'live-2', queuedAt: new Date(NOW - 100_000) }));

      expect(await ids(actor(AGENT_EN, TENANT_A))).toEqual(['live-1', 'live-2']);
      // Still in Redis: cleaning it up belongs to the task that owns removal.
      expect(queue.sets.get(queueKey(TENANT_A, 'en'))!.has('stale')).toBe(true);
    });
  });

  describe('bounded reads', () => {
    it('asks each language queue for at most AGENT_QUEUE_LIMIT members', async () => {
      await service.view(actor(AGENT_EN_HI, TENANT_A));

      expect(queue.rangeCalls).toHaveLength(2);
      for (const call of queue.rangeCalls) expect(call.limit).toBe(AGENT_QUEUE_LIMIT);
    });

    it('returns no more than the limit when the queue is longer', async () => {
      for (let i = 0; i < AGENT_QUEUE_LIMIT * 2; i += 1) {
        enqueue(
          stored({
            id: `s-${String(i).padStart(3, '0')}`,
            queuedAt: new Date(NOW - 1_000_000 + i * 1000),
          }),
        );
      }

      const view = await service.view(actor(AGENT_EN, TENANT_A));

      expect(view.sessions).toHaveLength(AGENT_QUEUE_LIMIT);
      expect(view.sessions[0]!.session_id).toBe('s-000');
      expect(view.sessions.at(-1)!.session_id).toBe(`s-0${AGENT_QUEUE_LIMIT - 1}`);
    });

    it('never sends more ids to PostgreSQL than the limit', async () => {
      for (let i = 0; i < AGENT_QUEUE_LIMIT; i += 1) {
        enqueue(stored({ id: `en-${i}`, language: 'en', queuedAt: new Date(NOW - 900_000 + i) }));
        enqueue(stored({ id: `hi-${i}`, language: 'hi', queuedAt: new Date(NOW - 800_000 + i) }));
      }

      await service.view(actor(AGENT_EN_HI, TENANT_A));

      expect(sessions.queries[0]!.ids.length).toBeLessThanOrEqual(AGENT_QUEUE_LIMIT);
    });
  });

  describe('the response body', () => {
    it('reports wait_seconds from the server clock', async () => {
      enqueue(stored({ id: 'waiting', queuedAt: new Date(NOW - 32_000) }));

      const [session] = (await service.view(actor(AGENT_EN, TENANT_A))).sessions;
      expect(session!.wait_seconds).toBe(32);
    });

    it('grows wait_seconds as the clock advances, with no write in between', async () => {
      enqueue(stored({ id: 'waiting', queuedAt: new Date(NOW - 10_000) }));
      const later = new AgentQueueService(
        queue,
        sessions,
        new FakeAgentRepository(),
        silentLogger(),
        () => new Date(NOW + 5_000),
      );

      const first = (await service.view(actor(AGENT_EN, TENANT_A))).sessions[0]!;
      const second = (await later.view(actor(AGENT_EN, TENANT_A))).sessions[0]!;

      expect(first.wait_seconds).toBe(10);
      expect(second.wait_seconds).toBe(15);
      expect(sessions.rows.get('waiting')!.version).toBe(2);
    });

    it('reports the stored priority without ordering by it', async () => {
      // The high-priority session is the newer one. FIFO must still win.
      enqueue(stored({ id: 'older', priority: 0, queuedAt: new Date(NOW - 300_000) }));
      enqueue(stored({ id: 'newer', priority: 9, queuedAt: new Date(NOW - 100_000) }));

      const view = await service.view(actor(AGENT_EN, TENANT_A));

      expect(view.sessions.map((s) => s.session_id)).toEqual(['older', 'newer']);
      expect(view.sessions.map((s) => s.priority)).toEqual([0, 9]);
    });

    it('carries exactly the five contract fields and no customer data', async () => {
      enqueue(stored({ id: 'one' }));

      const [session] = (await service.view(actor(AGENT_EN, TENANT_A))).sessions;

      expect(Object.keys(session!).sort()).toEqual([
        'language',
        'priority',
        'queued_at',
        'session_id',
        'wait_seconds',
      ]);
      // No position: a per-language rank is not a merged-list position, and
      // the contract defines no such field.
      expect(session).not.toHaveProperty('position');
      expect(session).not.toHaveProperty('queue_position');
      expect(session).not.toHaveProperty('external_ref');
    });

    it('reports queued_at as the stored instant, in ISO-8601', async () => {
      const queuedAt = new Date('2026-08-31T10:00:00.000Z');
      enqueue(stored({ id: 'one', queuedAt }));

      const [session] = (await service.view(actor(AGENT_EN, TENANT_A))).sessions;
      expect(session!.queued_at).toBe('2026-08-31T10:00:00.000Z');
    });
  });

  describe('authorisation', () => {
    it('refuses a user with no agent profile', async () => {
      await expect(service.view(actor(ADMIN, TENANT_A))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an agent whose token names a tenant they do not belong to', async () => {
      enqueue(stored({ id: 'b-session', tenantId: TENANT_B }));

      // AGENT_EN_HI is a tenant A agent; the token claims tenant B.
      await expect(service.view(actor(AGENT_EN_HI, TENANT_B))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('reads no queue at all when the profile lookup refuses', async () => {
      await expect(service.view(actor(ADMIN, TENANT_A))).rejects.toBeInstanceOf(ForbiddenException);
      expect(queue.rangeCalls).toEqual([]);
      expect(sessions.queries).toEqual([]);
    });
  });

  describe('read-only', () => {
    it('does not add, remove, or re-score any queue member', async () => {
      enqueue(stored({ id: 'live' }));
      sessions.seed(stored({ id: 'stale', status: SessionStatus.OFFERED }));
      queue.seed(TENANT_A, 'en', 'stale', NOW - 500_000);

      const before = new Map([...queue.sets].map(([key, set]) => [key, new Map(set)] as const));

      await service.view(actor(AGENT_EN_HI, TENANT_A));

      expect(queue.sets.size).toBe(before.size);
      for (const [key, set] of queue.sets) {
        expect([...set.entries()].sort()).toEqual([...before.get(key)!.entries()].sort());
      }
    });

    it('does not touch any session row', async () => {
      enqueue(stored({ id: 'live', version: 7 }));
      const snapshot = { ...sessions.rows.get('live')! };

      await service.view(actor(AGENT_EN, TENANT_A));

      expect(sessions.rows.get('live')).toEqual(snapshot);
      expect(sessions.rows.get('live')!.version).toBe(7);
    });

    it('is idempotent: repeated views return the same sessions', async () => {
      enqueue(stored({ id: 'one', queuedAt: new Date(NOW - 200_000) }));
      enqueue(stored({ id: 'two', queuedAt: new Date(NOW - 100_000) }));

      const first = await ids(actor(AGENT_EN, TENANT_A));
      const second = await ids(actor(AGENT_EN, TENANT_A));
      const third = await ids(actor(AGENT_EN, TENANT_A));

      expect(first).toEqual(['one', 'two']);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it('reaches no session-mutating repository method', async () => {
      // The fake throws on create/findById/update, so any such call fails here.
      enqueue(stored({ id: 'live' }));
      await expect(service.view(actor(AGENT_EN, TENANT_A))).resolves.toBeDefined();
    });
  });
});
