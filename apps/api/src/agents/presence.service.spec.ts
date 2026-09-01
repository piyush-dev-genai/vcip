import { AgentPresence, ErrorCode } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActor } from '../common/auth/auth-context.js';
import { createLogger } from '../common/logging/logger.js';
import type {
  ClaimableSessionRow,
  MediaTokenSessionRow,
  ExpiredOfferRow,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import type { AgentProfileRow, AgentRepository, AgentCredentialRow } from './agent.repository.js';
import { presenceKey, PRESENCE_TTL_SECONDS } from './presence.keys.js';
import type { PresenceEntry, PresenceRepository, TouchResult } from './presence.repository.js';
import { PresenceService } from './presence.service.js';

/**
 * `PresenceService` against a Redis substitute that keeps the two properties
 * the real one is built around: a TTL that actually expires, and a `touch`
 * that refuses to create.
 *
 * A fake that ignored expiry would make every liveness assertion below
 * vacuous, so this one prunes on read against an injected clock. The genuine
 * Lua atomicity is proved against a real server by
 * `scripts/verify-presence.ts`; what is proved here is the behaviour built on
 * top of it.
 */

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A = '00000000-0000-4000-8000-000000000001';
const AGENT_B = '00000000-0000-4000-8000-000000000002';

interface StoredKey {
  readonly fields: Map<string, string>;
  expiresAtMs: number;
}

class FakePresenceRepository implements PresenceRepository {
  readonly keys = new Map<string, StoredKey>();

  constructor(private readonly nowMs: () => number) {}

  /** Everything reads through here, so an expired key is simply not there. */
  private live(agentId: string): StoredKey | undefined {
    const key = presenceKey(agentId);
    const entry = this.keys.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.nowMs()) {
      this.keys.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(entry: PresenceEntry): Promise<void> {
    const fields = new Map<string, string>([
      ['status', entry.status],
      ['languages', JSON.stringify(entry.languages)],
      ['last_seen', entry.lastSeen.toISOString()],
      ['tenant_id', entry.tenantId],
    ]);
    this.keys.set(presenceKey(entry.agentId), {
      fields,
      expiresAtMs: this.nowMs() + PRESENCE_TTL_SECONDS * 1000,
    });
    return Promise.resolve();
  }

  async touch(agentId: string, lastSeen: Date): Promise<TouchResult | null> {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(null);
    const iso = lastSeen.toISOString();
    entry.fields.set('last_seen', iso);
    entry.expiresAtMs = this.nowMs() + PRESENCE_TTL_SECONDS * 1000;
    const status = entry.fields.get('status');
    if (status === undefined) return Promise.resolve(null);
    return Promise.resolve({ status: status as AgentPresence, lastSeen: iso });
  }

  async read(agentId: string) {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(null);
    return Promise.resolve({
      status: (entry.fields.get('status') ?? '') as AgentPresence,
      languages: JSON.parse(entry.fields.get('languages') ?? '[]') as string[],
      lastSeen: entry.fields.get('last_seen') ?? '',
      tenantId: entry.fields.get('tenant_id') ?? '',
    });
  }

  async remove(agentId: string): Promise<void> {
    this.keys.delete(presenceKey(agentId));
    return Promise.resolve();
  }

  async setStatus(agentId: string, status: AgentPresence): Promise<boolean> {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(false);
    entry.fields.set('status', status);
    entry.expiresAtMs = this.nowMs() + PRESENCE_TTL_SECONDS * 1000;
    return Promise.resolve(true);
  }

  async ttl(agentId: string): Promise<number> {
    const entry = this.live(agentId);
    if (entry === undefined) return Promise.resolve(-2);
    return Promise.resolve(Math.ceil((entry.expiresAtMs - this.nowMs()) / 1000));
  }
}

/** Two agents in tenant A, plus a tenant-admin user with no agent profile. */
class FakeAgentRepository implements AgentRepository {
  readonly profiles: AgentProfileRow[] = [
    { userId: AGENT_A, tenantId: TENANT_A, languages: ['en', 'hi'], maxConcurrent: 1 },
    { userId: AGENT_B, tenantId: TENANT_A, languages: ['en'], maxConcurrent: 2 },
  ];

  findAgentByEmail(): Promise<AgentCredentialRow | null> {
    return Promise.resolve(null);
  }

  findProfile(userId: string, tenantId: string): Promise<AgentProfileRow | null> {
    return Promise.resolve(
      this.profiles.find((p) => p.userId === userId && p.tenantId === tenantId) ?? null,
    );
  }
}

/**
 * The sessions an agent is holding, as PostgreSQL would report them.
 *
 * Only `countActiveWork` is real: it is the one method the presence service
 * calls, and every other member throws so a presence path that started reading
 * or writing sessions would fail loudly rather than quietly widen its reach.
 */
class FakeSessionRepository implements SessionRepository {
  /** agent id -> how many sessions PostgreSQL says they are holding. */
  readonly active = new Map<string, number>();
  countCalls = 0;

  countActiveWork(tenantId: string, agentId: string): Promise<number> {
    this.countCalls += 1;
    // Tenant-scoped, as the real query is.
    return Promise.resolve(tenantId === TENANT_A ? (this.active.get(agentId) ?? 0) : 0);
  }

  create(): Promise<SessionRow> {
    throw new Error('presence must not create a session');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('presence must not read a session');
  }
  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('presence must not read the media-token projection');
  }

  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('presence must not read the claim projection');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('presence must not read the queue projection');
  }
  update(): Promise<SessionRow | null> {
    throw new Error('presence must not update a session');
  }
  claim(): Promise<SessionClaimOutcome> {
    throw new Error('presence must not claim');
  }
  accept(): Promise<SessionAcceptOutcome> {
    throw new Error('presence must not accept');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('presence must not sweep');
  }
}

