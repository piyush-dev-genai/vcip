import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../common/logging/logger.js';
import type { UnrecordedCallRow } from '../sessions/session.repository.js';
import { RecordingRetrySweeper } from './recording-retry.service.js';
import type { RecordingService } from './recording.service.js';
import { RecordingOutcome } from './recording.service.js';
import { RECORDING_RETRY_BATCH } from './recording.rules.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const call = (id: string): UnrecordedCallRow => ({
  id,
  tenantId: TENANT,
  roomName: `vcip_${id}`,
});

/** Only the one read the sweeper makes. Everything else is out of its reach. */
class FakeSessions {
  stalled: UnrecordedCallRow[] = [];
  askedFor: number[] = [];

  findUnrecordedCalls(limit: number): Promise<readonly UnrecordedCallRow[]> {
    this.askedFor.push(limit);
    return Promise.resolve(this.stalled.slice(0, limit));
  }
}

class FakeRecording {
  readonly attempts: string[] = [];
  outcome: RecordingOutcome = RecordingOutcome.STARTED;

  start(sessionId: string): Promise<RecordingOutcome> {
    this.attempts.push(sessionId);
    return Promise.resolve(this.outcome);
  }
}

let sessions: FakeSessions;
let recording: FakeRecording;
let sweeper: RecordingRetrySweeper;

beforeEach(() => {
  sessions = new FakeSessions();
  recording = new FakeRecording();
  sweeper = new RecordingRetrySweeper(
    sessions as never,
    recording as unknown as RecordingService,
    createLogger({ level: 'silent' }),
    false,
  );
});

describe('a call with nothing recording it', () => {
  it('gets a recording started', async () => {
    sessions.stalled = [call(SESSION)];

    const result = await sweeper.sweep();

    expect(recording.attempts).toEqual([SESSION]);
    expect(result).toEqual({ found: 1, started: 1, failed: 0 });
  });

  it('takes several in one pass', async () => {
    sessions.stalled = [call(SESSION), call(OTHER)];
    const result = await sweeper.sweep();
    expect(result.started).toBe(2);
  });
});

describe('a call that is still failing', () => {
  it('is counted, and will be found again next pass', async () => {
    sessions.stalled = [call(SESSION)];
    recording.outcome = RecordingOutcome.FAILED;

    const result = await sweeper.sweep();

    expect(result).toEqual({ found: 1, started: 0, failed: 1 });
  });

  /**
   * Nothing counts attempts. A session qualifies only while it is `IN_CALL`
   * with a `CALL_STARTED` and no `EGRESS_STARTED`, so a call that ends stops
   * being retried and a call that records drops out — the query is the bound.
   */
  it('is retried on the next pass', async () => {
    sessions.stalled = [call(SESSION)];
    recording.outcome = RecordingOutcome.FAILED;

    await sweeper.sweep();
    await sweeper.sweep();

    expect(recording.attempts).toEqual([SESSION, SESSION]);
  });

  it('counts a session with no room as failed rather than started', async () => {
    sessions.stalled = [call(SESSION)];
    recording.outcome = RecordingOutcome.NO_ROOM;

    expect((await sweeper.sweep()).failed).toBe(1);
  });
});

describe('a race with the original attempt', () => {
  /**
   * The webhook's own start and a retry pass can overlap. The service refuses
   * the second, and that is a success — the call is being recorded.
   */
  it('is not counted as a failure', async () => {
    sessions.stalled = [call(SESSION)];
    recording.outcome = RecordingOutcome.ALREADY_RUNNING;

    const result = await sweeper.sweep();

    expect(result).toEqual({ found: 1, started: 0, failed: 0 });
  });
});

describe('an empty pass', () => {
  it('reports zeros and starts nothing', async () => {
    await expect(sweeper.sweep()).resolves.toEqual({ found: 0, started: 0, failed: 0 });
    expect(recording.attempts).toEqual([]);
  });
});

describe('the batch', () => {
  it('is bounded, so one pass costs the batch and not the backlog', async () => {
    sessions.stalled = Array.from({ length: RECORDING_RETRY_BATCH + 10 }, (_, i) =>
      call(`${i}`.padStart(8, '0') + '-2222-4222-8222-222222222222'),
    );

    const result = await sweeper.sweep();

    expect(sessions.askedFor).toEqual([RECORDING_RETRY_BATCH]);
    expect(result.found).toBe(RECORDING_RETRY_BATCH);
  });
});

describe('the timer', () => {
  it('does not run unless it is enabled', () => {
    // Test modules build their own graph and leave it off, so no pass fires
    // between cases.
    expect(
      new RecordingRetrySweeper(
        sessions as never,
        recording as unknown as RecordingService,
        createLogger({ level: 'silent' }),
      ),
    ).toBeDefined();
    expect(recording.attempts).toEqual([]);
  });
});
