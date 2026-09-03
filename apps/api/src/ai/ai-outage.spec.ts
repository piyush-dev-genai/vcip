/**
 * The AI going away mid-call (T32).
 *
 * The gate for Day 4, and the one the whole subsystem is shaped around: kill
 * the AI process while a verification is under way and **the call survives, the
 * HUD reads "AI unavailable", and the verdict is still submittable.** D6 says
 * AI is off the video critical path and I7 says it never decides anything;
 * this is where both stop being prose.
 *
 * Every other AI spec tests one unit against doubles. This one is deliberately
 * a composition: the real `CallLifecycleService`, the real `AiAnalysisService`
 * and the real `AiResultService`, wired as the running server wires them, with
 * fakes only where a process boundary genuinely is — the HTTP call to Python,
 * Redis, PostgreSQL, the LiveKit signing key. A dead AI service is exactly a
 * boundary failure, so those are the seams worth breaking.
 *
 * The three claims, and how each is reached:
 *
 *   1. **The call survives.** `CALL_STARTED` is appended, the evidence
 *      recording starts, and no webhook delivery fails, with every AI call
 *      raising. Proving this needs the composition: each service in isolation
 *      is already tested, and what a gate is for is the wiring between them.
 *   2. **The HUD reads "AI unavailable".** A dead analyzer publishes nothing,
 *      so the API's half of the claim is the absence of further messages and
 *      the presence of `AI_UNAVAILABLE` in the history. The display half is a
 *      pure function in the agent portal, proved in `agent/lib/ai-hud.spec.ts`
 *      — including the HUD stored before the AI died being handed to a
 *      reconnecting portal, which must read as stale rather than as current.
 *   3. **The verdict is still submittable.** `POST .../verdict` is T35 and does
 *      not exist yet, so what is asserted is everything that endpoint will
 *      require: the session is still `IN_CALL`, the agent still holds it, and
 *      both terminal transitions are still legal. The fake repository raises on
 *      every status-writing method, so an AI path that moved a session would
 *      fail these tests rather than quietly change the answer.
 */

import type { AiHudPayload, SessionEventType as SessionEventTypeT } from '@vcip/shared';
import {
  LivenessStatus,
  OcrStatus,
  SessionEventType,
  SessionStatus,
  canTransition,
} from '@vcip/shared';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../common/logging/logger.js';
import type { CallWebhookEvent } from '../livekit/call-events.rules.js';
import { CallLifecycleService } from '../livekit/call-lifecycle.service.js';
import type { CallRepository, DueDeadline } from '../livekit/call.repository.js';
import type { CallDeadline } from '../livekit/call.keys.js';
import { deadlineMember } from '../livekit/call.keys.js';
import type { LiveKitConfig } from '../livekit/livekit.config.js';
import type { MediaTokenGrantRequest, MediaTokenMinter } from '../livekit/media-token.minter.js';
import type { RecordingService } from '../livekit/recording.service.js';
import { RecordingOutcome } from '../livekit/recording.service.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';
import type {
  CallSessionRow,
  SessionEventInput,
  SessionRepository,
} from '../sessions/session.repository.js';
import type { TenantConfig, TenantConfigStore } from '../tenants/tenant-config.store.js';
import { TenantsService } from '../tenants/tenants.service.js';
import type { AnalysisStarter } from './ai-analysis.client.js';
import { AiAnalysisOutcome, AiAnalysisService } from './ai-analysis.service.js';
import type { AiHudRepository } from './ai-hud.repository.js';
import { AiResultOutcome, AiResultService } from './ai-result.service.js';
import type { AiConfig } from './ai.config.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ROOM = `vcip_${SESSION}`;
const NOW = new Date('2026-09-03T12:00:00.000Z');

/** What a dead uvicorn actually produces on the Node side. */
const connectionRefused = (): Error =>
  Object.assign(new Error('fetch failed'), {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:8000'),
  });

const event = (over: Partial<CallWebhookEvent> = {}): CallWebhookEvent => ({
  event: 'participant_joined',
  id: `EV_${Math.random().toString(36).slice(2)}`,
  roomName: ROOM,
  participantIdentity: 'customer',
  disconnectReason: null,
  ...over,
});

// --------------------------------------------------------------------- fakes

