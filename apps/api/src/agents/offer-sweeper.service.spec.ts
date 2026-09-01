/**
 * The offer sweeper, without a database.
 *
 * The session store applies the sweep's real predicates — `status = 'OFFERED'`
 * and `offer_expires_at <= now` — and bounds the batch, so a sweeper that
 * stopped filtering or stopped bounding fails here. The properties it cannot
 * show are the concurrent ones: that two instances take disjoint batches, and
 * that a sweep and an accept cannot both win the same row. Those need real
 * PostgreSQL, and `scripts/verify-agent-accept.ts` proves them.
 *
 * `PresenceService` is real, because "the swept agent stops being BUSY" is the
 * property that stops an abandoned offer silently ending an agent's shift.
 */

import { AgentPresence, SessionEventType, SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../common/logging/logger.js';
import type {
  AcceptCommand,
  ClaimableSessionRow,
  AgentWorkRow,
  MediaTokenSessionRow,
  ClaimCommand,
  CreateSessionInput,
  ExpiredOfferRow,
  ExpireOffersCommand,
  GuardedUpdate,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { OfferSweeper, SWEEP_BATCH, SWEEP_INTERVAL_MS } from './offer-sweeper.service.js';
import type { PresenceEntry, PresenceRepository, TouchResult } from './presence.repository.js';
import { PresenceService } from './presence.service.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_ONE = '00000000-0000-4000-8000-0000000000a1';
const AGENT_TWO = '00000000-0000-4000-8000-0000000000a2';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const silentLogger = () => createLogger({ level: 'silent' });

interface Stored {
  id: string;
  tenantId: string;
  status: SessionStatus;
  offeredToAgentId: string | null;
  offerExpiresAt: Date | null;
  version: number;
}

class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, Stored>();
  readonly commands: ExpireOffersCommand[] = [];

  seed(row: Stored): void {
    this.rows.set(row.id, row);
  }

  expireOffers(command: ExpireOffersCommand): Promise<readonly ExpiredOfferRow[]> {
    this.commands.push(command);
    if (command.limit <= 0) return Promise.resolve([]);

    const due = [...this.rows.values()]
      .filter(
        (row) =>
          row.status === SessionStatus.OFFERED &&
          row.offerExpiresAt !== null &&
          row.offerExpiresAt.getTime() <= command.now.getTime(),
      )
      .sort((a, b) => (a.offerExpiresAt?.getTime() ?? 0) - (b.offerExpiresAt?.getTime() ?? 0))
      .slice(0, command.limit);

    const swept = due.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      agentId: row.offeredToAgentId,
    }));

    for (const row of due) {
      this.rows.set(row.id, {
        ...row,
        status: SessionStatus.QUEUED,
        offeredToAgentId: null,
        offerExpiresAt: null,
        version: row.version + 1,
      });
    }
    return Promise.resolve(swept);
  }

  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('the sweeper must not create sessions');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('the sweeper must not read sessions one at a time');
  }
  findActiveWork(): Promise<readonly AgentWorkRow[]> {
    throw new Error('the sweeper must not read the active-work projection');
  }

  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('the sweeper must not read the media-token projection');
  }

  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('the sweeper must not read the claim projection');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('the sweeper must not read the queue projection');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('the sweeper must not use the customer guarded update');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('the sweeper must not claim');
  }
  accept(_c: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('the sweeper must not accept');
  }

  countActiveWork(): Promise<number> {
    throw new Error('the sweeper must not count an agent work');
  }
}

class FakeAgents implements AgentRepository {
  findAgentByEmail(): Promise<AgentCredentialRow | null> {
    throw new Error('the sweeper must not authenticate');
  }
  findProfile(): Promise<AgentProfileRow | null> {
    throw new Error('the sweeper must not read profiles');
  }
}

class FakePresence implements PresenceRepository {
  readonly entries = new Map<string, { status: AgentPresence; tenantId: string }>();
  failSetStatus = false;
  setStatusCalls = 0;

