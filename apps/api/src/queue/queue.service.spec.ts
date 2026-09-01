/**
 * The queue projection's behaviour, without Redis.
 *
 * The repository is a fake that can be told to fail, which is how the important
 * case is reached: the database has committed, `ZADD` throws, and the system
 * must stay correct. §28 of the task rules out testing that by stopping Redis —
 * T11's idempotency also lives there, so the request would fail before reaching
 * the handler. The fault belongs at this boundary.
 *
 * Real Redis is exercised separately by `scripts/verify-queue.ts`.
 */

import { describe, expect, it } from 'vitest';
import { SessionStatus } from '@vcip/shared';
import { createLogger } from '../common/logging/logger.js';
import type { SessionRow } from '../sessions/session.repository.js';
import { queueKey } from './queue.keys.js';
import type {
  QueueCandidate,
  QueueEntry,
  QueueMember,
  QueueRepository,
} from './queue.repository.js';
import type { WaitingAhead } from './queue.service.js';
import { QueueService } from './queue.service.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

/** Silenced: these tests assert behaviour, not log output. */
const silentLogger = () => createLogger({ level: 'silent' });

/** An in-memory ZSET with the real ordering semantics. */
class FakeQueueRepository implements QueueRepository {
  readonly sets = new Map<string, Map<string, number>>();
  addCalls = 0;
  rankCalls = 0;
  /** When set, every operation throws it. */
  failure: Error | null = null;
  /** When positive, only the first N `add` calls throw. */
  failAddTimes = 0;

  async add(entry: QueueEntry): Promise<void> {
    await Promise.resolve();
    this.addCalls += 1;
    if (this.failAddTimes > 0) {
      this.failAddTimes -= 1;
      throw new Error('ECONNRESET');
    }
    if (this.failure !== null) throw this.failure;
    const key = queueKey(entry.tenantId, entry.language);
    const set = this.sets.get(key) ?? new Map<string, number>();
    set.set(entry.sessionId, entry.score);
    this.sets.set(key, set);
  }

  async rank(member: QueueMember): Promise<number | null> {
    await Promise.resolve();
    this.rankCalls += 1;
    if (this.failure !== null) throw this.failure;
    const set = this.sets.get(queueKey(member.tenantId, member.language));
    if (set === undefined || !set.has(member.sessionId)) return null;
    const ordered = [...set.entries()].sort(
      (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    return ordered.findIndex(([id]) => id === member.sessionId);
  }

  async range(tenantId: string, language: string, limit: number): Promise<QueueCandidate[]> {
    await Promise.resolve();
    if (this.failure !== null) throw this.failure;
    if (limit <= 0) return [];
    const set = this.sets.get(queueKey(tenantId, language));
    if (set === undefined) return [];
    return [...set.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([sessionId, score]) => ({ sessionId, score }));
  }

  scoreOf(tenantId: string, language: string, sessionId: string): number | undefined {
    return this.sets.get(queueKey(tenantId, language))?.get(sessionId);
  }

  sizeOf(tenantId: string, language: string): number {
    return this.sets.get(queueKey(tenantId, language))?.size ?? 0;
  }
}

const QUEUED_AT = new Date('2026-08-30T10:00:00.000Z');

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: TENANT_A,
  externalRef: 'demo-1',
  status: SessionStatus.QUEUED,
  version: 2,
  language: 'en',
  roomName: 'vcip_22222222-2222-4222-8222-222222222222',
  checklistTemplateId: null,
  consentOk: true,
  consentVersion: 'v1',
  consentAt: QUEUED_AT,
  preflightOk: true,
  preflightAt: QUEUED_AT,
  geoOk: true,
  gpsAccuracyM: 20,
  geoCheckedAt: QUEUED_AT,
  ipCountry: 'IN',
  queuedAt: QUEUED_AT,
  connectedAt: null,
  endedAt: null,
  verdict: null,
  exportStatus: 'NOT_STARTED',
  createdAt: QUEUED_AT,
  updatedAt: QUEUED_AT,
  ...overrides,
});

/**
 * Everybody ranked ahead is still waiting.
 *
 * The queue with no stale members in it, which is what the ordering tests are
 * about: under this confirmation a position is exactly the rank plus one, so
 * every FIFO property below is asserted against the same numbers it always was.
 */
const allWaiting: WaitingAhead = async (ids) => ids.length;

/**
 * Only these sessions are still `QUEUED`, as far as PostgreSQL is concerned.
 *
 * Anything else ranked ahead is a member T18 left behind — claimed, in a call,
 * or finished — and must not be counted.
 */