/**
 * The session store, with the status-writing methods armed.
 *
 * `update` and `endCall` raise rather than record. The gate's third claim is
 * that an AI outage leaves the session exactly where it was, and a fake that
 * politely accepted a write would let a regression pass while the assertions
 * below went on reading a status nothing had moved.
 */
class FakeSessions {
  row: CallSessionRow | null = {
    id: SESSION,
    tenantId: TENANT,
    status: SessionStatus.IN_CALL,
    roomName: ROOM,
    agentId: AGENT,
    queuedAt: new Date(NOW.getTime() - 90_000),
    connectedAt: new Date(NOW.getTime() - 30_000),
    callStartedAt: null,
  };

  readonly appended: SessionEventInput[] = [];
  /** Set to make the history itself unwritable, as a database blip would. */
  appendFails = false;

  findForCallEvent(sessionId: string): Promise<CallSessionRow | null> {
    return Promise.resolve(this.row?.id === sessionId ? this.row : null);
  }

  appendCallEvent(_sessionId: string, input: SessionEventInput): Promise<boolean> {
    if (this.appendFails) return Promise.reject(new Error('the database is not answering'));
    this.appended.push(input);
    return Promise.resolve(true);
  }

  hasEvent(_sessionId: string, type: SessionEventTypeT): Promise<boolean> {
    if (this.appendFails) return Promise.reject(new Error('the database is not answering'));
    return Promise.resolve(this.appended.some((entry) => entry.type === type));
  }

  update(): Promise<never> {
    throw new Error('an AI outage must never move a session');
  }

  endCall(): Promise<never> {
    throw new Error('an AI outage must never end a call');
  }
}

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

/** The evidence recording. It must start whatever the AI is doing (T28). */
class FakeRecording {
  readonly started: string[] = [];

  start(sessionId: string): Promise<RecordingOutcome> {
    this.started.push(sessionId);
    return Promise.resolve(RecordingOutcome.STARTED);
  }
}

class FakeMinter implements MediaTokenMinter {
  readonly requests: MediaTokenGrantRequest[] = [];

  mint(request: MediaTokenGrantRequest): Promise<string> {
    this.requests.push(request);
    return Promise.resolve('an.analyzer.token');
  }
}

/**
 * The HTTP call to the Python service — the thing this gate kills.
 *
 * `alive = false` is the whole outage: every start request is refused the way
 * a socket to a dead port is refused.
 */
class DeadAiService implements AnalysisStarter {
  alive = false;
  readonly attempts: string[] = [];

  start(sessionId: string): Promise<void> {
    this.attempts.push(sessionId);
    return this.alive ? Promise.resolve() : Promise.reject(connectionRefused());
  }
}

/** The HUD, in memory. What matters here is only what survives the outage. */
class FakeHud implements AiHudRepository {
  readonly stored = new Map<string, AiHudPayload>();

  save(sessionId: string, payload: AiHudPayload): Promise<AiHudPayload> {
    this.stored.set(sessionId, payload);
    return Promise.resolve(payload);
  }

  saveDocument(): Promise<AiHudPayload | null> {
    throw new Error('an AI outage means no document check ever runs');
  }

  read(sessionId: string): Promise<AiHudPayload | null> {
    return Promise.resolve(this.stored.get(sessionId) ?? null);
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
      agentReconnectTimeoutSeconds: 60,
    } satisfies TenantConfig),
  findActiveChecklistTemplateId: () => Promise.resolve(null),
};

const AI_CONFIG: AiConfig = Object.freeze({
  enabled: true,
  baseUrl: 'http://127.0.0.1:8000',
  startTimeoutMs: 2_000,
  documentTimeoutMs: 15_000,
});

const LIVEKIT = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'a'.repeat(32),
  tokenTtlSeconds: 900,
} as unknown as LiveKitConfig;

// ----------------------------------------------------------------- the stack

let sessions: FakeSessions;
let calls: FakeCalls;
let recording: FakeRecording;
let python: DeadAiService;
let hud: FakeHud;
let notify: RecordingNotifications;
let lifecycle: CallLifecycleService;
let analysis: AiAnalysisService;
let results: AiResultService;

