import { SESSION_STATUSES, SessionStatus } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import {
  RECORDING_LAYOUT,
  RECORDING_RETRY_BATCH,
  RECORDING_RETRY_INTERVAL_MS,
  mayRecord,
  recordingKeyFor,
} from './recording.rules.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

describe('recordingKeyFor', () => {
  it('derives the key from the session id alone', () => {
    expect(recordingKeyFor(SESSION)).toBe(`raw/${SESSION}.mp4`);
  });

  /**
   * The Day-0 spike used LiveKit's `{room_name}-{time}` template. A time
   * component would make the key undiscoverable from the session id, and would
   * silently permit two files for one session — R17 is one composite file per
   * session.
   */
  it('carries no timestamp, so one session records to one key', () => {
    expect(recordingKeyFor(SESSION)).toBe(recordingKeyFor(SESSION));
    expect(recordingKeyFor(SESSION)).not.toMatch(/\{|\}/);
  });

  it('gives two sessions two keys', () => {
    expect(recordingKeyFor(SESSION)).not.toBe(
      recordingKeyFor('22222222-2222-4222-8222-222222222222'),
    );
  });

  it('is recomputable, which is what lets T38 find the file', () => {
    // No lookup, no listing: the key is a function of the id.
    const recomputed = recordingKeyFor(SESSION);
    expect(recomputed).toContain(SESSION);
    expect(recomputed.endsWith('.mp4')).toBe(true);
  });
});

describe('mayRecord', () => {
  /**
   * `IN_CALL` only, and the reason is not policy but physics: LiveKit refuses
   * room-composite egress on a room nobody has joined, which is why the plan's
   * "recording start on accept" is not implementable.
   */
  it('permits a call that is under way', () => {
    expect(mayRecord(SessionStatus.IN_CALL)).toBe(true);
  });

  it('permits nothing else', () => {
    for (const status of SESSION_STATUSES.filter((s) => s !== SessionStatus.IN_CALL)) {
      expect(mayRecord(status)).toBe(false);
    }
  });

  it('refuses OFFERED, which is the state an accept moves out of', () => {
    // At accept the room does not exist yet; there is nothing to record.
    expect(mayRecord(SessionStatus.OFFERED)).toBe(false);
  });

  it('refuses every terminal status', () => {
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(mayRecord(status)).toBe(false);
    }
  });
});

describe('the composite layout', () => {
  /**
   * R17: both participants, one file, better evidence. `speaker` would shrink
   * whoever is not talking, and a document held up in silence is exactly the
   * frame that must not be the small one.
   */
  it('is grid, so neither participant is shrunk', () => {
    expect(RECORDING_LAYOUT).toBe('grid');
  });
});

describe('the retry pass', () => {
  it('is bounded', () => {
    expect(RECORDING_RETRY_BATCH).toBeGreaterThan(0);
    expect(RECORDING_RETRY_BATCH).toBeLessThanOrEqual(50);
  });

  it('runs often enough to recover inside a call', () => {
    // A verification lasts minutes; ten seconds gives many attempts.
    expect(RECORDING_RETRY_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});