const onlyWaiting = (...stillQueued: readonly string[]): WaitingAhead => {
  const waiting = new Set(stillQueued);
  return async (ids) => ids.filter((id) => waiting.has(id)).length;
};

const build = (repo: FakeQueueRepository = new FakeQueueRepository()) => ({
  repo,
  service: new QueueService(repo, silentLogger()),
});

// ------------------------------------------------------------------ enqueue

describe('enqueue', () => {
  it('adds the session at its queued_at score and returns position 1', async () => {
    const { repo, service } = build();
    const row = session();
    expect(await service.enqueue(row, allWaiting)).toBe(1);
    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBe(QUEUED_AT.getTime());
  });

  it('scores from queued_at, not from the clock at enqueue time', async () => {
    // Mutation B. The session was queued 45 minutes ago and is only now being
    // added; the score must be the old timestamp, not now.
    const historical = new Date(Date.now() - 45 * 60 * 1000);
    const { repo, service } = build();
    const row = session({ queuedAt: historical });

    await service.enqueue(row, allWaiting);

    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBe(historical.getTime());
    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBeLessThan(Date.now() - 60_000);
  });

  it('puts an older session ahead of a newer one', async () => {
    const { service } = build();
    const first = session({ id: 'aaaa', queuedAt: new Date('2026-08-30T10:00:00Z') });
    const second = session({ id: 'bbbb', queuedAt: new Date('2026-08-30T10:01:00Z') });

    await service.enqueue(second, allWaiting);
    await service.enqueue(first, allWaiting);

    // Insertion order reversed; queue order follows queued_at, not arrival.
    expect(await service.positionFor(first, allWaiting)).toBe(1);
    expect(await service.positionFor(second, allWaiting)).toBe(2);
  });

  it('is idempotent: enqueueing twice does not duplicate the member', async () => {
    const { repo, service } = build();
    const row = session();
    await service.enqueue(row, allWaiting);
    await service.enqueue(row, allWaiting);
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
    expect(await service.positionFor(row, allWaiting)).toBe(1);
  });

  it('keeps tenants apart', async () => {
    const { repo, service } = build();
    const a = session({ id: 'aaaa', tenantId: TENANT_A });
    const b = session({ id: 'bbbb', tenantId: TENANT_B });
    await service.enqueue(a, allWaiting);
    await service.enqueue(b, allWaiting);

    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
    expect(repo.sizeOf(TENANT_B, 'en')).toBe(1);
    // Each is first in its own queue, not second in a shared one.
    expect(await service.positionFor(a, allWaiting)).toBe(1);
    expect(await service.positionFor(b, allWaiting)).toBe(1);
  });

  it('keeps languages apart', async () => {
    const { service } = build();
    const en = session({ id: 'aaaa', language: 'en' });
    const hi = session({ id: 'bbbb', language: 'hi' });
    await service.enqueue(en, allWaiting);
    await service.enqueue(hi, allWaiting);
    expect(await service.positionFor(en, allWaiting)).toBe(1);
    expect(await service.positionFor(hi, allWaiting)).toBe(1);
  });

  it('retries a transient failure and succeeds', async () => {
    const repo = new FakeQueueRepository();
    repo.failAddTimes = 2;
    const { service } = build(repo);

    expect(await service.enqueue(session(), allWaiting)).toBe(1);
    expect(repo.addCalls).toBe(3);
  });

  it('returns null rather than throwing when every attempt fails', async () => {
    // The critical case: PostgreSQL has committed. Throwing here would turn a
    // successful business transition into a failed HTTP request.
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);

    await expect(service.enqueue(session(), allWaiting)).resolves.toBeNull();
  });

  it('gives up after a bounded number of attempts', async () => {
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await service.enqueue(session(), allWaiting);
    expect(repo.addCalls).toBe(3);
  });

  it('refuses to invent a score for a session with no queued_at', async () => {
    const { repo, service } = build();
    expect(await service.enqueue(session({ queuedAt: null }), allWaiting)).toBeNull();
    expect(repo.addCalls).toBe(0);
  });
});

// ----------------------------------------------------------------- position

