/**
 * What a webhook does to a session, without a signing key or a Redis.
 *
 * The fakes reproduce the semantics the real stores have — set membership for
 * the room, a scored member per deadline — because the assertions are about
 * *when* something is written, and a double that always says yes would prove
 * nothing about the both-participants rule.
 */

import { SessionEventType, SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../common/logging/logger.js';
import type { AiAnalysisService } from '../ai/ai-analysis.service.js';
import { AiAnalysisOutcome } from '../ai/ai-analysis.service.js';
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
import type { TenantConfig, TenantConfigStore } from '../tenants/tenant-config.store.js';
import { TenantsService } from '../tenants/tenants.service.js';
import type { CallWebhookEvent } from './call-events.rules.js';
import { CallLifecycleService } from './call-lifecycle.service.js';
import type { RecordingService } from './recording.service.js';
import { RecordingOutcome } from './recording.service.js';
import type { CallRepository, DueDeadline } from './call.repository.js';
import { CallDeadline, deadlineMember } from './call.keys.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ROOM = `vcip_${SESSION}`;
const NOW = new Date('2026-09-01T12:00:00.000Z');

const RECONNECT_SECONDS = 60;

const event = (over: Partial<CallWebhookEvent> = {}): CallWebhookEvent => ({
  event: 'participant_joined',
  id: `EV_${Math.random().toString(36).slice(2)}`,
  roomName: ROOM,
  participantIdentity: 'customer',
  disconnectReason: null,
  ...over,
});

// --------------------------------------------------------------------- fakes

class FakeCalls implements CallRepository {
  readonly seen = new Set<string>();
  readonly participants = new Map<string, Set<string>>();
  readonly deadlines = new Map<string, number>();

  markSeen(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return Promise.resolve(false);
    this.seen.add(eventId);
    return Promise.resolve(true);
  }

  addParticipant(sessionId: string, role: string): Promise<readonly string[]> {
    const set = this.participants.get(sessionId) ?? new Set<string>();
    set.add(role);
    this.participants.set(sessionId, set);
    return Promise.resolve([...set]);
  }

  removeParticipant(sessionId: string, role: string): Promise<readonly string[]> {
    const set = this.participants.get(sessionId) ?? new Set<string>();
    set.delete(role);
    this.participants.set(sessionId, set);
    return Promise.resolve([...set]);
  }

  clearParticipants(sessionId: string): Promise<void> {
    this.participants.delete(sessionId);
    return Promise.resolve();
  }

  armDeadline(sessionId: string, reason: CallDeadline, dueAtMs: number): Promise<void> {
    this.deadlines.set(deadlineMember(sessionId, reason), dueAtMs);
    return Promise.resolve();
  }

  disarmDeadline(sessionId: string, reason: CallDeadline): Promise<boolean> {
    return Promise.resolve(this.deadlines.delete(deadlineMember(sessionId, reason)));
  }

  disarmAll(sessionId: string): Promise<void> {
    for (const reason of ['customer', 'agent', 'start'] as const) {
      this.deadlines.delete(deadlineMember(sessionId, reason));
    }
    return Promise.resolve();
  }

  dueDeadlines(nowMs: number, limit: number): Promise<readonly DueDeadline[]> {
    return Promise.resolve(
      [...this.deadlines.entries()]
        .filter(([, due]) => due <= nowMs)
        .slice(0, limit)
        .map(([member, dueAtMs]) => ({ member, dueAtMs })),
    );
  }
}

class FakeSessions implements SessionRepository {
  row: CallSessionRow | null = {
    id: SESSION,
    tenantId: TENANT,
    status: SessionStatus.IN_CALL,
    roomName: `vcip_${SESSION}`,
    agentId: AGENT,
    queuedAt: new Date(NOW.getTime() - 120_000),
    connectedAt: new Date(NOW.getTime() - 60_000),
    callStartedAt: null,
  };

  readonly appended: SessionEventInput[] = [];
  readonly ended: EndCallCommand[] = [];

  findUnrecordedCalls(): Promise<readonly UnrecordedCallRow[]> {
    throw new Error('the webhook path must not look for unrecorded calls');
  }

  findForCallEvent(): Promise<CallSessionRow | null> {
    return Promise.resolve(this.row);
  }

  appendCallEvent(_sessionId: string, event: SessionEventInput): Promise<boolean> {
    this.appended.push(event);
    return Promise.resolve(true);
  }

  hasEvent(_sessionId: string, eventType: SessionEventType): Promise<boolean> {
    return Promise.resolve(this.appended.some((e) => e.type === eventType));
  }

  submitVerdict(): Promise<never> {
    throw new Error('a webhook must never submit a verdict');
  }

  endCall(command: EndCallCommand): Promise<EndedCallRow | null> {
    this.ended.push(command);
    return Promise.resolve({
      id: command.sessionId,
      status: command.status,
      endedAt: command.now,
      talkMs: 1000,
      agentId: AGENT,
    });
  }

  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('a webhook must not create a session');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('a webhook must not move a session through the customer path');
  }

  abortSession(): Promise<SessionRow | null> {
    throw new Error('a webhook must not abort a session');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('a webhook must not claim');
  }
  accept(_c: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('a webhook must not accept');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('a webhook must not sweep offers');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('the call path reads its own narrow projection');
  }
  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('the call path must not read the claim projection');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('the call path must not read the queue projection');
  }
  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('the call path must not mint a media token');
  }
  findActiveWork(): Promise<readonly AgentWorkRow[]> {
    throw new Error('the call path must not list an agent’s work');
  }
  countActiveWork(): Promise<number> {
    throw new Error('the call path must not count work');
  }
}

