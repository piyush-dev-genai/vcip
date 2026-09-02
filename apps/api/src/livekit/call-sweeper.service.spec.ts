/**
 * The only thing in T26 that ends a session.
 *
 * The session store reproduces the guard the real statement applies — the
 * UPDATE matches only while the session is `IN_CALL` — because dropping it is
 * precisely the mutation these tests exist to catch: a sweeper that overwrote a
 * terminal status would bill a session that already had a verdict.
 */

import { AgentPresence, SessionEventType, SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActorRole } from '../common/auth/auth-context.js';
import { createLogger } from '../common/logging/logger.js';
import type {
  AgentProfileRow,
  AgentRepository,
  AgentCredentialRow,
} from '../agents/agent.repository.js';
import type {
  PresenceEntry,
  PresenceRecord,
  PresenceRepository,
  TouchResult,
} from '../agents/presence.repository.js';
import { PresenceService } from '../agents/presence.service.js';
import type {
  AcceptCommand,
  AgentWorkRow,
  CallSessionRow,
  ClaimCommand,
  ClaimableSessionRow,
  CreateSessionInput,
  EndCallCommand,
  EndedCallRow,
  ExpiredOfferRow,
  GuardedUpdate,
  MediaTokenSessionRow,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionEventInput,
  SessionRepository,
  SessionRow,
  UnrecordedCallRow,
} from '../sessions/session.repository.js';
import { CallSweeper } from './call-sweeper.service.js';
import type { CallRepository, DueDeadline } from './call.repository.js';
import { CallDeadline, deadlineMember } from './call.keys.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-01T12:00:00.000Z');

class FakeCalls implements CallRepository {
  readonly deadlines = new Map<string, number>();

  markSeen(): Promise<boolean> {
    return Promise.resolve(true);
  }
  addParticipant(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  removeParticipant(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  clearParticipants(): Promise<void> {
    return Promise.resolve();
  }
  armDeadline(sessionId: string, role: string, dueAtMs: number): Promise<void> {
    this.deadlines.set(deadlineMember(sessionId, role as 'customer' | 'agent'), dueAtMs);
    return Promise.resolve();
  }
  disarmDeadline(sessionId: string, role: string): Promise<boolean> {
    return Promise.resolve(
      this.deadlines.delete(deadlineMember(sessionId, role as 'customer' | 'agent')),
    );
  }
  disarmAll(sessionId: string): Promise<void> {
    for (const role of ['customer', 'agent'] as const) {
      this.deadlines.delete(deadlineMember(sessionId, role));
    }
    return Promise.resolve();
  }
  dueDeadlines(nowMs: number, limit: number): Promise<readonly DueDeadline[]> {
    return Promise.resolve(
      [...this.deadlines.entries()]
        .filter(([, due]) => due <= nowMs)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member, dueAtMs]) => ({ member, dueAtMs })),
    );
  }
}

class FakeSessions implements SessionRepository {
  status: SessionStatus = SessionStatus.IN_CALL;
  readonly ended: EndCallCommand[] = [];

  findUnrecordedCalls(): Promise<readonly UnrecordedCallRow[]> {
    throw new Error('the call sweeper must not look for unrecorded calls');
  }

  findForCallEvent(sessionId: string): Promise<CallSessionRow | null> {
    return Promise.resolve({
      id: sessionId,
      tenantId: TENANT,
      status: this.status,
      roomName: `vcip_${sessionId}`,
      agentId: AGENT,
      queuedAt: null,
      connectedAt: null,
      callStartedAt: NOW,
    });
  }

  submitVerdict(): Promise<never> {
    throw new Error('the sweeper ends calls; it never submits a verdict');
  }

  endCall(command: EndCallCommand): Promise<EndedCallRow | null> {
    // The real statement is guarded on IN_CALL; so is this.
    if (this.status !== SessionStatus.IN_CALL) return Promise.resolve(null);
    this.ended.push(command);
    this.status = command.status;
    return Promise.resolve({
      id: command.sessionId,
      status: command.status,
      endedAt: command.now,
      talkMs: 5000,
      agentId: AGENT,
    });
  }

  appendCallEvent(_s: string, _e: SessionEventInput): Promise<boolean> {
    throw new Error('the sweeper appends its event inside endCall');
  }
  /**
   * Whether `CALL_STARTED` was ever appended.
   *
   * Asked only on the call-start deadline, and asked of PostgreSQL rather than
   * of the participant set because "did this call ever begin" is durable
   * history (D1). The two departure deadlines read their outcome off the
   * member and never ask.
   */
  callStarted = false;
  hasEventCalls = 0;