describe('positionFor', () => {
  it('returns rank + 1', async () => {
    const { service } = build();
    const a = session({ id: 'aaaa', queuedAt: new Date('2026-08-30T10:00:00Z') });
    const b = session({ id: 'bbbb', queuedAt: new Date('2026-08-30T10:01:00Z') });
    const c = session({ id: 'cccc', queuedAt: new Date('2026-08-30T10:02:00Z') });
    for (const row of [a, b, c]) await service.enqueue(row, allWaiting);

    expect(await service.positionFor(a, allWaiting)).toBe(1);
    expect(await service.positionFor(b, allWaiting)).toBe(2);
    expect(await service.positionFor(c, allWaiting)).toBe(3);
  });

  it('breaks equal scores deterministically, by member', async () => {
    // Redis orders equal scores lexically by member. UUIDs make that arbitrary
    // but stable — the same queue state always yields the same position, which
    // is what matters. It is asserted rather than left to chance.
    const { service } = build();
    const same = new Date('2026-08-30T10:00:00.000Z');
    const first = session({ id: 'aaaa', queuedAt: same });
    const second = session({ id: 'bbbb', queuedAt: same });
    await service.enqueue(second, allWaiting);
    await service.enqueue(first, allWaiting);

    expect(await service.positionFor(first, allWaiting)).toBe(1);
    expect(await service.positionFor(second, allWaiting)).toBe(2);
    // Stable across repeated reads.
    expect(await service.positionFor(first, allWaiting)).toBe(1);
  });

  it('is null for a session that is not QUEUED', async () => {
    const { service } = build();
    for (const status of [
      SessionStatus.CREATED,
      SessionStatus.OFFERED,
      SessionStatus.IN_CALL,
      SessionStatus.APPROVED,
      SessionStatus.ABORTED,
      SessionStatus.PREFLIGHT_FAILED,
    ]) {
      expect(await service.positionFor(session({ status }), allWaiting)).toBeNull();
    }
  });

  it('is null when Redis cannot answer', async () => {
    // Mutation E. A number here would be a fabricated place in a queue we
    // cannot see.
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await expect(service.positionFor(session(), allWaiting)).resolves.toBeNull();
  });
});

// ------------------------------------------------------------ reconciliation

describe('lazy reconciliation', () => {
  it('restores a QUEUED session that is missing from Redis', async () => {
    const { repo, service } = build();
    const row = session();
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(0);

    expect(await service.positionFor(row, allWaiting)).toBe(1);
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
  });

  it('restores it at its original queued_at, not at the reconciliation time', async () => {
    // The property that makes a crash survivable without losing the customer's
    // place: reconciling at 10:10 a session queued at 10:00 must not send it
    // behind sessions that arrived at 10:05.
    const { repo, service } = build();
    const stranded = session({ id: 'aaaa', queuedAt: new Date('2026-08-30T10:00:00Z') });
    const newer = session({ id: 'bbbb', queuedAt: new Date('2026-08-30T10:05:00Z') });

    await service.enqueue(newer, allWaiting);
    const position = await service.positionFor(stranded, allWaiting);

    expect(position).toBe(1);
    expect(repo.scoreOf(TENANT_A, 'en', 'aaaa')).toBe(new Date('2026-08-30T10:00:00Z').getTime());
    expect(await service.positionFor(newer, allWaiting)).toBe(2);
  });

  it('is safe to run repeatedly', async () => {
    const { repo, service } = build();
    const row = session();
    await service.reconcile(row, allWaiting);
    await service.reconcile(row, allWaiting);
    await service.reconcile(row, allWaiting);
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
    expect(await service.positionFor(row, allWaiting)).toBe(1);
  });

  it('does not move a session that is already correctly placed', async () => {
    const { repo, service } = build();
    const row = session();
    await service.enqueue(row, allWaiting);
    const before = repo.scoreOf(TENANT_A, 'en', row.id);
    await service.reconcile(row, allWaiting);
    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBe(before);
  });

  it('refuses to reinsert an OFFERED session', async () => {
    // Mutation H, and the reason the gate is a positive check. An OFFERED
    // session was removed by a claim; putting it back would let a second agent
    // claim the same customer.
    const { repo, service } = build();
    expect(
      await service.reconcile(session({ status: SessionStatus.OFFERED }), allWaiting),
    ).toBeNull();
    expect(repo.addCalls).toBe(0);
  });

  it('refuses to reinsert an IN_CALL session', async () => {
    const { repo, service } = build();
    expect(
      await service.reconcile(session({ status: SessionStatus.IN_CALL }), allWaiting),
    ).toBeNull();
    expect(repo.addCalls).toBe(0);
  });

  it('refuses to reinsert a terminal session', async () => {
    const { repo, service } = build();
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
      SessionStatus.PREFLIGHT_FAILED,
    ]) {
      expect(await service.reconcile(session({ status }), allWaiting)).toBeNull();
    }
    expect(repo.addCalls).toBe(0);
  });

  it('refuses to reinsert a CREATED session', async () => {
    const { repo, service } = build();
    expect(
      await service.reconcile(session({ status: SessionStatus.CREATED }), allWaiting),
    ).toBeNull();
    expect(repo.addCalls).toBe(0);
  });

  it('returns null when Redis is unavailable, without throwing', async () => {
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await expect(service.reconcile(session(), allWaiting)).resolves.toBeNull();
  });
});