const tenantStore: TenantConfigStore = {
  findConfig: (tenantId) =>
    Promise.resolve({
      tenantId,
      status: 'ACTIVE',
      minVideoPx: 480,
      minMicLevel: 10,
      maxRttMs: 300,
      minDownlinkKbps: 500,
      minLightingScore: 30,
      minStabilityScore: 30,
      gpsMaxAccuracyM: 100,
      offerTimeoutSeconds: 30,
      agentReconnectTimeoutSeconds: RECONNECT_SECONDS,
    } satisfies TenantConfig),
  findActiveChecklistTemplateId: () => Promise.resolve(null),
};

/** Records what the lifecycle asked it to record. */
class FakeRecording {
  readonly started: { sessionId: string; tenantId: string; roomName: string | null }[] = [];

  start(sessionId: string, tenantId: string, roomName: string | null): Promise<RecordingOutcome> {
    this.started.push({ sessionId, tenantId, roomName });
    return Promise.resolve(RecordingOutcome.STARTED);
  }
}

/** T30's analyzer trigger, recorded rather than performed. */
class FakeAi {
  readonly started: { sessionId: string; tenantId: string; roomName: string | null }[] = [];

  start(sessionId: string, tenantId: string, roomName: string | null): Promise<AiAnalysisOutcome> {
    this.started.push({ sessionId, tenantId, roomName });
    return Promise.resolve(AiAnalysisOutcome.STARTED);
  }
}

let recording: FakeRecording;
let ai: FakeAi;
let calls: FakeCalls;
let sessions: FakeSessions;
let service: CallLifecycleService;

beforeEach(() => {
  calls = new FakeCalls();
  sessions = new FakeSessions();
  recording = new FakeRecording();
  ai = new FakeAi();
  service = new CallLifecycleService(
    sessions,
    calls,
    new TenantsService(tenantStore),
    recording as unknown as RecordingService,
    ai as unknown as AiAnalysisService,
    new RecordingNotifications(),
    createLogger({ level: 'silent' }),
    () => NOW,
  );
});

const types = (): string[] => sessions.appended.map((e) => e.type);

// --------------------------------------------------------------------- tests

describe('CALL_STARTED needs both participants', () => {
  it('is not appended when only the agent is in the room', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    expect(types()).not.toContain(SessionEventType.CALL_STARTED);
  });

  it('is not appended when only the customer is in the room', async () => {
    await service.handle(event({ participantIdentity: 'customer' }));
    expect(types()).not.toContain(SessionEventType.CALL_STARTED);
  });

  it('is appended once both are present', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
    expect(types()).toContain(SessionEventType.CALL_STARTED);
  });

  it('does not care which order they arrive in', async () => {
    await service.handle(event({ participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'agent' }));
    expect(types()).toContain(SessionEventType.CALL_STARTED);
  });

  /**
   * Redis knows only who is in the room now. A customer who leaves and rejoins
   * would satisfy "both present" a second time, so the once-only guard is
   * PostgreSQL's.
   */
  it('is appended exactly once across a rejoin', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(types().filter((t) => t === SessionEventType.CALL_STARTED)).toHaveLength(1);
  });

  it('records the wait the customer actually experienced', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    const started = sessions.appended.find((e) => e.type === SessionEventType.CALL_STARTED);
    expect(started?.payload).toEqual({ waited_ms: 120_000 });
  });
});

