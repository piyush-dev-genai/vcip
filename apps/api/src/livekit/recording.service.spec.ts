/**
 * Starting the evidence recording, without an egress container.
 *
 * The starter is a double, so these tests are about the decisions: whether to
 * start, what is written down about it, and what happens when LiveKit refuses.
 * That the SDK is called correctly is `recording.client.ts`'s business.
 */

import { SessionEventType } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../common/logging/logger.js';
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
import type { RecordingStarter, StartedRecording } from './recording.client.js';
import { RecordingOutcome, RecordingService } from './recording.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ROOM = `vcip_${SESSION}`;

class FakeSessions implements SessionRepository {
  readonly appended: SessionEventInput[] = [];

  appendCallEvent(_sessionId: string, event: SessionEventInput): Promise<boolean> {
    this.appended.push(event);
    return Promise.resolve(true);
  }

  hasEvent(_sessionId: string, eventType: SessionEventType): Promise<boolean> {
    return Promise.resolve(this.appended.some((e) => e.type === eventType));
  }

  types(): string[] {
    return this.appended.map((e) => e.type);
  }

  findForCallEvent(): Promise<CallSessionRow | null> {
    throw new Error('the recording service is told the session, not asked');
  }
  findUnrecordedCalls(): Promise<readonly UnrecordedCallRow[]> {
    throw new Error('the retry sweeper reads that, not this service');
  }
  submitVerdict(): Promise<never> {
    throw new Error('starting a recording must not submit a verdict');
  }

  endCall(_c: EndCallCommand): Promise<EndedCallRow | null> {
    throw new Error('starting a recording must not end a call');
  }
  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('no');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('starting a recording must not move a session');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('no');
  }
  accept(_c: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('no');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('no');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('no');
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

class FakeStarter implements RecordingStarter {
  readonly calls: { roomName: string; sessionId: string }[] = [];
  failWith: Error | null = null;

  start(roomName: string, sessionId: string): Promise<StartedRecording> {
    this.calls.push({ roomName, sessionId });
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve({ egressId: 'EG_abc123', key: `raw/${sessionId}.mp4` });
  }
}

let sessions: FakeSessions;
let starter: FakeStarter;
let service: RecordingService;

beforeEach(() => {
  sessions = new FakeSessions();
  starter = new FakeStarter();
  service = new RecordingService(sessions, starter, createLogger({ level: 'silent' }));
});

describe('starting a recording', () => {
  it('asks LiveKit to record that session’s room', async () => {
    const outcome = await service.start(SESSION, TENANT, ROOM);

    expect(outcome).toBe(RecordingOutcome.STARTED);
    expect(starter.calls).toEqual([{ roomName: ROOM, sessionId: SESSION }]);
  });

  /**
   * The egress id is the whole point of the event: no column carries it (D18,
   * D25), and T38 has no other way to find the file.
   */
  it('writes the egress id into EGRESS_STARTED', async () => {
    await service.start(SESSION, TENANT, ROOM);

    const started = sessions.appended.find((e) => e.type === SessionEventType.EGRESS_STARTED);
    expect(started?.payload).toEqual({
      egress_id: 'EG_abc123',
      room_name: ROOM,
      video_key: `raw/${SESSION}.mp4`,
    });
  });

  it('records it as a system action, not an agent’s', async () => {
    await service.start(SESSION, TENANT, ROOM);
    const started = sessions.appended.find((e) => e.type === SessionEventType.EGRESS_STARTED);
    expect(started?.actorType).toBe('SYSTEM');
    expect(started?.actorId).toBeNull();
  });
});

describe('starting twice', () => {
  /**
   * The retry pass can race the original attempt. A second recording of the
   * same call would mean two files and an ambiguous evidence package.
   */
  it('refuses when a recording is already running', async () => {
    await service.start(SESSION, TENANT, ROOM);
    const second = await service.start(SESSION, TENANT, ROOM);

    expect(second).toBe(RecordingOutcome.ALREADY_RUNNING);
    expect(starter.calls).toHaveLength(1);
  });

  it('appends exactly one EGRESS_STARTED', async () => {
    await service.start(SESSION, TENANT, ROOM);
    await service.start(SESSION, TENANT, ROOM);

    expect(sessions.types().filter((t) => t === SessionEventType.EGRESS_STARTED)).toHaveLength(1);
  });
});

describe('when LiveKit refuses', () => {
  beforeEach(() => {
    starter.failWith = new Error('requested room does not exist');
  });

  it('reports the failure rather than throwing', async () => {
    await expect(service.start(SESSION, TENANT, ROOM)).resolves.toBe(RecordingOutcome.FAILED);
  });

  /**
   * §15 has no name for a recording that never started, and "never started"
   * must not look like "still running" to an auditor asking where the video is.
   */
  it('appends EGRESS_FAILED with the reason', async () => {
    await service.start(SESSION, TENANT, ROOM);

    const failed = sessions.appended.find((e) => e.type === SessionEventType.EGRESS_FAILED);
    expect(failed?.payload).toEqual({ reason: 'requested room does not exist' });
  });

  /**
   * The retry pass tries every few seconds for the length of the call. An
   * event per attempt would bury the session's real history.
   */
  it('appends it once however many attempts fail', async () => {
    await service.start(SESSION, TENANT, ROOM);
    await service.start(SESSION, TENANT, ROOM);
    await service.start(SESSION, TENANT, ROOM);

    expect(sessions.types().filter((t) => t === SessionEventType.EGRESS_FAILED)).toHaveLength(1);
    expect(starter.calls).toHaveLength(3);
  });

  it('still lets a later attempt succeed', async () => {
    await service.start(SESSION, TENANT, ROOM);
    starter.failWith = null;

    expect(await service.start(SESSION, TENANT, ROOM)).toBe(RecordingOutcome.STARTED);
    expect(sessions.types()).toContain(SessionEventType.EGRESS_STARTED);
  });

  it('never moves the session or ends the call', async () => {
    // Every mutating method on the fake throws; reaching one fails the test.
    await expect(service.start(SESSION, TENANT, ROOM)).resolves.toBeDefined();
  });

  /**
   * An SDK error can carry the request it failed on, and that request was
   * configured with the storage credentials.
   */
  it('records the message and not the error object', async () => {
    starter.failWith = Object.assign(new Error('upload refused'), {
      request: { secret: 'super-secret-key' },
    });

    await service.start(SESSION, TENANT, ROOM);

    const serialised = JSON.stringify(sessions.appended);
    expect(serialised).not.toContain('super-secret-key');
    expect(serialised).toContain('upload refused');
  });
});

describe('a session with no room', () => {
  it('reports it and asks LiveKit for nothing', async () => {
    const outcome = await service.start(SESSION, TENANT, null);

    expect(outcome).toBe(RecordingOutcome.NO_ROOM);
    expect(starter.calls).toEqual([]);
    expect(sessions.appended).toEqual([]);
  });
});

describe('what the service never does', () => {
  it('stops nothing', () => {
    // Room-composite egress ends when the room does; `infra/livekit.yaml`
    // closes an empty room after `empty_timeout`. There is no stop path.
    expect(Object.getOwnPropertyNames(RecordingService.prototype)).not.toContain('stop');
  });

  it('exposes only the one entry point', () => {
    expect(
      Object.getOwnPropertyNames(RecordingService.prototype).filter((n) => n !== 'constructor'),
    ).toEqual(['start', 'recordFailure']);
  });
});
