/**
 * The claim's behaviour, without a server.
 *
 * Two things about the fakes are deliberate.
 *
 * The presence side is **not** faked: a real `PresenceService` runs against a
 * real-enough presence store, so `liveStatus` and `markBusy` are the production
 * code paths and a claim that forgot to set `BUSY` fails here rather than in a
 * verification script.
 *
 * The session store **is** faked, and it reproduces the guards rather than
 * assuming them — tenant, `status = 'QUEUED'`, and the capacity count are all
 * applied. What it cannot reproduce is the row lock that makes the capacity
 * check safe under concurrency; that property is only observable against a real
 * PostgreSQL, and `scripts/verify-agent-claim.ts` is where it is proved.
 */

import { ForbiddenException } from '@nestjs/common';
import {
  AgentPresence,
  DomainError,
  ErrorCode,
  SessionEventType,
  SessionStatus,
} from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActor } from '../common/auth/auth-context.js';
import { ActorRole } from '../common/auth/auth-context.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { createLogger } from '../common/logging/logger.js';
import type {
  ClaimableSessionRow,
  MediaTokenSessionRow,
  ClaimCommand,
  ExpiredOfferRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  CreateSessionInput,
  GuardedUpdate,
  QueuedSessionRow,
  SessionRepository,
  SessionRow,
} from '../sessions/session.repository.js';
import type { TenantConfig, TenantConfigStore } from '../tenants/tenant-config.store.js';
import { TenantsService } from '../tenants/tenants.service.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { AgentClaimService } from './agent-claim.service.js';
import type { PresenceEntry, PresenceRepository, TouchResult } from './presence.repository.js';
import { PresenceService } from './presence.service.js';

// ------------------------------------------------------------------ fixtures

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_EN_HI = '00000000-0000-4000-8000-0000000000a1';
const AGENT_MULTI = '00000000-0000-4000-8000-0000000000a2';
const ADMIN = '00000000-0000-4000-8000-0000000000ad';
const SESSION = '00000000-0000-4000-8000-00000000e001';

const NOW = Date.parse('2026-08-31T10:00:00.000Z');
const silentLogger = () => createLogger({ level: 'silent' });

const actor = (userId = AGENT_EN_HI, tenantId = TENANT_A): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

interface StoredSession {
  id: string;
  tenantId: string;
  status: SessionStatus;
  language: string;
  version: number;
  offeredToAgentId: string | null;
  offeredAt?: Date | null;
  offerExpiresAt?: Date | null;
  agentId: string | null;
}

const stored = (over: Partial<StoredSession> = {}): StoredSession => ({
  id: SESSION,
  tenantId: TENANT_A,
  status: SessionStatus.QUEUED,
  language: 'en',
  version: 3,
  offeredToAgentId: null,
  agentId: null,
  ...over,
});

// --------------------------------------------------------------------- fakes

class FakeSessionRepository implements SessionRepository {
  readonly rows = new Map<string, StoredSession>();
  readonly commands: ClaimCommand[] = [];

  seed(row: StoredSession): void {
    this.rows.set(row.id, row);
  }