describe('the agent disconnecting', () => {
  const bothJoin = async (): Promise<void> => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
  };

  it('appends AGENT_DISCONNECTED and leaves the session IN_CALL (D18)', async () => {
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'agent' }));

    expect(types()).toContain(SessionEventType.AGENT_DISCONNECTED);
    // Nothing here terminates. The sweeper owns that.
    expect(sessions.ended).toHaveLength(0);
  });

  it('arms the tenant reconnect window, not the customer one', async () => {
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'agent' }));

    expect(calls.deadlines.get(deadlineMember(SESSION, 'agent'))).toBe(
      NOW.getTime() + RECONNECT_SECONDS * 1000,
    );
  });

  it('appends AGENT_RECONNECTED when they return to a live window', async () => {
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'agent' }));

    expect(types()).toContain(SessionEventType.AGENT_RECONNECTED);
    expect(calls.deadlines.has(deadlineMember(SESSION, 'agent'))).toBe(false);
  });

  it('does not call a first join a reconnection', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    expect(types()).not.toContain(SessionEventType.AGENT_RECONNECTED);
  });
});

describe('the customer disconnecting', () => {
  it('arms the twenty-second grace window and terminates nothing', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));

    expect(calls.deadlines.get(deadlineMember(SESSION, 'customer'))).toBe(NOW.getTime() + 20_000);
    expect(sessions.ended).toHaveLength(0);
  });

  it('appends no AGENT_DISCONNECTED for a customer', async () => {
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    expect(types()).not.toContain(SessionEventType.AGENT_DISCONNECTED);
  });

  /**
   * The reload case. T25's customer app rejoins automatically, and cancelling
   * the window is what stops a refresh costing the customer their session.
   */
  it('cancels the window when the customer comes back', async () => {
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'customer' }));
    expect(calls.deadlines.has(deadlineMember(SESSION, 'customer'))).toBe(false);
  });
});

describe('sessions that have already ended', () => {
  it('arms nothing when a participant leaves a finished session', async () => {
    sessions.row = { ...(sessions.row as CallSessionRow), status: SessionStatus.APPROVED };

    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));

    expect(calls.deadlines.size).toBe(0);
    expect(sessions.ended).toHaveLength(0);
  });
});

describe('deliveries that change nothing', () => {
  it('skips a repeat of the same event id', async () => {
    const once = event({ participantIdentity: 'agent' });
    await service.handle(once);
    const second = await service.handle(once);

    expect(second).toEqual({ handled: 'DUPLICATE', duplicate: true });
    expect(calls.participants.get(SESSION)?.size).toBe(1);
  });

  it('acknowledges an unknown session rather than failing', async () => {
    sessions.row = null;
    const outcome = await service.handle(event());
    expect(outcome.handled).toBe('IGNORE');
  });

  it('acknowledges a room this product did not name', async () => {
    const outcome = await service.handle(event({ roomName: 'spike-room' }));
    expect(outcome.handled).toBe('IGNORE');
  });

  it('forgets the room when it closes, and terminates nothing', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    const outcome = await service.handle(
      event({ event: 'room_finished', participantIdentity: null }),
    );

    expect(outcome.handled).toBe('ROOM_CLOSED');
    expect(calls.participants.has(SESSION)).toBe(false);
    expect(sessions.ended).toHaveLength(0);
  });
});

describe('the evidence recording (T28)', () => {
  const bothJoin = async (): Promise<void> => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
  };

  /**
   * The plan calls this "recording start on accept", and that is not
   * implementable: at accept nobody has joined, so the room does not exist and
   * LiveKit answers `requested room does not exist`. Design §21.2's "when the
   * actual call begins" is this moment.
   */
  it('starts when both participants are in the room', async () => {
    await bothJoin();

    expect(recording.started).toEqual([
      { sessionId: SESSION, tenantId: TENANT, roomName: `vcip_${SESSION}` },
    ]);
  });

  it('does not start for the agent alone', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    expect(recording.started).toEqual([]);
  });

  it('does not start for the customer alone', async () => {
    await service.handle(event({ participantIdentity: 'customer' }));
    expect(recording.started).toEqual([]);
  });

  /**
   * A customer who reloads satisfies "both present" a second time. The service
   * refuses a second start, but the lifecycle should not be asking either —
   * `CALL_STARTED` is once per session and so is the recording.
   */
  it('is not asked for again when a participant rejoins', async () => {
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(recording.started).toHaveLength(1);
  });

  it('is asked for after CALL_STARTED, never instead of it', async () => {
    await bothJoin();

    expect(types()).toContain(SessionEventType.CALL_STARTED);
    expect(recording.started).toHaveLength(1);
  });

  it('is not asked for on a session that already ended', async () => {
    sessions.row = { ...(sessions.row as CallSessionRow), status: SessionStatus.APPROVED };

    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));

    expect(recording.started).toEqual([]);
  });
});

/**
 * Starting the AI analysis (T30).
 *
 * The same instant as the recording, for a related reason: there is no
 * customer video to subscribe to until somebody is publishing it, and a
 * customer waiting alone is not a call worth spending a core decoding.
 */