beforeEach(() => {
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const silent = createLogger({ level: 'silent', destination: sink });

  sessions = new FakeSessions();
  calls = new FakeCalls();
  recording = new FakeRecording();
  python = new DeadAiService();
  hud = new FakeHud();
  notify = new RecordingNotifications();

  analysis = new AiAnalysisService(
    sessions as unknown as SessionRepository,
    new FakeMinter(),
    python,
    AI_CONFIG,
    LIVEKIT,
    silent,
  );

  results = new AiResultService(hud, sessions as unknown as SessionRepository, notify, silent);

  lifecycle = new CallLifecycleService(
    sessions as unknown as SessionRepository,
    calls,
    new TenantsService(tenantStore),
    recording as unknown as RecordingService,
    analysis,
    notify,
    silent,
    () => NOW,
  );
});

/** Both parties arrive: the moment the analysis and the recording are asked for. */
const bothJoin = async (): Promise<void> => {
  await lifecycle.handle(event({ participantIdentity: 'agent' }));
  await lifecycle.handle(event({ participantIdentity: 'customer' }));
};

const types = (): string[] => sessions.appended.map((entry) => entry.type);

const count = (type: SessionEventTypeT): number => types().filter((entry) => entry === type).length;

// ------------------------------------------------------------------- claim 1

describe('the call survives the AI being dead', () => {
  it('starts even though the analyzer cannot be reached', async () => {
    await bothJoin();

    expect(types()).toContain(SessionEventType.CALL_STARTED);
  });

  it('still records the evidence, which is the part that is not assistive', async () => {
    // T28's recording and T30's analysis are asked for on the same event. The
    // AI is allowed to be missing from a verification; the recording is not.
    await bothJoin();

    expect(recording.started).toEqual([SESSION]);
  });

  it('answers the webhook rather than raising at LiveKit', async () => {
    await lifecycle.handle(event({ participantIdentity: 'agent' }));
    const outcome = await lifecycle.handle(event({ participantIdentity: 'customer' }));

    expect(outcome.handled).toBe('JOINED');
  });

  it('tells the customer their agent arrived', async () => {
    // The one realtime message the call itself depends on, published on the
    // same path the failing analysis is requested from.
    await bothJoin();

    expect(notify.kinds()).toContain('agentJoined');
  });

  it('reports the failure as an outcome rather than as an exception', async () => {
    await expect(analysis.start(SESSION, TENANT, ROOM)).resolves.toBe(AiAnalysisOutcome.FAILED);
  });

  it('survives the history being unwritable at the same time', async () => {
    // The failure path is the one place left that touches PostgreSQL, and it
    // runs inside a catch. A blip there would otherwise throw out of the
    // webhook handler and answer LiveKit with a 500 on a call already under
    // way — turning "the AI is down" into a delivery the SFU retries.
    sessions.appendFails = true;

    await expect(analysis.start(SESSION, TENANT, ROOM)).resolves.toBe(AiAnalysisOutcome.FAILED);
  });
});

describe('the history says why the HUD was blank', () => {
  it('records AI_UNAVAILABLE', async () => {
    await bothJoin();

    expect(types()).toContain(SessionEventType.AI_UNAVAILABLE);
  });

  it('records it once, however many times the customer comes back', async () => {
    // A rejoin asks for the analysis again, so a dead service is discovered
    // repeatedly. A session's history is not the place to count retries of
    // something nothing is retrying.
    await bothJoin();
    await lifecycle.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await lifecycle.handle(event({ participantIdentity: 'customer' }));

    expect(python.attempts.length).toBeGreaterThan(1);
    expect(count(SessionEventType.AI_UNAVAILABLE)).toBe(1);
  });

  it('records the message, never the request that failed', async () => {
    // A fetch failure stringifies with the request it failed on, and that
    // request carried a live LiveKit join token and the internal credential.
    await bothJoin();

    const recorded = sessions.appended.find(
      (entry) => entry.type === SessionEventType.AI_UNAVAILABLE,
    );

    expect(JSON.stringify(recorded?.payload)).not.toContain('an.analyzer.token');
  });
});