  set(entry: PresenceEntry): Promise<void> {
    this.entries.set(entry.agentId, { status: entry.status, tenantId: entry.tenantId });
    return Promise.resolve();
  }
  read(agentId: string) {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return Promise.resolve(null);
    return Promise.resolve({
      status: entry.status,
      languages: ['en'],
      lastSeen: new Date(NOW).toISOString(),
      tenantId: entry.tenantId,
    });
  }
  setStatus(agentId: string, status: AgentPresence): Promise<boolean> {
    this.setStatusCalls += 1;
    if (this.failSetStatus) return Promise.reject(new Error('redis unreachable'));
    const entry = this.entries.get(agentId);
    if (entry === undefined) return Promise.resolve(false);
    entry.status = status;
    return Promise.resolve(true);
  }
  touch(): Promise<TouchResult | null> {
    throw new Error('the sweeper must not heartbeat');
  }
  remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
    return Promise.resolve();
  }
  ttl(): Promise<number> {
    return Promise.resolve(15);
  }
}

const lapsed = (id: string, over: Partial<Stored> = {}): Stored => ({
  id,
  tenantId: TENANT_A,
  status: SessionStatus.OFFERED,
  offeredToAgentId: AGENT_ONE,
  offerExpiresAt: new Date(NOW - 1_000),
  version: 4,
  ...over,
});