describe('the AI analysis', () => {
  const bothJoin = async (): Promise<void> => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
  };

  it('starts when both participants are in the room', async () => {
    await bothJoin();

    expect(ai.started).toEqual([
      { sessionId: SESSION, tenantId: TENANT, roomName: `vcip_${SESSION}` },
    ]);
  });

  it('does not start for one participant alone', async () => {
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(ai.started).toEqual([]);
  });

  it('is asked for after CALL_STARTED, never instead of it', async () => {
    await bothJoin();

    expect(types()).toContain(SessionEventType.CALL_STARTED);
    expect(ai.started).toHaveLength(1);
  });

  /**
   * The difference between the analysis and the recording, and the reason
   * `onJoined` asks on every arrival.
   *
   * The analyzer leaves when the customer does — deliberately, so it cannot
   * hold a room open past the call and stop the recording from ever ending.
   * A customer who returns inside the grace window resumes a call that would
   * otherwise run to its verdict with a HUD frozen at the moment they dropped.
   */
  it('is asked for again when the customer comes back', async () => {
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(ai.started).toHaveLength(2);
    expect(ai.started[1]).toEqual({
      sessionId: SESSION,
      tenantId: TENANT,
      roomName: `vcip_${SESSION}`,
    });
  });

  it('does not record the call a second time when the customer comes back', async () => {
    // The recording never stopped: the agent kept the room alive, and a second
    // start would open a second file.
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(recording.started).toHaveLength(1);
  });

  it('does not start the call a second time when the customer comes back', async () => {
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(types().filter((type) => type === SessionEventType.CALL_STARTED)).toHaveLength(1);
  });

  it('is asked for again when the agent comes back', async () => {
    // Harmless and deliberate: the AI service refuses a second analysis for a
    // session it is already analysing, so this costs one no-op call and covers
    // the case where the analyzer's own connection was the one that dropped.
    await bothJoin();
    await service.handle(event({ event: 'participant_left', participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'agent' }));

    expect(ai.started).toHaveLength(2);
  });

  it('is not asked for on a session that has already ended', async () => {
    // A late or replayed join webhook must not put an analyzer into the room
    // of a verification that is over.
    sessions.row = { ...(sessions.row as CallSessionRow), status: SessionStatus.APPROVED };

    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(ai.started).toEqual([]);
  });

  it('does not hold up the recording', async () => {
    // Both hang off the same moment, and the evidence is the one that matters:
    // an AI service that is slow or missing must not cost the recording.
    await bothJoin();

    expect(recording.started).toHaveLength(1);
    expect(ai.started).toHaveLength(1);
  });
});

/**
 * The clock on a call that has not begun.
 *
 * Every other deadline here hangs off a departure, which left one case with no
 * clock at all: a participant who never arrives never leaves. An agent could
 * sit in an empty room indefinitely — `IN_CALL`, capacity consumed, no billing
 * row — with no way out but closing the tab.
 */
describe('the call-start deadline', () => {
  const startMember = deadlineMember(SESSION, CallDeadline.START);

  it('is armed when the agent is in the room alone', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));

    expect(calls.deadlines.has(startMember)).toBe(true);
  });

  it('is armed when the customer is in the room alone', async () => {
    // The mirror case: an agent who accepted and never joined leaves the
    // customer waiting on a call that will never begin.
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(calls.deadlines.has(startMember)).toBe(true);
  });

  it('falls due two minutes after the arrival', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));

    expect(calls.deadlines.get(startMember)).toBe(NOW.getTime() + 120_000);
  });

  it('is disarmed the moment both parties are present', async () => {
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));

    expect(calls.deadlines.has(startMember)).toBe(false);
  });

  it('is not armed against a session that already ended', async () => {
    // A stale tab reloading into the room of a finished verification.
    sessions.row = { ...sessions.row, status: SessionStatus.APPROVED } as CallSessionRow;

    await service.handle(event({ participantIdentity: 'agent' }));

    expect(calls.deadlines.has(startMember)).toBe(false);
  });

  it('is re-armed when the lone agent reloads', async () => {
    // A fresh window rather than the remains of the last one: the customer
    // should not lose their allowance to the agent's refresh.
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ event: 'participant_left', participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'agent' }));

    expect(calls.deadlines.get(startMember)).toBe(NOW.getTime() + 120_000);
  });

  it('does not disturb the departure deadlines', async () => {
    // Three clocks, three meanings. The start clock must not clear the window
    // a departing customer is being given.
    await service.handle(event({ participantIdentity: 'agent' }));
    await service.handle(event({ participantIdentity: 'customer' }));
    await service.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));

    expect(calls.deadlines.has(deadlineMember(SESSION, CallDeadline.CUSTOMER))).toBe(true);
  });
});