  findById(sessionId: string): Promise<SessionRow | null> {
    const row = this.rows.get(sessionId);
    if (row === undefined) return Promise.resolve(null);
    // Only the fields the claim path reads are meaningful; the rest satisfy
    // the port's shape.
    return Promise.resolve({
      id: row.id,
      tenantId: row.tenantId,
      externalRef: 'ref',
      status: row.status,
      version: row.version,
      language: row.language,
      roomName: null,
      checklistTemplateId: null,
      consentOk: true,
      consentVersion: 'v1',
      consentAt: new Date(NOW),
      preflightOk: true,
      preflightAt: new Date(NOW),
      geoOk: true,
      gpsAccuracyM: 20,
      geoCheckedAt: new Date(NOW),
      ipCountry: 'IN',
      queuedAt: new Date(NOW - 60_000),
      connectedAt: null,
      endedAt: null,
      verdict: null,
      exportStatus: 'NOT_STARTED',
      createdAt: new Date(NOW - 120_000),
      updatedAt: new Date(NOW - 60_000),
    });
  }

  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('claiming a session must not mint a media token');
  }

  findClaimable(tenantId: string, sessionId: string): Promise<ClaimableSessionRow | null> {
    const row = this.rows.get(sessionId);
    // Tenant is a predicate in the real statement, so a foreign id is absent
    // rather than present-and-rejected.
    if (row === undefined || row.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      tenantId: row.tenantId,
      status: row.status,
      language: row.language,
      offeredToAgentId: row.offeredToAgentId,
      offeredAt: row.offeredAt ?? null,
      offerExpiresAt: row.offerExpiresAt ?? null,
    });
  }

  claim(command: ClaimCommand): Promise<SessionClaimOutcome> {
    this.commands.push(command);

    const active = [...this.rows.values()].filter(
      (row) =>
        row.tenantId === command.tenantId &&
        ((row.status === SessionStatus.OFFERED && row.offeredToAgentId === command.agentId) ||
          (row.status === SessionStatus.IN_CALL && row.agentId === command.agentId)),
    ).length;
    if (active >= command.maxConcurrent) return Promise.resolve({ kind: 'AT_CAPACITY', active });

    const row = this.rows.get(command.sessionId);
    if (
      row === undefined ||
      row.tenantId !== command.tenantId ||
      row.status !== SessionStatus.QUEUED
    ) {
      return Promise.resolve({ kind: 'LOST' });
    }

    const claimed: StoredSession = {
      ...row,
      status: SessionStatus.OFFERED,
      offeredToAgentId: command.agentId,
      offerExpiresAt: command.offerExpiresAt,
      version: row.version + 1,
    };
    this.rows.set(claimed.id, claimed);
    return Promise.resolve({
      kind: 'CLAIMED',
      session: {
        id: claimed.id,
        status: claimed.status,
        offeredToAgentId: command.agentId,
        offeredAt: command.offeredAt,
        offerExpiresAt: command.offerExpiresAt,
        version: claimed.version,
      },
    });
  }

  create(_input: CreateSessionInput): Promise<SessionRow> {
    throw new Error('a claim must not create a session');
  }

  update(_command: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('a claim must not use the customer guarded update');
  }

  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('a claim must not read the queue projection');
  }

  accept(): Promise<SessionAcceptOutcome> {
    throw new Error('a claim must not accept');
  }

  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('a claim must not sweep offers');
  }

  countActiveWork(tenantId: string, agentId: string): Promise<number> {
    // The same predicate the real statement uses: an offer held, or a call in
    // progress, each paired with its status.
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          ((row.status === SessionStatus.OFFERED && row.offeredToAgentId === agentId) ||
            (row.status === SessionStatus.IN_CALL && row.agentId === agentId)),
      ).length,
    );
  }
}

const PROFILES: readonly AgentProfileRow[] = Object.freeze([
  { userId: AGENT_EN_HI, tenantId: TENANT_A, languages: ['en', 'hi'], maxConcurrent: 1 },
  { userId: AGENT_MULTI, tenantId: TENANT_A, languages: ['en'], maxConcurrent: 3 },
]);

class FakeAgentRepository implements AgentRepository {
  findAgentByEmail(): Promise<AgentCredentialRow | null> {
    throw new Error('a claim must not authenticate');
  }

  findProfile(userId: string, tenantId: string): Promise<AgentProfileRow | null> {
    return Promise.resolve(
      PROFILES.find((p) => p.userId === userId && p.tenantId === tenantId) ?? null,
    );
  }
}

/** A presence store with a TTL, and an optional fault for the BUSY write. */
class FakePresenceRepository implements PresenceRepository {
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

  touch(_agentId: string, _lastSeen: Date): Promise<TouchResult | null> {
    throw new Error('a claim must not heartbeat');
  }

  remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
    return Promise.resolve();
  }

  ttl(): Promise<number> {
    return Promise.resolve(15);
  }
}

class FakeTenantConfigStore implements TenantConfigStore {
  offerTimeoutSeconds = 30;
  missing = false;

  findConfig(tenantId: string): Promise<TenantConfig | null> {
    if (this.missing) return Promise.resolve(null);
    return Promise.resolve({
      tenantId,
      status: 'ACTIVE',
      minVideoPx: 480,
      minMicLevel: 10,
      maxRttMs: 300,
      minDownlinkKbps: 500,
      minLightingScore: 30,
      minStabilityScore: 30,
      gpsMaxAccuracyM: 100,
      offerTimeoutSeconds: this.offerTimeoutSeconds,
    });
  }