// ------------------------------------------------------------------ contains

// ------------------------------------------------ positions and stale members

describe('a position counts who is waiting, not who is ranked ahead', () => {
  // The regression. T18's claim deliberately does not ZREM, so the ZSET holds
  // members for sessions that are OFFERED, IN_CALL or finished. Counting those
  // told a customer they were third when they were first, and — worse — the
  // number could only ever grow, since nothing left the set as people were
  // served.

  const AHEAD_ONE = '11111111-1111-4111-8111-111111111111';
  const AHEAD_TWO = '33333333-3333-4333-8333-333333333333';
  const MINE = '22222222-2222-4222-8222-222222222222';

  /** Three sessions in one queue, oldest first, `mine` last. */
  const threeInLine = async (service: QueueService) => {
    const first = session({ id: AHEAD_ONE, queuedAt: new Date(QUEUED_AT.getTime() - 2000) });
    const second = session({ id: AHEAD_TWO, queuedAt: new Date(QUEUED_AT.getTime() - 1000) });
    const mine = session({ id: MINE, queuedAt: QUEUED_AT });
    for (const row of [first, second, mine]) await service.enqueue(row, allWaiting);
    return { first, second, mine };
  };

  it('ignores members whose sessions are no longer queued', async () => {
    const { service } = build();
    const { mine } = await threeInLine(service);
    expect(await service.positionFor(mine, allWaiting)).toBe(3);

    // Both agents ahead were claimed. Redis still holds all three members.
    expect(await service.positionFor(mine, onlyWaiting(MINE))).toBe(1);
  });

  it('counts down as the customers ahead are served', async () => {
    const { service } = build();
    const { mine } = await threeInLine(service);

    expect(await service.positionFor(mine, onlyWaiting(AHEAD_ONE, AHEAD_TWO, MINE))).toBe(3);
    expect(await service.positionFor(mine, onlyWaiting(AHEAD_TWO, MINE))).toBe(2);
    expect(await service.positionFor(mine, onlyWaiting(MINE))).toBe(1);
  });

  it('leaves the stale members in Redis — the queue is still a projection', async () => {
    // T18's ruling: no ZREM on claim. Reading a position must not quietly
    // become a write that removes one.
    const { repo, service } = build();
    const { mine } = await threeInLine(service);

    await service.positionFor(mine, onlyWaiting(MINE));

    expect(repo.sizeOf(TENANT_A, 'en')).toBe(3);
  });

  it('reports position 1 to the session at the front without asking at all', async () => {
    // Rank zero has nobody ahead, so there is nothing to confirm. The customer
    // at the front polls most often; this is the call that must stay free.
    const { service } = build();
    const row = session();
    await service.enqueue(row, allWaiting);

    let asked = 0;
    const counting: WaitingAhead = async (ids) => {
      asked += 1;
      return ids.length;
    };

    expect(await service.positionFor(row, counting)).toBe(1);
    expect(asked).toBe(0);
  });

  it('confirms exactly the members ranked ahead, and no others', async () => {
    const { service } = build();
    const { mine } = await threeInLine(service);

    let seen: readonly string[] = [];
    await service.positionFor(mine, async (ids) => {
      seen = ids;
      return ids.length;
    });

    // Not the session itself, and not anybody behind it.
    expect([...seen].sort()).toEqual([AHEAD_ONE, AHEAD_TWO].sort());
    expect(seen).not.toContain(MINE);
  });

  it('reports no position rather than a wrong one when the confirmation fails', async () => {
    // PostgreSQL is unreachable. The honest answer is "we cannot say" — the
    // same answer a missing member gets. Falling back to the raw rank would be
    // reporting a number already known to be inflated.
    const { service } = build();
    const { mine } = await threeInLine(service);

    const position = await service.positionFor(mine, async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(position).toBeNull();
  });

  it('does not throw when the confirmation fails during enqueue', async () => {
    // Post-commit. Nothing here may fail an operation PostgreSQL has already
    // durably recorded.
    const { service } = build();
    await service.enqueue(session({ id: AHEAD_ONE }), allWaiting);

    await expect(
      service.enqueue(session({ id: MINE }), async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).resolves.toBeNull();
  });

  it('filters on enqueue too, so the first number a customer sees is right', async () => {
    const { service } = build();
    await service.enqueue(
      session({ id: AHEAD_ONE, queuedAt: new Date(QUEUED_AT.getTime() - 1000) }),
      allWaiting,
    );

    // The one ahead has already been claimed by the time this customer queues.
    const position = await service.enqueue(session({ id: MINE }), onlyWaiting(MINE));

    expect(position).toBe(1);
  });

  it('filters on reconciliation too', async () => {
    const { repo, service } = build();
    await service.enqueue(
      session({ id: AHEAD_ONE, queuedAt: new Date(QUEUED_AT.getTime() - 1000) }),
      allWaiting,
    );

    // Restored after Redis lost it: the position it earned, counted correctly.
    const mine = session({ id: MINE });
    const position = await service.reconcile(mine, onlyWaiting(MINE));

    expect(position).toBe(1);
    expect(repo.scoreOf(TENANT_A, 'en', MINE)).toBe(QUEUED_AT.getTime());
  });

  it('never reports zero, however many ahead are stale', async () => {
    // Position zero would be a place in the queue that does not exist, and it
    // is what an off-by-one in the filtering would produce.
    const { service } = build();
    const { mine } = await threeInLine(service);

    for (const confirm of [allWaiting, onlyWaiting(AHEAD_ONE, MINE), onlyWaiting(MINE)]) {
      expect(await service.positionFor(mine, confirm)).toBeGreaterThanOrEqual(1);
    }
  });

  it('still reports null for a session PostgreSQL does not call QUEUED', async () => {
    // The status gate is unchanged: this is about who is counted, not about
    // who gets a position at all.
    const { service } = build();
    await threeInLine(service);

    expect(
      await service.positionFor(session({ id: MINE, status: SessionStatus.OFFERED }), allWaiting),
    ).toBeNull();
  });
});

describe('contains', () => {
  it('reports membership without asserting anything about business state', async () => {
    const { service } = build();
    const row = session();
    expect(await service.contains(row)).toBe(false);
    await service.enqueue(row, allWaiting);
    expect(await service.contains(row)).toBe(true);
  });

  it('is false, not an error, when Redis is unavailable', async () => {
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await expect(service.contains(session())).resolves.toBe(false);
  });
});

// ------------------------------------------------------------------- surface

describe('the service surface', () => {
  // Named explicitly rather than guessed from a prefix: TypeScript's `private`
  // does not exist at runtime, so the only honest way to keep this exhaustive
  // is to say which methods are internals. A new public method fails the test,
  // which is the point.
  const INTERNAL = ['constructor', 'positionOf', 'confirm', 'isQueued', 'logAdapterFailure'];

  it('exposes no removal operation', () => {
    // T18 ruled that a claim does not ZREM — the queue stays a derived
    // projection and the read path filters what has gone stale instead. So
    // there is still no caller for a removal, and a position lookup must never
    // quietly become one.
    const surface = Object.getOwnPropertyNames(QueueService.prototype).filter(
      (name) => !INTERNAL.includes(name),
    );
    expect(surface.sort()).toEqual(['contains', 'enqueue', 'positionFor', 'reconcile']);
  });

  it('names nothing that removes, evicts or drops', () => {
    // The property the list above is standing in for, asserted directly, so a
    // removal added under any name is caught rather than only an added export.
    const named = Object.getOwnPropertyNames(QueueService.prototype);
    expect(named.filter((name) => /remov|delet|zrem|evict|drop|prune/i.test(name))).toEqual([]);
  });
});

// ------------------------------------------------------------------- logging

describe('logging', () => {
  it('records identifiers and an error name, never a payload or a message', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      destination: {
        write(chunk: string): boolean {
          lines.push(chunk);
          return true;
        },
      } as never,
    });
    const repo = new FakeQueueRepository();
    repo.failure = new Error('connect ECONNREFUSED 10.1.2.3:6379');
    const service = new QueueService(repo, logger);

    await service.enqueue(session(), allWaiting);

    const output = lines.join('');
    expect(output).toContain('queue.enqueue.failed');
    expect(output).toContain(TENANT_A);
    // The error's message can name a host and port. Only its name is logged.
    expect(output).not.toContain('10.1.2.3');
    expect(output).not.toContain('ECONNREFUSED');
  });
});
