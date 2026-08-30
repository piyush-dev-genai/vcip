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
import type { QueueEntry, QueueMember, QueueRepository } from './queue.repository.js';
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

const build = (repo: FakeQueueRepository = new FakeQueueRepository()) => ({
  repo,
  service: new QueueService(repo, silentLogger()),
});

// ------------------------------------------------------------------ enqueue

describe('enqueue', () => {
  it('adds the session at its queued_at score and returns position 1', async () => {
    const { repo, service } = build();
    const row = session();
    expect(await service.enqueue(row)).toBe(1);
    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBe(QUEUED_AT.getTime());
  });

  it('scores from queued_at, not from the clock at enqueue time', async () => {
    // Mutation B. The session was queued 45 minutes ago and is only now being
    // added; the score must be the old timestamp, not now.
    const historical = new Date(Date.now() - 45 * 60 * 1000);
    const { repo, service } = build();
    const row = session({ queuedAt: historical });

    await service.enqueue(row);

    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBe(historical.getTime());
    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBeLessThan(Date.now() - 60_000);
  });

  it('puts an older session ahead of a newer one', async () => {
    const { service } = build();
    const first = session({ id: 'aaaa', queuedAt: new Date('2026-08-30T10:00:00Z') });
    const second = session({ id: 'bbbb', queuedAt: new Date('2026-08-30T10:01:00Z') });

    await service.enqueue(second);
    await service.enqueue(first);

    // Insertion order reversed; queue order follows queued_at, not arrival.
    expect(await service.positionFor(first)).toBe(1);
    expect(await service.positionFor(second)).toBe(2);
  });

  it('is idempotent: enqueueing twice does not duplicate the member', async () => {
    const { repo, service } = build();
    const row = session();
    await service.enqueue(row);
    await service.enqueue(row);
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
    expect(await service.positionFor(row)).toBe(1);
  });

  it('keeps tenants apart', async () => {
    const { repo, service } = build();
    const a = session({ id: 'aaaa', tenantId: TENANT_A });
    const b = session({ id: 'bbbb', tenantId: TENANT_B });
    await service.enqueue(a);
    await service.enqueue(b);

    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
    expect(repo.sizeOf(TENANT_B, 'en')).toBe(1);
    // Each is first in its own queue, not second in a shared one.
    expect(await service.positionFor(a)).toBe(1);
    expect(await service.positionFor(b)).toBe(1);
  });

  it('keeps languages apart', async () => {
    const { service } = build();
    const en = session({ id: 'aaaa', language: 'en' });
    const hi = session({ id: 'bbbb', language: 'hi' });
    await service.enqueue(en);
    await service.enqueue(hi);
    expect(await service.positionFor(en)).toBe(1);
    expect(await service.positionFor(hi)).toBe(1);
  });

  it('retries a transient failure and succeeds', async () => {
    const repo = new FakeQueueRepository();
    repo.failAddTimes = 2;
    const { service } = build(repo);

    expect(await service.enqueue(session())).toBe(1);
    expect(repo.addCalls).toBe(3);
  });

  it('returns null rather than throwing when every attempt fails', async () => {
    // The critical case: PostgreSQL has committed. Throwing here would turn a
    // successful business transition into a failed HTTP request.
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);

    await expect(service.enqueue(session())).resolves.toBeNull();
  });

  it('gives up after a bounded number of attempts', async () => {
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await service.enqueue(session());
    expect(repo.addCalls).toBe(3);
  });

  it('refuses to invent a score for a session with no queued_at', async () => {
    const { repo, service } = build();
    expect(await service.enqueue(session({ queuedAt: null }))).toBeNull();
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
    for (const row of [a, b, c]) await service.enqueue(row);

    expect(await service.positionFor(a)).toBe(1);
    expect(await service.positionFor(b)).toBe(2);
    expect(await service.positionFor(c)).toBe(3);
  });

  it('breaks equal scores deterministically, by member', async () => {
    // Redis orders equal scores lexically by member. UUIDs make that arbitrary
    // but stable — the same queue state always yields the same position, which
    // is what matters. It is asserted rather than left to chance.
    const { service } = build();
    const same = new Date('2026-08-30T10:00:00.000Z');
    const first = session({ id: 'aaaa', queuedAt: same });
    const second = session({ id: 'bbbb', queuedAt: same });
    await service.enqueue(second);
    await service.enqueue(first);

    expect(await service.positionFor(first)).toBe(1);
    expect(await service.positionFor(second)).toBe(2);
    // Stable across repeated reads.
    expect(await service.positionFor(first)).toBe(1);
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
      expect(await service.positionFor(session({ status }))).toBeNull();
    }
  });

  it('is null when Redis cannot answer', async () => {
    // Mutation E. A number here would be a fabricated place in a queue we
    // cannot see.
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await expect(service.positionFor(session())).resolves.toBeNull();
  });
});