const agentActor = (userId: string, tenantId: string): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: 'AGENT',
});

const silentLogger = createLogger({ level: 'silent' });

describe('PresenceService', () => {
  let clockMs: number;
  let presence: FakePresenceRepository;
  let agents: FakeAgentRepository;
  let sessions: FakeSessionRepository;
  let service: PresenceService;

  const advance = (seconds: number): void => {
    clockMs += seconds * 1000;
  };

  beforeEach(() => {
    clockMs = Date.parse('2026-08-31T09:00:00.000Z');
    presence = new FakePresenceRepository(() => clockMs);
    agents = new FakeAgentRepository();
    sessions = new FakeSessionRepository();
    service = new PresenceService(
      presence,
      agents,
      sessions,
      silentLogger,
      () => new Date(clockMs),
    );
  });

  // ------------------------------------------------------- availability

  describe('setAvailability', () => {
    it('creates a presence for AVAILABLE', async () => {
      const result = await service.setAvailability(
        agentActor(AGENT_A, TENANT_A),
        AgentPresence.AVAILABLE,
      );

      expect(result).toEqual({ agent_id: AGENT_A, status: 'AVAILABLE' });
      expect(await presence.read(AGENT_A)).toEqual({
        status: 'AVAILABLE',
        languages: ['en', 'hi'],
        lastSeen: '2026-08-31T09:00:00.000Z',
        tenantId: TENANT_A,
      });
    });

    it('arms the documented TTL', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      expect(await presence.ttl(AGENT_A)).toBe(PRESENCE_TTL_SECONDS);
    });

    it('takes languages from the profile, not from anything a client can reach', async () => {
      // The service has no parameter for languages, so this asserts the
      // consequence: what lands in Redis is what PostgreSQL held, per agent.
      await service.setAvailability(agentActor(AGENT_B, TENANT_A), AgentPresence.AVAILABLE);
      expect((await presence.read(AGENT_B))?.languages).toEqual(['en']);
    });

    it('reflects a profile change on the next availability call', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      expect((await presence.read(AGENT_A))?.languages).toEqual(['en', 'hi']);

      const profile = agents.profiles.find((p) => p.userId === AGENT_A);
      if (profile === undefined) throw new Error('fixture missing');
      agents.profiles[agents.profiles.indexOf(profile)] = { ...profile, languages: ['ta'] };

      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      // PostgreSQL stays authoritative for the profile; the snapshot follows it.
      expect((await presence.read(AGENT_A))?.languages).toEqual(['ta']);
    });

    it('takes the tenant from the actor, so the presence records the real owner', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      expect((await presence.read(AGENT_A))?.tenantId).toBe(TENANT_A);
    });

    it('removes the presence for UNAVAILABLE', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      const result = await service.setAvailability(
        agentActor(AGENT_A, TENANT_A),
        AgentPresence.UNAVAILABLE,
      );

      expect(result).toEqual({ agent_id: AGENT_A, status: 'UNAVAILABLE' });
      // The chosen representation: absent, the same as expired. T17 then has
      // one eligibility rule rather than two.
      expect(await presence.read(AGENT_A)).toBeNull();
      expect(presence.keys.has(presenceKey(AGENT_A))).toBe(false);
    });

    it('is safe to repeat AVAILABLE', async () => {
      const actor = agentActor(AGENT_A, TENANT_A);
      await service.setAvailability(actor, AgentPresence.AVAILABLE);
      advance(3);
      await service.setAvailability(actor, AgentPresence.AVAILABLE);
      await service.setAvailability(actor, AgentPresence.AVAILABLE);

      expect(presence.keys.size).toBe(1);
      expect(await presence.ttl(AGENT_A)).toBe(PRESENCE_TTL_SECONDS);
      expect((await presence.read(AGENT_A))?.status).toBe('AVAILABLE');
    });

    it('is safe to repeat UNAVAILABLE, including when never available', async () => {
      const actor = agentActor(AGENT_A, TENANT_A);
      await service.setAvailability(actor, AgentPresence.UNAVAILABLE);
      await service.setAvailability(actor, AgentPresence.UNAVAILABLE);
      expect(presence.keys.size).toBe(0);
    });

    it('never touches another agent’s presence', async () => {
      await service.setAvailability(agentActor(AGENT_B, TENANT_A), AgentPresence.AVAILABLE);
      const before = await presence.read(AGENT_B);

      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.UNAVAILABLE);

      // A's whole lifecycle left B exactly as it was. There is no parameter
      // through which A could have addressed B, and this is the assertion that
      // would fail if one appeared.
      expect(await presence.read(AGENT_B)).toEqual(before);
    });

    it('refuses a user with no agent profile', async () => {
      // A TENANT_ADMIN holds a valid JWT and passes AgentJwtGuard, but is not
      // someone the queue may route a customer to.
      const admin = { ...agentActor('admin-user', TENANT_A), role: 'TENANT_ADMIN' as const };
      await expect(service.setAvailability(admin, AgentPresence.AVAILABLE)).rejects.toMatchObject({
        status: 403,
      });
      expect(presence.keys.size).toBe(0);
    });

    it('refuses an agent whose token names a tenant they do not belong to', async () => {
      // The profile lookup is scoped by (user_id, tenant_id), so a token
      // carrying tenant B for an agent of tenant A finds nothing (I8).
      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_B), AgentPresence.AVAILABLE),
      ).rejects.toMatchObject({ status: 403 });
      expect(presence.keys.size).toBe(0);
    });
  });

  // ---------------------------------------------------------- heartbeat

  describe('heartbeat', () => {
    it('refreshes last_seen', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      advance(4);

      const result = await service.heartbeat(agentActor(AGENT_A, TENANT_A));

      expect(result).toEqual({
        agent_id: AGENT_A,
        status: 'AVAILABLE',
        last_seen: '2026-08-31T09:00:04.000Z',
      });
      expect((await presence.read(AGENT_A))?.lastSeen).toBe('2026-08-31T09:00:04.000Z');
    });

    it('refreshes the TTL', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      advance(10);
      expect(await presence.ttl(AGENT_A)).toBe(5);

      await service.heartbeat(agentActor(AGENT_A, TENANT_A));
      expect(await presence.ttl(AGENT_A)).toBe(PRESENCE_TTL_SECONDS);
    });

    it('keeps an agent live indefinitely while it beats faster than the TTL', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      for (let i = 0; i < 20; i += 1) {
        advance(5);
        expect(await service.heartbeat(agentActor(AGENT_A, TENANT_A))).toMatchObject({
          status: 'AVAILABLE',
        });
      }
      expect(await presence.read(AGENT_A)).not.toBeNull();
    });

    it('lets the presence expire when the beats stop', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      advance(PRESENCE_TTL_SECONDS + 1);

      expect(await presence.read(AGENT_A)).toBeNull();
      expect(await service.heartbeat(agentActor(AGENT_A, TENANT_A))).toEqual({
        agent_id: AGENT_A,
        status: 'UNAVAILABLE',
        last_seen: null,
      });
    });

    it('does not resurrect an agent who went unavailable', async () => {
      // The single most important property of the heartbeat. A UI whose timer
      // has not torn down yet must not put the agent back in the pool.
      const actor = agentActor(AGENT_A, TENANT_A);
      await service.setAvailability(actor, AgentPresence.AVAILABLE);
      await service.setAvailability(actor, AgentPresence.UNAVAILABLE);

      const result = await service.heartbeat(actor);

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.last_seen).toBeNull();
      expect(presence.keys.size).toBe(0);
    });

    it('does not resurrect an expired presence', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      advance(PRESENCE_TTL_SECONDS + 1);

      await service.heartbeat(agentActor(AGENT_A, TENANT_A));
      await service.heartbeat(agentActor(AGENT_A, TENANT_A));

      expect(presence.keys.size).toBe(0);
      expect(await presence.read(AGENT_A)).toBeNull();
    });

    it('reports BUSY without clearing it', async () => {
      // The second reason `touch` never writes `status`: an agent in a call
      // keeps beating, and each beat must leave BUSY exactly as it found it.
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.markBusy(AGENT_A);
      advance(5);

      const result = await service.heartbeat(agentActor(AGENT_A, TENANT_A));

      expect(result.status).toBe('BUSY');
      expect((await presence.read(AGENT_A))?.status).toBe('BUSY');
    });

    it('leaves the languages snapshot alone', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.heartbeat(agentActor(AGENT_A, TENANT_A));
      expect((await presence.read(AGENT_A))?.languages).toEqual(['en', 'hi']);
    });

    it('never touches another agent’s presence', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.setAvailability(agentActor(AGENT_B, TENANT_A), AgentPresence.AVAILABLE);
      const beforeB = await presence.read(AGENT_B);
      advance(6);

      await service.heartbeat(agentActor(AGENT_A, TENANT_A));

      expect(await presence.read(AGENT_B)).toEqual(beforeB);
      expect(await presence.ttl(AGENT_B)).toBe(PRESENCE_TTL_SECONDS - 6);
    });

    it('reads no PostgreSQL profile at all', async () => {
      // The high-frequency endpoint stays Redis-only. Anything that reached
      // the database here would be a query per agent every few seconds.
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      let reads = 0;
      const counting: AgentRepository = {
        findAgentByEmail: () => Promise.resolve(null),
        findProfile: (userId, tenantId) => {
          reads += 1;
          return agents.findProfile(userId, tenantId);
        },
      };
      const isolated = new PresenceService(
        presence,
        counting,
        sessions,
        silentLogger,
        () => new Date(clockMs),
      );

      await isolated.heartbeat(agentActor(AGENT_A, TENANT_A));

      expect(reads).toBe(0);
    });
  });

  // --------------------------------------------------------------- busy

  // --------------------------------------- availability while holding work

  describe('an agent holding work cannot advertise themselves as free', () => {
    // The regression. R5 makes BUSY internal — "set on claim, cleared on
    // session end" — and that is only true if AVAILABLE cannot overwrite it.
    // Before this guard an agent could accept a session and immediately post
    // {"status":"AVAILABLE"}, and the whole system would see them as free while
    // they held a live call.

    it('refuses AVAILABLE while the agent is IN_CALL', async () => {
      sessions.active.set(AGENT_A, 1);

      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('leaves the presence untouched when it refuses', async () => {
      // The point of the fix: Redis must not read AVAILABLE afterwards.
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.markBusy(AGENT_A);
      sessions.active.set(AGENT_A, 1);

      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toBeDefined();

      expect((await presence.read(AGENT_A))?.status).toBe('BUSY');
    });

    it('refuses AVAILABLE while the agent holds an unaccepted offer', async () => {
      // OFFERED counts as holding work: the session is out of the queue and
      // nobody else can take it.
      sessions.active.set(AGENT_A, 1);

      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('creates no presence at all for an agent who had none', async () => {
      sessions.active.set(AGENT_A, 1);

      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toBeDefined();

      expect(await presence.read(AGENT_A)).toBeNull();
    });

    it('allows AVAILABLE once the session has ended', async () => {
      sessions.active.set(AGENT_A, 1);
      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toBeDefined();

      // The session reached a terminal status, so PostgreSQL no longer counts
      // it. Nothing about Redis changed; the answer did.
      sessions.active.set(AGENT_A, 0);

      const result = await service.setAvailability(
        agentActor(AGENT_A, TENANT_A),
        AgentPresence.AVAILABLE,
      );
      expect(result.status).toBe('AVAILABLE');
      expect((await presence.read(AGENT_A))?.status).toBe('AVAILABLE');
    });

    it('asks PostgreSQL rather than trusting the presence key', async () => {
      // The presence key says AVAILABLE — as it would if a BUSY write had
      // failed (§17.1) — and PostgreSQL says the agent holds work. The
      // database wins (D1).
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      sessions.active.set(AGENT_A, 1);

      await expect(
        service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(sessions.countCalls).toBeGreaterThan(0);
    });

    it('preserves max_concurrent: an agent with spare capacity may go available', async () => {
      // AGENT_B is configured for two. Holding one leaves room for another, and
      // claiming requires a live AVAILABLE presence (§17.1) — so refusing here
      // would cut their effective capacity to one.
      sessions.active.set(AGENT_B, 1);

      const result = await service.setAvailability(
        agentActor(AGENT_B, TENANT_A),
        AgentPresence.AVAILABLE,
      );
      expect(result.status).toBe('AVAILABLE');
    });

    it('refuses once that agent reaches their max_concurrent', async () => {
      sessions.active.set(AGENT_B, 2);

      await expect(
        service.setAvailability(agentActor(AGENT_B, TENANT_A), AgentPresence.AVAILABLE),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('still lets a busy agent go UNAVAILABLE', async () => {
      // Stepping away is always permitted. It releases no session — PostgreSQL
      // still holds the assignment — it only says the agent is not at the desk.
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      sessions.active.set(AGENT_A, 1);

      const result = await service.setAvailability(
        agentActor(AGENT_A, TENANT_A),
        AgentPresence.UNAVAILABLE,
      );
      expect(result.status).toBe('UNAVAILABLE');
      expect(await presence.read(AGENT_A)).toBeNull();
    });

    it('does not consult sessions when going UNAVAILABLE', async () => {
      sessions.countCalls = 0;
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.UNAVAILABLE);
      expect(sessions.countCalls).toBe(0);
    });

    it('counts work per agent, not per tenant', async () => {
      // AGENT_B's session must not make AGENT_A busy.
      sessions.active.set(AGENT_B, 1);

      const result = await service.setAvailability(
        agentActor(AGENT_A, TENANT_A),
        AgentPresence.AVAILABLE,
      );
      expect(result.status).toBe('AVAILABLE');
    });
  });

  describe('the internal BUSY mechanism', () => {
    it('marks an available agent busy', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      expect(await service.markBusy(AGENT_A)).toBe(true);
      expect((await presence.read(AGENT_A))?.status).toBe('BUSY');
    });

    it('restores the agent to AVAILABLE', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.markBusy(AGENT_A);

      expect(await service.markAvailable(AGENT_A)).toBe(true);
      expect((await presence.read(AGENT_A))?.status).toBe('AVAILABLE');
    });

    it('keeps the languages snapshot and the tenant through a busy cycle', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      await service.markBusy(AGENT_A);
      await service.markAvailable(AGENT_A);

      expect(await presence.read(AGENT_A)).toMatchObject({
        languages: ['en', 'hi'],
        tenantId: TENANT_A,
      });
    });

    it('reports false rather than inventing a presence', async () => {
      // An agent with no presence is not live. Creating one here would let a
      // claim mark someone busy who is not even connected.
      expect(await service.markBusy(AGENT_A)).toBe(false);
      expect(await service.markAvailable(AGENT_A)).toBe(false);
      expect(presence.keys.size).toBe(0);
    });

    it('reports false once the presence has expired', async () => {
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.AVAILABLE);
      advance(PRESENCE_TTL_SECONDS + 1);
      expect(await service.markBusy(AGENT_A)).toBe(false);
    });

    it('is reachable only from the service, never from an availability call', async () => {
      // The endpoint takes `AgentPresence`, and BUSY is a member of it — the
      // schema is what stops a client sending it. This asserts the other half:
      // even called directly with BUSY, availability does not write BUSY.
      await service.setAvailability(agentActor(AGENT_A, TENANT_A), AgentPresence.BUSY);
      // BUSY is not AVAILABLE, so it takes the removal branch: the agent ends
      // up not-live rather than busy. No client path produces a BUSY presence.
      expect(await presence.read(AGENT_A)).toBeNull();
    });
  });
});