  hasEvent(_sessionId: string, eventType: SessionEventType): Promise<boolean> {
    this.hasEventCalls += 1;
    if (eventType !== SessionEventType.CALL_STARTED) {
      throw new Error('the sweeper only ever asks whether the call started');
    }
    return Promise.resolve(this.callStarted);
  }
  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('the sweeper must not create');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('the sweeper must not use the customer update path');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('the sweeper must not claim');
  }
  accept(_c: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('the sweeper must not accept');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('offers are the other sweeper');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('the sweeper reads its own projection');
  }
  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('no');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('no');
  }
  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('no');
  }
  findActiveWork(): Promise<readonly AgentWorkRow[]> {
    throw new Error('no');
  }
  countActiveWork(): Promise<number> {
    throw new Error('no');
  }
}

class FakePresence implements PresenceRepository {
  readonly entries = new Map<string, PresenceRecord>();

  set(entry: PresenceEntry): Promise<void> {
    this.entries.set(entry.agentId, {
      status: entry.status,
      languages: entry.languages,
      lastSeen: entry.lastSeen.toISOString(),
      tenantId: entry.tenantId,
    });
    return Promise.resolve();
  }
  read(agentId: string): Promise<PresenceRecord | null> {
    return Promise.resolve(this.entries.get(agentId) ?? null);
  }
  touch(): Promise<TouchResult | null> {
    return Promise.resolve(null);
  }
  setStatus(agentId: string, status: AgentPresence): Promise<boolean> {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return Promise.resolve(false);
    this.entries.set(agentId, { ...entry, status });
    return Promise.resolve(true);
  }
  remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
    return Promise.resolve();
  }
  ttl(): Promise<number> {
    return Promise.resolve(15);
  }
}

const agents: AgentRepository = {
  findAgentByEmail: (): Promise<AgentCredentialRow | null> => Promise.resolve(null),
  findProfile: (userId: string): Promise<AgentProfileRow | null> =>
    Promise.resolve({ userId, tenantId: TENANT, languages: ['en'], maxConcurrent: 1 }),
};

let calls: FakeCalls;
let sessions: FakeSessions;
let presenceStore: FakePresence;
let sweeper: CallSweeper;

beforeEach(() => {
  calls = new FakeCalls();
  sessions = new FakeSessions();
  presenceStore = new FakePresence();
  presenceStore.entries.set(AGENT, {
    tenantId: TENANT,
    status: AgentPresence.BUSY,
    languages: ['en'],
    lastSeen: NOW.toISOString(),
  });

  const logger = createLogger({ level: 'silent' });
  sweeper = new CallSweeper(
    sessions,
    calls,
    new PresenceService(presenceStore, agents, sessions, logger, () => NOW),
    new RecordingNotifications(),
    logger,
    false,
    () => NOW,
  );
  void ActorRole;
});

const armCustomer = (dueOffsetMs = -1000): void => {
  calls.deadlines.set(deadlineMember(SESSION, 'customer'), NOW.getTime() + dueOffsetMs);
};
const armAgent = (dueOffsetMs = -1000): void => {
  calls.deadlines.set(deadlineMember(SESSION, 'agent'), NOW.getTime() + dueOffsetMs);
};

describe('a customer who did not come back', () => {
  it('is DROPPED_IN_CALL, billed Rs 5 (R4)', async () => {
    armCustomer();

    const result = await sweeper.sweep();

    expect(result.dropped).toBe(1);
    expect(sessions.ended).toHaveLength(1);
    expect(sessions.ended[0]?.status).toBe(SessionStatus.DROPPED_IN_CALL);
    expect(sessions.ended[0]?.billCategory).toBe('FAILED');
    expect(sessions.ended[0]?.billAmountPaise).toBe(500);
  });

  it('appends CALL_ENDED naming why', async () => {
    armCustomer();
    await sweeper.sweep();
    const event = sessions.ended[0]?.event;
    expect(event?.type).toBe(SessionEventType.CALL_ENDED);
    expect(event?.payload).toMatchObject({ to: SessionStatus.DROPPED_IN_CALL });
  });

  it('frees the agent (R5)', async () => {
    armCustomer();
    await sweeper.sweep();
    expect(presenceStore.entries.get(AGENT)?.status).toBe(AgentPresence.AVAILABLE);
  });
});

describe('an agent who did not come back', () => {
  /**
   * D18: the reconnect window lapsing terminates per the failure policy, and
   * that is `ABORTED` — not `DROPPED_IN_CALL`, which is the customer's.
   */
  it('is ABORTED, billed Rs 5 (D18)', async () => {
    armAgent();

    const result = await sweeper.sweep();

    expect(result.aborted).toBe(1);
    expect(result.dropped).toBe(0);
    expect(sessions.ended[0]?.status).toBe(SessionStatus.ABORTED);
    expect(sessions.ended[0]?.billAmountPaise).toBe(500);
  });
});