  findActiveChecklistTemplateId(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

// --------------------------------------------------------------------- suite

describe('AgentClaimService', () => {
  let sessions: FakeSessionRepository;
  let presenceStore: FakePresenceRepository;
  let tenantStore: FakeTenantConfigStore;
  let service: AgentClaimService;

  const available = (agentId = AGENT_EN_HI, tenantId = TENANT_A): void => {
    presenceStore.entries.set(agentId, { status: AgentPresence.AVAILABLE, tenantId });
  };

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    presenceStore = new FakePresenceRepository();
    tenantStore = new FakeTenantConfigStore();
    service = new AgentClaimService(
      sessions,
      new FakeAgentRepository(),
      new PresenceService(
        presenceStore,
        new FakeAgentRepository(),
        sessions,
        silentLogger(),
        () => new Date(NOW),
      ),
      new TenantsService(tenantStore),
      new TenantScope(),
      silentLogger(),
      () => new Date(NOW),
    );
  });

  // --- the happy path ------------------------------------------------------

  describe('a successful claim', () => {
    beforeEach(() => {
      sessions.seed(stored());
      available();
    });

    it('moves the session to OFFERED', async () => {
      const result = await service.claim(actor(), SESSION);

      expect(result.status).toBe(SessionStatus.OFFERED);
      expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.OFFERED);
    });

    it('offers it to the authenticated agent', async () => {
      const result = await service.claim(actor(), SESSION);

      expect(result.offered_to_agent_id).toBe(AGENT_EN_HI);
      expect(result.session_id).toBe(SESSION);
    });

    it('derives the expiry from the tenant timeout', async () => {
      tenantStore.offerTimeoutSeconds = 45;

      const result = await service.claim(actor(), SESSION);

      expect(result.offer_expires_at).toBe('2026-08-31T10:00:45.000Z');
    });

    it('returns exactly the four contract fields', async () => {
      const result = await service.claim(actor(), SESSION);

      expect(Object.keys(result).sort()).toEqual([
        'offer_expires_at',
        'offered_to_agent_id',
        'session_id',
        'status',
      ]);
    });

    it('takes the agent, the tenant, and the capacity from the server side', async () => {
      await service.claim(actor(), SESSION);

      const command = sessions.commands[0];
      expect(command?.agentId).toBe(AGENT_EN_HI);
      expect(command?.tenantId).toBe(TENANT_A);
      // From `agent_profiles`, not from anything the caller said.
      expect(command?.maxConcurrent).toBe(1);
      expect(command?.offeredAt.toISOString()).toBe('2026-08-31T10:00:00.000Z');
    });

    it('appends the canonical assignment event, not a new name', async () => {
      await service.claim(actor(), SESSION);

      const event = sessions.commands[0]?.event;
      expect(event?.type).toBe(SessionEventType.SESSION_ASSIGNED);
      expect(event?.actorType).toBe('AGENT');
      expect(event?.actorId).toBe(AGENT_EN_HI);
      expect(event?.payload).toMatchObject({
        from: SessionStatus.QUEUED,
        to: SessionStatus.OFFERED,
      });
    });

    it('marks the agent BUSY after PostgreSQL committed', async () => {
      await service.claim(actor(), SESSION);

      expect(presenceStore.entries.get(AGENT_EN_HI)?.status).toBe(AgentPresence.BUSY);
    });
  });

  // --- eligibility ---------------------------------------------------------