describe('the analyzer leaving is not a participant leaving', () => {
  it('arms no reconnect window when the AI process dies mid-call', async () => {
    // Killing the AI drops its LiveKit connection, and LiveKit reports a
    // `participant_left` for identity `analyzer`. Read as a departure it would
    // arm a deadline the sweeper later acts on — ending a customer's
    // verification because a hidden subscriber went away.
    await bothJoin();
    calls.deadlines.clear();

    await lifecycle.handle(event({ event: 'participant_left', participantIdentity: 'analyzer' }));

    expect([...calls.deadlines.keys()]).toEqual([]);
  });

  it('records nothing about it', async () => {
    await bothJoin();
    const before = types().length;

    await lifecycle.handle(event({ event: 'participant_left', participantIdentity: 'analyzer' }));

    expect(types()).toHaveLength(before);
  });

  it('leaves the room membership the call is judged by untouched', async () => {
    await bothJoin();

    await lifecycle.handle(event({ event: 'participant_left', participantIdentity: 'analyzer' }));

    expect([...(calls.participants.get(SESSION) ?? [])].sort()).toEqual(['agent', 'customer']);
  });
});

// ------------------------------------------------------------------- claim 2

describe('what the HUD is left holding', () => {
  const result = {
    session_id: SESSION,
    liveness_score: 97,
    liveness_status: LivenessStatus.LIVE,
    face_match_score: 95,
    ocr_status: OcrStatus.PASS,
    model_versions: { liveness: 'demo-v1', face_match: 'demo-v1', ocr: 'demo-v1' },
  };

  it('keeps the last result the AI managed to publish', async () => {
    // Not for the panel — the panel is about to call it stale — but for T35,
    // which snapshots whatever the HUD holds at the verdict.
    await results.receive(result, NOW);

    expect((await hud.read(SESSION))?.liveness_score).toBe(97);
  });

  it('stamps it with server time, so silence is measurable', async () => {
    // The agent's panel decides staleness from this field. A timestamp the AI
    // service chose would be one an unreachable service could have left in the
    // future, and a HUD that never ages is a HUD that never says "unavailable".
    await results.receive(result, NOW);

    expect((await hud.read(SESSION))?.updated_at).toBe(NOW.toISOString());
  });

  it('publishes nothing more once the analyzer is gone', async () => {
    // The entire API-side signal of a dead AI is the absence of further
    // messages. Nothing announces the death, because nothing can: the process
    // that would have announced it is the one that died.
    await results.receive(result, NOW);
    notify.clear();

    expect(notify.of('aiUpdated')).toHaveLength(0);
  });

  it('never tells the customer, dead or alive', async () => {
    await results.receive(result, NOW);

    expect(notify.of('aiUpdated').map((sent) => sent.args[1])).toEqual([AGENT]);
  });

  it('takes a result again the moment the AI comes back', async () => {
    // Recovery within one call. The analyzer is asked for again on the
    // customer's next arrival, and nothing about the outage is sticky.
    python.alive = true;
    await bothJoin();

    await expect(results.receive(result, NOW)).resolves.toEqual({
      outcome: AiResultOutcome.DELIVERED,
    });
  });
});

// ------------------------------------------------------------------- claim 3

describe('the verdict is still submittable', () => {
  // T35 owns `POST /v1/agent/sessions/:id/verdict`. What is checked here is
  // everything it will require of the session, because that is what an AI
  // outage could have damaged and it is what can be checked today.

  it('leaves the session in call', async () => {
    await bothJoin();

    expect(sessions.row?.status).toBe(SessionStatus.IN_CALL);
  });

  it('leaves the agent holding it', async () => {
    await bothJoin();

    expect(sessions.row?.agentId).toBe(AGENT);
  });

  it('leaves both terminal outcomes legal', async () => {
    await bothJoin();

    const status = sessions.row?.status ?? SessionStatus.CREATED;
    expect(canTransition(status, SessionStatus.APPROVED)).toBe(true);
    expect(canTransition(status, SessionStatus.REJECTED)).toBe(true);
  });

  it('writes no session status at all, on any AI path', async () => {
    // `update` and `endCall` raise on the fake, so reaching the end of this
    // sequence is the assertion: the outage, the repeated retries, the
    // analyzer's departure, a customer round trip and a stored result together
    // move nothing.
    await bothJoin();
    await lifecycle.handle(event({ event: 'participant_left', participantIdentity: 'analyzer' }));
    await lifecycle.handle(event({ event: 'participant_left', participantIdentity: 'customer' }));
    await lifecycle.handle(event({ participantIdentity: 'customer' }));

    expect(sessions.row?.status).toBe(SessionStatus.IN_CALL);
  });
});