// ------------------------------------------------------------ reconciliation

describe('lazy reconciliation', () => {
  it('restores a QUEUED session that is missing from Redis', async () => {
    const { repo, service } = build();
    const row = session();
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(0);

    expect(await service.positionFor(row)).toBe(1);
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
  });

  it('restores it at its original queued_at, not at the reconciliation time', async () => {
    // The property that makes a crash survivable without losing the customer's
    // place: reconciling at 10:10 a session queued at 10:00 must not send it
    // behind sessions that arrived at 10:05.
    const { repo, service } = build();
    const stranded = session({ id: 'aaaa', queuedAt: new Date('2026-08-30T10:00:00Z') });
    const newer = session({ id: 'bbbb', queuedAt: new Date('2026-08-30T10:05:00Z') });

    await service.enqueue(newer);
    const position = await service.positionFor(stranded);

    expect(position).toBe(1);
    expect(repo.scoreOf(TENANT_A, 'en', 'aaaa')).toBe(new Date('2026-08-30T10:00:00Z').getTime());
    expect(await service.positionFor(newer)).toBe(2);
  });

  it('is safe to run repeatedly', async () => {
    const { repo, service } = build();
    const row = session();
    await service.reconcile(row);
    await service.reconcile(row);
    await service.reconcile(row);
    expect(repo.sizeOf(TENANT_A, 'en')).toBe(1);
    expect(await service.positionFor(row)).toBe(1);
  });

  it('does not move a session that is already correctly placed', async () => {
    const { repo, service } = build();
    const row = session();
    await service.enqueue(row);
    const before = repo.scoreOf(TENANT_A, 'en', row.id);
    await service.reconcile(row);
    expect(repo.scoreOf(TENANT_A, 'en', row.id)).toBe(before);
  });

  it('refuses to reinsert an OFFERED session', async () => {
    // Mutation H, and the reason the gate is a positive check. An OFFERED
    // session was removed by a claim; putting it back would let a second agent
    // claim the same customer.
    const { repo, service } = build();
    expect(await service.reconcile(session({ status: SessionStatus.OFFERED }))).toBeNull();
    expect(repo.addCalls).toBe(0);
  });

  it('refuses to reinsert an IN_CALL session', async () => {
    const { repo, service } = build();
    expect(await service.reconcile(session({ status: SessionStatus.IN_CALL }))).toBeNull();
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
      expect(await service.reconcile(session({ status }))).toBeNull();
    }
    expect(repo.addCalls).toBe(0);
  });

  it('refuses to reinsert a CREATED session', async () => {
    const { repo, service } = build();
    expect(await service.reconcile(session({ status: SessionStatus.CREATED }))).toBeNull();
    expect(repo.addCalls).toBe(0);
  });

  it('returns null when Redis is unavailable, without throwing', async () => {
    const repo = new FakeQueueRepository();
    repo.failure = new Error('ECONNREFUSED');
    const { service } = build(repo);
    await expect(service.reconcile(session())).resolves.toBeNull();
  });
});

// ------------------------------------------------------------------ contains

describe('contains', () => {
  it('reports membership without asserting anything about business state', async () => {
    const { service } = build();
    const row = session();
    expect(await service.contains(row)).toBe(false);
    await service.enqueue(row);
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
  it('exposes no removal operation', () => {
    // T15 has no path that needs one, and an unused export is code nobody has
    // run. T18's claim adds it with its first caller.
    const surface = Object.getOwnPropertyNames(QueueService.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('log') && !name.startsWith('is'),
    );
    expect(surface.sort()).toEqual(['contains', 'enqueue', 'positionFor', 'reconcile']);
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

    await service.enqueue(session());

    const output = lines.join('');
    expect(output).toContain('queue.enqueue.failed');
    expect(output).toContain(TENANT_A);
    // The error's message can name a host and port. Only its name is logged.
    expect(output).not.toContain('10.1.2.3');
    expect(output).not.toContain('ECONNREFUSED');
  });
});