  describe('eligibility', () => {
    it('refuses a user with no agent profile', async () => {
      sessions.seed(stored());
      available(ADMIN);

      await expect(service.claim(actor(ADMIN), SESSION)).rejects.toBeInstanceOf(ForbiddenException);
      expect(sessions.commands).toHaveLength(0);
    });

    it('refuses a language the agent is not configured for', async () => {
      sessions.seed(stored({ language: 'ta' }));
      available();

      await expect(service.claim(actor(), SESSION)).rejects.toBeInstanceOf(ForbiddenException);
      expect(sessions.commands).toHaveLength(0);
    });

    it('matches language case-insensitively, as the queue view does', async () => {
      sessions.seed(stored({ language: 'EN' }));
      available();

      await expect(service.claim(actor(), SESSION)).resolves.toMatchObject({
        status: SessionStatus.OFFERED,
      });
    });

    it('treats a regional variant as a different language (R13)', async () => {
      sessions.seed(stored({ language: 'en-IN' }));
      available();

      await expect(service.claim(actor(), SESSION)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an agent with no live presence', async () => {
      sessions.seed(stored());

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(sessions.commands).toHaveLength(0);
    });

    it('refuses an agent who is UNAVAILABLE', async () => {
      sessions.seed(stored());
      presenceStore.entries.set(AGENT_EN_HI, {
        status: AgentPresence.UNAVAILABLE,
        tenantId: TENANT_A,
      });

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('refuses an agent who is already BUSY', async () => {
      sessions.seed(stored());
      presenceStore.entries.set(AGENT_EN_HI, {
        status: AgentPresence.BUSY,
        tenantId: TENANT_A,
      });

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('ignores a presence recorded under another tenant', async () => {
      sessions.seed(stored());
      presenceStore.entries.set(AGENT_EN_HI, {
        status: AgentPresence.AVAILABLE,
        tenantId: TENANT_B,
      });

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });
  });

  // --- the session ---------------------------------------------------------

  describe('the session', () => {
    // Wrapped, not passed directly: vitest hands the hook a context object,
    // which would arrive as the agent id.
    beforeEach(() => available());

    it('is a 404 when it does not exist', async () => {
      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('is a 404 when it belongs to another tenant', async () => {
      sessions.seed(stored({ tenantId: TENANT_B }));

      // Identical to "does not exist": a claim must not be an oracle for
      // another tenant's session ids (I8).
      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        status: 404,
      });
      expect(sessions.commands).toHaveLength(0);
    });

    it('returns the offer this agent already holds, rather than a 409', async () => {
      // The ordinary way to arrive here: the first claim succeeded and its
      // response was lost, so the agent retries with a fresh key.
      sessions.seed(
        stored({
          status: SessionStatus.OFFERED,
          offeredToAgentId: AGENT_EN_HI,
          offeredAt: new Date(NOW - 5_000),
        }),
      );

      const result = await service.claim(actor(), SESSION);

      expect(result.status).toBe(SessionStatus.OFFERED);
      expect(result.offered_to_agent_id).toBe(AGENT_EN_HI);
      expect(result.session_id).toBe(SESSION);
    });

    it('reports the original offer window, not a fresh one', async () => {
      sessions.seed(
        stored({
          status: SessionStatus.OFFERED,
          offeredToAgentId: AGENT_EN_HI,
          offeredAt: new Date(NOW - 5_000),
        }),
      );

      const result = await service.claim(actor(), SESSION);

      // offered_at + 30s, from five seconds ago — not now + 30s. Re-basing the
      // window on a retry would let an agent hold a session indefinitely.
      expect(result.offer_expires_at).toBe('2026-08-31T10:00:25.000Z');
    });

    it('does not re-claim the session it already holds', async () => {
      sessions.seed(
        stored({
          status: SessionStatus.OFFERED,
          offeredToAgentId: AGENT_EN_HI,
          offeredAt: new Date(NOW),
        }),
      );

      await service.claim(actor(), SESSION);

      // No conditional UPDATE, so no second SESSION_ASSIGNED event and no
      // version bump for something that did not change.
      expect(sessions.commands).toHaveLength(0);
    });

    it('repairs a BUSY presence whose first write failed', async () => {
      sessions.seed(
        stored({
          status: SessionStatus.OFFERED,
          offeredToAgentId: AGENT_EN_HI,
          offeredAt: new Date(NOW),
        }),
      );
      available();

      await service.claim(actor(), SESSION);

      expect(presenceStore.entries.get(AGENT_EN_HI)?.status).toBe(AgentPresence.BUSY);
    });

    it('answers even when the agent has since gone unavailable', async () => {
      // Reporting an offer that already exists decides nothing, so presence is
      // not consulted — an agent who stepped away must still be able to find
      // the session they are holding.
      sessions.seed(
        stored({
          status: SessionStatus.OFFERED,
          offeredToAgentId: AGENT_EN_HI,
          offeredAt: new Date(NOW),
        }),
      );
      presenceStore.entries.delete(AGENT_EN_HI);

      await expect(service.claim(actor(), SESSION)).resolves.toMatchObject({
        status: SessionStatus.OFFERED,
      });
    });

    it('still refuses an offer held by someone else in the same tenant', async () => {
      sessions.seed(
        stored({
          status: SessionStatus.OFFERED,
          offeredToAgentId: AGENT_MULTI,
          offeredAt: new Date(NOW),
        }),
      );

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_ALREADY_ASSIGNED,
      });
    });

    it('is already assigned when another agent holds the offer', async () => {
      sessions.seed(stored({ status: SessionStatus.OFFERED, offeredToAgentId: AGENT_MULTI }));

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_ALREADY_ASSIGNED,
      });
    });

    it('is already assigned when a call is in progress', async () => {
      sessions.seed(stored({ status: SessionStatus.IN_CALL, agentId: AGENT_MULTI }));

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_ALREADY_ASSIGNED,
      });
    });

    it('cannot be claimed before it has queued', async () => {
      sessions.seed(stored({ status: SessionStatus.CREATED }));

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_INVALID_STATE,
      });
    });

    it('cannot be claimed once the customer has dropped', async () => {
      sessions.seed(stored({ status: SessionStatus.DROPPED_QUEUED }));

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_INVALID_STATE,
      });
    });

    it('is lost when the row moves between the read and the write', async () => {
      sessions.seed(stored());
      // The pre-check passes, then the store reports what a conditional UPDATE
      // reports when someone else won: zero rows.
      const original = sessions.claim.bind(sessions);
      sessions.claim = (command) => {
        sessions.rows.set(SESSION, stored({ status: SessionStatus.OFFERED }));
        return original(command);
      };

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_ALREADY_ASSIGNED,
      });
    });

    it('does not mark the agent BUSY when the claim was lost', async () => {
      sessions.seed(stored({ status: SessionStatus.OFFERED, offeredToAgentId: AGENT_MULTI }));

      await expect(service.claim(actor(), SESSION)).rejects.toBeInstanceOf(DomainError);
      expect(presenceStore.setStatusCalls).toBe(0);
      expect(presenceStore.entries.get(AGENT_EN_HI)?.status).toBe(AgentPresence.AVAILABLE);
    });
  });

  // --- max_concurrent ------------------------------------------------------

  describe('max_concurrent', () => {
    const OTHER = '00000000-0000-4000-8000-00000000e002';

    it('refuses a second claim when the profile allows one', async () => {
      sessions.seed(
        stored({ id: OTHER, status: SessionStatus.OFFERED, offeredToAgentId: AGENT_EN_HI }),
      );
      sessions.seed(stored());
      available();

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.QUEUED);
    });

    it('counts a call in progress, not only an unaccepted offer', async () => {
      sessions.seed(stored({ id: OTHER, status: SessionStatus.IN_CALL, agentId: AGENT_EN_HI }));
      sessions.seed(stored());
      available();

      await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('does not count another agent work against this agent', async () => {
      sessions.seed(stored({ id: OTHER, status: SessionStatus.IN_CALL, agentId: AGENT_MULTI }));
      sessions.seed(stored());
      available();

      await expect(service.claim(actor(), SESSION)).resolves.toMatchObject({
        status: SessionStatus.OFFERED,
      });
    });

    it('allows a second claim when the profile allows three', async () => {
      sessions.seed(
        stored({ id: OTHER, status: SessionStatus.OFFERED, offeredToAgentId: AGENT_MULTI }),
      );
      sessions.seed(stored());
      available(AGENT_MULTI);

      await expect(service.claim(actor(AGENT_MULTI), SESSION)).resolves.toMatchObject({
        status: SessionStatus.OFFERED,
      });
    });
  });

  // --- the Redis write is not the claim ------------------------------------

  describe('when the BUSY write fails', () => {
    beforeEach(() => {
      sessions.seed(stored());
      available();
    });

    it('still returns the offer when Redis is unreachable', async () => {
      presenceStore.failSetStatus = true;

      const result = await service.claim(actor(), SESSION);

      // PostgreSQL committed. The claim is real whatever Redis did (D1).
      expect(result.status).toBe(SessionStatus.OFFERED);
      expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.OFFERED);
    });

    it('still returns the offer when the presence key had already expired', async () => {
      presenceStore.entries.delete(AGENT_EN_HI);
      // Live at the eligibility check, gone by the time BUSY is written.
      const original = sessions.claim.bind(sessions);
      sessions.claim = (command) => {
        presenceStore.entries.delete(AGENT_EN_HI);
        return original(command);
      };
      available();

      const result = await service.claim(actor(), SESSION);

      expect(result.offered_to_agent_id).toBe(AGENT_EN_HI);
      expect(presenceStore.entries.has(AGENT_EN_HI)).toBe(false);
    });

    it('attempted the write exactly once', async () => {
      presenceStore.failSetStatus = true;

      await service.claim(actor(), SESSION);

      // No retry loop: a claim is not the place to wait on Redis.
      expect(presenceStore.setStatusCalls).toBe(1);
    });
  });

  // --- tenant configuration ------------------------------------------------

  it('fails with a server error when the tenant configuration is missing', async () => {
    sessions.seed(stored());
    available();
    tenantStore.missing = true;

    await expect(service.claim(actor(), SESSION)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    // Nothing was claimed on the way to that failure.
    expect(sessions.commands).toHaveLength(0);
    expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.QUEUED);
  });
});
