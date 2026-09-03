/**
 * Accepting an offer, without a server.
 *
 * The session store reproduces every predicate the real statement applies —
 * tenant, `status = 'OFFERED'`, whose offer it is, and whether it has lapsed —
 * because dropping any one of them is the mutation these tests exist to catch.
 * What it cannot reproduce is the accept losing to a concurrently committing
 * sweeper; that needs two real connections, and
 * `scripts/verify-agent-accept.ts` is where it is proved.
 *
 * `PresenceService` is real, so "accept does not require a presence" and
 * "accept reasserts BUSY" are assertions about production code rather than
 * about a double.
 */

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
  AcceptCommand,
  ClaimableSessionRow,
  AgentWorkRow,
  CallSessionRow,
  EndedCallRow,
  MediaTokenSessionRow,
  ClaimCommand,
  CreateSessionInput,
  ExpiredOfferRow,
  GuardedUpdate,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionRepository,
  SessionRow,
  UnrecordedCallRow,
} from '../sessions/session.repository.js';
import type { AgentCredentialRow, AgentProfileRow, AgentRepository } from './agent.repository.js';
import { AgentAcceptService } from './agent-accept.service.js';
import type { PresenceEntry, PresenceRepository, TouchResult } from './presence.repository.js';
import { PresenceService } from './presence.service.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';

// ------------------------------------------------------------------ fixtures

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const MINE = '00000000-0000-4000-8000-0000000000a1';
const THEIRS = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '00000000-0000-4000-8000-00000000e001';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const silentLogger = () => createLogger({ level: 'silent' });

const actor = (userId = MINE, tenantId = TENANT_A): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

interface Stored {
  id: string;
  tenantId: string;
  status: SessionStatus;
  language: string;
  version: number;
  offeredToAgentId: string | null;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  agentId: string | null;
  connectedAt: Date | null;
}

/** A live offer held by MINE, expiring 20 seconds from now. */
const offered = (over: Partial<Stored> = {}): Stored => ({
  id: SESSION,
  tenantId: TENANT_A,
  status: SessionStatus.OFFERED,
  language: 'en',
  version: 3,
  offeredToAgentId: MINE,
  offeredAt: new Date(NOW - 10_000),
  offerExpiresAt: new Date(NOW + 20_000),
  agentId: null,
  connectedAt: null,
  ...over,
});

// --------------------------------------------------------------------- fakes

class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, Stored>();
  readonly commands: AcceptCommand[] = [];

  seed(row: Stored): void {
    this.rows.set(row.id, row);
  }

  findUnrecordedCalls(): Promise<readonly UnrecordedCallRow[]> {
    throw new Error('accepting a session must not look for unrecorded calls');
  }

  findForCallEvent(): Promise<CallSessionRow | null> {
    throw new Error('accepting a session must not drive call lifecycle');
  }

  appendCallEvent(): Promise<boolean> {
    throw new Error('accepting a session must not drive call lifecycle');
  }

  hasEvent(): Promise<boolean> {
    throw new Error('accepting a session must not drive call lifecycle');
  }

  submitVerdict(): Promise<never> {
    throw new Error('accepting a session must not submit a verdict');
  }

  endCall(): Promise<EndedCallRow | null> {
    throw new Error('accepting a session must not drive call lifecycle');
  }

  findActiveWork(): Promise<readonly AgentWorkRow[]> {
    throw new Error('accepting a session must not ask what the agent holds');
  }

  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('accepting a session must not mint a media token');
  }

  findClaimable(tenantId: string, sessionId: string): Promise<ClaimableSessionRow | null> {
    const row = this.rows.get(sessionId);
    if (row === undefined || row.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      tenantId: row.tenantId,
      status: row.status,
      language: row.language,
      offeredToAgentId: row.offeredToAgentId,
      offeredAt: row.offeredAt,
      offerExpiresAt: row.offerExpiresAt,
    });
  }

  accept(command: AcceptCommand): Promise<SessionAcceptOutcome> {
    this.commands.push(command);
    const row = this.rows.get(command.sessionId);
    if (
      row === undefined ||
      row.tenantId !== command.tenantId ||
      row.status !== SessionStatus.OFFERED ||
      row.offeredToAgentId !== command.agentId ||
      row.offerExpiresAt === null ||
      row.offerExpiresAt.getTime() <= command.now.getTime()
    ) {
      return Promise.resolve({ kind: 'LOST' });
    }

    const accepted: Stored = {
      ...row,
      status: SessionStatus.IN_CALL,
      agentId: command.agentId,
      connectedAt: command.now,
      version: row.version + 1,
    };
    this.rows.set(accepted.id, accepted);
    return Promise.resolve({
      kind: 'ACCEPTED',
      session: {
        id: accepted.id,
        status: accepted.status,
        agentId: command.agentId,
        connectedAt: command.now,
        roomName: `vcip_${accepted.id}`,
        version: accepted.version,
      },
    });
  }

  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('an accept must not create a session');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('an accept must use the narrow claim projection');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('an accept must not use the customer guarded update');
  }

  abortSession(): Promise<SessionRow | null> {
    throw new Error('an accept must not abort a session');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('an accept must not read the queue projection');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('an accept must not claim');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('an accept must not sweep');
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

class FakeAgents implements AgentRepository {
  findAgentByEmail(): Promise<AgentCredentialRow | null> {
    throw new Error('an accept must not authenticate');
  }
  findProfile(): Promise<AgentProfileRow | null> {
    // Reachable only if the accept starts asking questions it should not:
    // holding the offer is the authorization.
    throw new Error('an accept must not re-check the agent profile');
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
    throw new Error('an accept must not heartbeat');
  }
  remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
    return Promise.resolve();
  }
  ttl(): Promise<number> {
    return Promise.resolve(15);
  }
}