describe('OfferSweeper', () => {
  let sessions: FakeSessions;
  let presence: FakePresence;
  let sweeper: OfferSweeper;

  const busy = (agentId: string, tenantId = TENANT_A): void => {
    presence.entries.set(agentId, { status: AgentPresence.BUSY, tenantId });
  };

  beforeEach(() => {
    sessions = new FakeSessions();
    presence = new FakePresence();
    sweeper = new OfferSweeper(
      sessions,
      new PresenceService(
        presence,
        new FakeAgents(),
        sessions,
        silentLogger(),
        () => new Date(NOW),
      ),
      silentLogger(),
      false,
      () => new Date(NOW),
    );
  });

  describe('what it sweeps', () => {
    it('returns a lapsed offer to the queue', async () => {
      sessions.seed(lapsed('a'));

      const result = await sweeper.sweep();

      expect(result.expired).toBe(1);
      expect(sessions.rows.get('a')?.status).toBe(SessionStatus.QUEUED);
    });

    it('clears the offer fields so nothing is left holding it', async () => {
      sessions.seed(lapsed('a'));

      await sweeper.sweep();

      expect(sessions.rows.get('a')?.offeredToAgentId).toBeNull();
      expect(sessions.rows.get('a')?.offerExpiresAt).toBeNull();
    });

    it('leaves an offer that has not lapsed', async () => {
      sessions.seed(lapsed('a', { offerExpiresAt: new Date(NOW + 1) }));

      const result = await sweeper.sweep();

      expect(result.expired).toBe(0);
      expect(sessions.rows.get('a')?.status).toBe(SessionStatus.OFFERED);
    });

    it('sweeps an offer expiring on this exact millisecond', async () => {
      // The boundary belongs to the sweeper, because accept requires `>`.
      sessions.seed(lapsed('a', { offerExpiresAt: new Date(NOW) }));

      expect((await sweeper.sweep()).expired).toBe(1);
    });

    it('leaves sessions that are not OFFERED', async () => {
      for (const status of [
        SessionStatus.QUEUED,
        SessionStatus.IN_CALL,
        SessionStatus.APPROVED,
        SessionStatus.DROPPED_QUEUED,
      ]) {
        sessions.seed(lapsed(`s-${status}`, { status }));
      }

      expect((await sweeper.sweep()).expired).toBe(0);
    });

    it('sweeps across tenants', async () => {
      // The one component with no caller and therefore no tenant to scope by.
      sessions.seed(lapsed('a', { tenantId: TENANT_A }));
      sessions.seed(lapsed('b', { tenantId: TENANT_B, offeredToAgentId: AGENT_TWO }));

      expect((await sweeper.sweep()).expired).toBe(2);
    });

    it('bounds one pass to the batch size', async () => {
      for (let i = 0; i < SWEEP_BATCH + 25; i += 1) {
        sessions.seed(lapsed(`s-${String(i).padStart(3, '0')}`));
      }

      const first = await sweeper.sweep();
      const second = await sweeper.sweep();

      expect(first.expired).toBe(SWEEP_BATCH);
      expect(second.expired).toBe(25);
      expect(sessions.commands[0]?.limit).toBe(SWEEP_BATCH);
    });

    it('is a no-op when nothing has lapsed', async () => {
      const result = await sweeper.sweep();

      expect(result).toEqual({ expired: 0, freed: 0 });
    });

    it('names the expiry event, not SESSION_QUEUED', async () => {
      sessions.seed(lapsed('a'));

      await sweeper.sweep();

      // The audit trail has to separate "the customer joined the queue" from
      // "an agent let this lapse".
      expect(sessions.commands[0]?.eventType).toBe(SessionEventType.OFFER_EXPIRED);
    });
  });

  describe('freeing the agent', () => {
    it('returns the agent to AVAILABLE', async () => {
      sessions.seed(lapsed('a'));
      busy(AGENT_ONE);

      const result = await sweeper.sweep();

      // Without this an agent whose offer lapsed stays BUSY for as long as
      // their heartbeat keeps refreshing the key — that is, indefinitely.
      expect(presence.entries.get(AGENT_ONE)?.status).toBe(AgentPresence.AVAILABLE);
      expect(result.freed).toBe(1);
    });

    it('frees each distinct agent once', async () => {
      sessions.seed(lapsed('a', { offeredToAgentId: AGENT_ONE }));
      sessions.seed(lapsed('b', { offeredToAgentId: AGENT_ONE }));
      sessions.seed(lapsed('c', { offeredToAgentId: AGENT_TWO }));
      busy(AGENT_ONE);
      busy(AGENT_TWO);

      const result = await sweeper.sweep();

      expect(result.expired).toBe(3);
      expect(result.freed).toBe(2);
      expect(presence.setStatusCalls).toBe(2);
    });

    it('counts an agent with no presence as not freed, and does not fail', async () => {
      sessions.seed(lapsed('a'));

      const result = await sweeper.sweep();

      expect(result.expired).toBe(1);
      expect(result.freed).toBe(0);
    });

    it('still returns the sessions when Redis is unreachable', async () => {
      sessions.seed(lapsed('a'));
      busy(AGENT_ONE);
      presence.failSetStatus = true;

      const result = await sweeper.sweep();

      // PostgreSQL already committed; a Redis failure must not undo it.
      expect(result.expired).toBe(1);
      expect(sessions.rows.get('a')?.status).toBe(SessionStatus.QUEUED);
    });

    it('keeps freeing the other agents after one fails', async () => {
      sessions.seed(lapsed('a', { offeredToAgentId: AGENT_ONE }));
      sessions.seed(lapsed('b', { offeredToAgentId: AGENT_TWO }));
      busy(AGENT_ONE);
      busy(AGENT_TWO);
      let calls = 0;
      const original = presence.setStatus.bind(presence);
      presence.setStatus = (agentId, status) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('redis blip'));
        return original(agentId, status);
      };

      const result = await sweeper.sweep();

      expect(result.freed).toBe(1);
    });
  });

  describe('the timer', () => {
    it('does not start when disabled', () => {
      sweeper.onModuleInit();
      // Nothing to assert beyond it being safe to call and to tear down: a
      // suite whose fixtures changed under it from a background pass would be
      // the failure this prevents.
      expect(() => sweeper.onModuleDestroy()).not.toThrow();
    });

    it('runs a pass on an interval well inside the default offer window', () => {
      // 5s against a 30s default: an abandoned offer comes back while the
      // customer is plausibly still waiting.
      expect(SWEEP_INTERVAL_MS).toBeLessThan(30_000);
      expect(SWEEP_INTERVAL_MS).toBeGreaterThan(0);
    });

    it('is safe to stop without ever having started', () => {
      expect(() => sweeper.onModuleDestroy()).not.toThrow();
    });
  });
});