describe('deadlines that are not due', () => {
  it('leaves a window that is still counting', async () => {
    armCustomer(+5000);
    const result = await sweeper.sweep();
    expect(result.due).toBe(0);
    expect(sessions.ended).toHaveLength(0);
  });
});

describe('sessions that ended by another route', () => {
  /**
   * A verdict (T35), a customer abort, or the other sweeper getting there
   * first. The guarded UPDATE matches nothing and nothing is billed (I11).
   */
  it('bills nothing when the session is already terminal', async () => {
    sessions.status = SessionStatus.APPROVED;
    armCustomer();

    const result = await sweeper.sweep();

    expect(result.stale).toBe(1);
    expect(result.dropped).toBe(0);
    expect(sessions.ended).toHaveLength(0);
  });

  it('takes the deadline anyway, so it cannot be retried forever', async () => {
    sessions.status = SessionStatus.ABORTED;
    armCustomer();
    await sweeper.sweep();
    expect(calls.deadlines.size).toBe(0);
  });
});

describe('running it twice', () => {
  it('ends the session once and bills once', async () => {
    armCustomer();

    const first = await sweeper.sweep();
    const second = await sweeper.sweep();

    expect(first.dropped).toBe(1);
    expect(second.dropped).toBe(0);
    expect(sessions.ended).toHaveLength(1);
  });
});

describe('a deadline that cannot be read', () => {
  it('is discarded rather than acted on', async () => {
    calls.deadlines.set('not-a-member', NOW.getTime() - 1000);

    const result = await sweeper.sweep();

    expect(sessions.ended).toHaveLength(0);
    expect(result.dropped).toBe(0);
  });
});

describe('an empty pass', () => {
  it('reports zeros and writes nothing', async () => {
    await expect(sweeper.sweep()).resolves.toEqual({ due: 0, dropped: 0, aborted: 0, stale: 0 });
  });
});

/**
 * A call that never began.
 *
 * The gap this closes: every other deadline is armed by a departure, so a
 * participant who never arrived armed nothing and the sweeper never looked. A
 * session could sit `IN_CALL` indefinitely with an agent parked in an empty
 * room, their capacity consumed and no billing row written.
 */
describe('a call that never started', () => {
  const armStart = (dueOffsetMs = -1000): void => {
    calls.deadlines.set(deadlineMember(SESSION, CallDeadline.START), NOW.getTime() + dueOffsetMs);
  };

  it('is DROPPED_IN_CALL, billed Rs 5', async () => {
    // The customer reached the queue and an agent was assigned, so the session
    // is past billing eligibility. It lands where a customer who vanishes
    // mid-call lands, for the same reason and at the same price.
    armStart();

    const result = await sweeper.sweep();

    expect(result.dropped).toBe(1);
    expect(sessions.ended[0]?.status).toBe(SessionStatus.DROPPED_IN_CALL);
    expect(sessions.ended[0]?.billAmountPaise).toBe(500);
  });

  it('says in the history that the call never began', async () => {
    // `call_never_started` and `customer_disconnected` reach the same status at
    // the same price, so this string is the only place the record tells them
    // apart — that, and a null `talk_ms`.
    armStart();

    await sweeper.sweep();

    expect(sessions.ended[0]?.event.payload).toMatchObject({ reason: 'call_never_started' });
  });

  it('frees the agent from a call that never happened', async () => {
    armStart();

    await sweeper.sweep();

    expect(presenceStore.entries.get(AGENT)?.status).toBe(AgentPresence.AVAILABLE);
  });

  it('does nothing when the call did start', async () => {
    // A member that outlived its meaning: both parties arrived, the deadline
    // was disarmed, and this delivery is late. Ending a live call on a stale
    // timeout would be the worst outcome this mechanism could have.
    sessions.callStarted = true;
    armStart();

    const result = await sweeper.sweep();

    expect(sessions.ended).toEqual([]);
    expect(result.stale).toBe(1);
  });

  it('takes the deadline either way, so it cannot fire twice', async () => {
    sessions.callStarted = true;
    armStart();

    await sweeper.sweep();

    expect(calls.deadlines.has(deadlineMember(SESSION, CallDeadline.START))).toBe(false);
  });

  it('is not acted on before it falls due', async () => {
    armStart(60_000);

    expect(await sweeper.sweep()).toMatchObject({ due: 0 });
  });
});

describe('which deadlines ask whether the call started', () => {
  it('only the start one', async () => {
    // A departure deadline reads its outcome off the member alone. Asking
    // PostgreSQL for those would be a query on every sweep for no answer.
    calls.deadlines.set(deadlineMember(SESSION, 'customer'), NOW.getTime() - 1000);

    await sweeper.sweep();

    expect(sessions.hasEventCalls).toBe(0);
  });
});