// --------------------------------------------------------------------- suite

describe('AgentAcceptService', () => {
  let sessions: FakeSessions;
  let presence: FakePresence;
  let service: AgentAcceptService;

  const busy = (agentId = MINE): void => {
    presence.entries.set(agentId, { status: AgentPresence.BUSY, tenantId: TENANT_A });
  };

  beforeEach(() => {
    sessions = new FakeSessions();
    presence = new FakePresence();
    service = new AgentAcceptService(
      sessions,
      new PresenceService(
        presence,
        new FakeAgents(),
        sessions,
        silentLogger(),
        () => new Date(NOW),
      ),
      new TenantScope(),
      new RecordingNotifications(),
      silentLogger(),
      () => new Date(NOW),
    );
  });

  describe('a successful accept', () => {
    beforeEach(() => {
      sessions.seed(offered());
      busy();
    });

    it('moves the session to IN_CALL', async () => {
      const result = await service.accept(actor(), SESSION);

      expect(result.status).toBe(SessionStatus.IN_CALL);
      expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.IN_CALL);
    });

    it('assigns agent_id to the accepting agent', async () => {
      const result = await service.accept(actor(), SESSION);

      expect(result.agent_id).toBe(MINE);
      expect(sessions.rows.get(SESSION)?.agentId).toBe(MINE);
    });

    it('sets connected_at to the accept instant', async () => {
      await service.accept(actor(), SESSION);

      expect(sessions.rows.get(SESSION)?.connectedAt?.toISOString()).toBe(
        '2026-09-01T10:00:00.000Z',
      );
    });

    it('returns the room name the session has held since creation', async () => {
      const result = await service.accept(actor(), SESSION);

      expect(result.room_name).toBe(`vcip_${SESSION}`);
    });

    it('returns exactly the four contract fields', async () => {
      const result = await service.accept(actor(), SESSION);

      expect(Object.keys(result).sort()).toEqual(['agent_id', 'room_name', 'session_id', 'status']);
    });

    it('appends AGENT_ACCEPTED, not CALL_STARTED', async () => {
      await service.accept(actor(), SESSION);

      const event = sessions.commands[0]?.event;
      expect(event?.type).toBe(SessionEventType.AGENT_ACCEPTED);
      expect(event?.actorType).toBe('AGENT');
      expect(event?.actorId).toBe(MINE);
      expect(event?.payload).toMatchObject({
        from: SessionStatus.OFFERED,
        to: SessionStatus.IN_CALL,
      });
    });

    it('measures the expiry against the same instant it records', async () => {
      await service.accept(actor(), SESSION);

      const command = sessions.commands[0];
      expect(command?.now.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    });

    it('keeps the agent BUSY', async () => {
      await service.accept(actor(), SESSION);

      expect(presence.entries.get(MINE)?.status).toBe(AgentPresence.BUSY);
      expect(presence.setStatusCalls).toBe(1);
    });
  });

  describe('holding the offer is the authorization', () => {
    it('does not require a live presence', async () => {
      // The agent's heartbeat lapsed between claim and accept. PostgreSQL still
      // says the offer is theirs, and dropping a waiting customer over a late
      // heartbeat would be the worse answer.
      sessions.seed(offered());

      await expect(service.accept(actor(), SESSION)).resolves.toMatchObject({
        status: SessionStatus.IN_CALL,
      });
    });

    it('does not require the agent to be AVAILABLE', async () => {
      sessions.seed(offered());
      presence.entries.set(MINE, { status: AgentPresence.UNAVAILABLE, tenantId: TENANT_A });

      await expect(service.accept(actor(), SESSION)).resolves.toMatchObject({
        status: SessionStatus.IN_CALL,
      });
    });

    it('never reads the agent profile', async () => {
      // `FakeAgents.findProfile` throws. Language and max_concurrent were
      // settled at claim time.
      sessions.seed(offered());

      await expect(service.accept(actor(), SESSION)).resolves.toBeDefined();
    });
  });

  describe('refusals', () => {
    it('is a 404 for a session that does not exist', async () => {
      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({ status: 404 });
    });

    it('is the same 404 for another tenant session', async () => {
      sessions.seed(offered({ tenantId: TENANT_B }));

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({ status: 404 });
      expect(sessions.commands).toHaveLength(0);
    });

    it('refuses an offer held by another agent', async () => {
      sessions.seed(offered({ offeredToAgentId: THEIRS }));

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_ALREADY_ASSIGNED,
      });
      expect(sessions.commands).toHaveLength(0);
    });

    it('refuses a session that is still queued', async () => {
      sessions.seed(offered({ status: SessionStatus.QUEUED, offeredToAgentId: null }));

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_INVALID_STATE,
      });
    });

    it('refuses an offer that has already lapsed', async () => {
      sessions.seed(offered({ offerExpiresAt: new Date(NOW - 1) }));

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_INVALID_STATE,
      });
      expect(sessions.commands).toHaveLength(0);
      expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.OFFERED);
    });

    it('refuses an offer expiring on this exact millisecond', async () => {
      // The boundary belongs to the sweeper: accept is `>`, the sweep is `<=`,
      // so exactly one of them can match a given instant.
      sessions.seed(offered({ offerExpiresAt: new Date(NOW) }));

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_INVALID_STATE,
      });
    });

    it('accepts an offer with one millisecond left', async () => {
      sessions.seed(offered({ offerExpiresAt: new Date(NOW + 1) }));

      await expect(service.accept(actor(), SESSION)).resolves.toMatchObject({
        status: SessionStatus.IN_CALL,
      });
    });

    it('reports a lost race when the sweeper commits mid-flight', async () => {
      sessions.seed(offered());
      const original = sessions.accept.bind(sessions);
      sessions.accept = (command) => {
        // The sweeper got there between the read and the write.
        sessions.rows.set(
          SESSION,
          offered({ status: SessionStatus.QUEUED, offeredToAgentId: null }),
        );
        return original(command);
      };

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_INVALID_STATE,
      });
    });
  });

  describe('retrying an accept', () => {
    it('returns the session this agent is already in', async () => {
      sessions.seed(
        offered({
          status: SessionStatus.IN_CALL,
          agentId: MINE,
          connectedAt: new Date(NOW - 5_000),
        }),
      );

      const result = await service.accept(actor(), SESSION);

      expect(result.status).toBe(SessionStatus.IN_CALL);
      expect(result.agent_id).toBe(MINE);
      expect(result.room_name).toBe(`vcip_${SESSION}`);
    });

    it('does not transition again', async () => {
      sessions.seed(
        offered({
          status: SessionStatus.IN_CALL,
          agentId: MINE,
          connectedAt: new Date(NOW - 5_000),
        }),
      );

      await service.accept(actor(), SESSION);

      expect(sessions.commands).toHaveLength(0);
      expect(sessions.rows.get(SESSION)?.version).toBe(3);
    });

    it('does not move connected_at forward', async () => {
      const connectedAt = new Date(NOW - 5_000);
      sessions.seed(offered({ status: SessionStatus.IN_CALL, agentId: MINE, connectedAt }));

      await service.accept(actor(), SESSION);

      expect(sessions.rows.get(SESSION)?.connectedAt).toBe(connectedAt);
    });

    it('refuses when another agent is on the call', async () => {
      sessions.seed(
        offered({ status: SessionStatus.IN_CALL, agentId: THEIRS, offeredToAgentId: THEIRS }),
      );

      await expect(service.accept(actor(), SESSION)).rejects.toMatchObject({
        code: ErrorCode.SESSION_ALREADY_ASSIGNED,
      });
    });
  });

  describe('when the BUSY write fails', () => {
    it('still accepts when Redis is unreachable', async () => {
      sessions.seed(offered());
      presence.failSetStatus = true;

      const result = await service.accept(actor(), SESSION);

      expect(result.status).toBe(SessionStatus.IN_CALL);
      expect(sessions.rows.get(SESSION)?.status).toBe(SessionStatus.IN_CALL);
    });

    it('attempts the write exactly once', async () => {
      sessions.seed(offered());
      presence.failSetStatus = true;

      await service.accept(actor(), SESSION).catch(() => undefined);

      expect(presence.setStatusCalls).toBe(1);
    });

    it('does not fail when the agent had no presence to mark', async () => {
      sessions.seed(offered());

      await expect(service.accept(actor(), SESSION)).resolves.toBeDefined();
    });
  });

  it('throws a domain error rather than leaking an internal one', async () => {
    sessions.seed(offered({ offeredToAgentId: THEIRS }));

    await expect(service.accept(actor(), SESSION)).rejects.toBeInstanceOf(DomainError);
  });
});
