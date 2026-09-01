import { describe, expect, it } from 'vitest';
import {
  CallPhase,
  callReducer,
  callStatusText,
  canJoin,
  initialCallState,
  isBusy,
  isLive,
} from './call-state';
import type { CallEvent, CallState } from './call-state';

/** Drive the reducer through a sequence, so tests read as stories. */
const run = (...events: readonly CallEvent[]): CallState =>
  events.reduce(callReducer, initialCallState);

const JOIN: CallEvent = { kind: 'join' };
const READY: CallEvent = { kind: 'token_ready' };
const CONNECTED: CallEvent = { kind: 'connected' };

/** The happy path, as a reusable prefix. */
const live = (): CallState => run(JOIN, READY, CONNECTED);

const ALL_EVENTS: readonly CallEvent[] = [
  { kind: 'join' },
  { kind: 'token_ready' },
  { kind: 'token_failed', message: 'no' },
  { kind: 'connected' },
  { kind: 'connect_failed', message: 'no' },
  { kind: 'reconnecting' },
  { kind: 'reconnected' },
  { kind: 'disconnected' },
  { kind: 'leave' },
];

const ALL_PHASES: readonly CallPhase[] = Object.values(CallPhase);

describe('the happy path', () => {
  it('starts idle', () => {
    expect(initialCallState.phase).toBe(CallPhase.IDLE);
    expect(initialCallState.hasConnected).toBe(false);
  });

  it('goes idle -> token -> connecting -> live', () => {
    expect(run(JOIN).phase).toBe(CallPhase.REQUESTING_TOKEN);
    expect(run(JOIN, READY).phase).toBe(CallPhase.CONNECTING);
    expect(live().phase).toBe(CallPhase.LIVE);
  });

  it('records that it has connected, which is what tells a drop from a failure', () => {
    expect(live().hasConnected).toBe(true);
  });

  it('clears any earlier error once live', () => {
    const state = run(JOIN, { kind: 'token_failed', message: 'boom' }, JOIN, READY, CONNECTED);
    expect(state.phase).toBe(CallPhase.LIVE);
    expect(state.error).toBeNull();
  });
});

describe('failures before the call ever connected', () => {
  it('a token failure is FAILED and keeps the reason', () => {
    const state = run(JOIN, { kind: 'token_failed', message: 'no credentials' });
    expect(state.phase).toBe(CallPhase.FAILED);
    expect(state.error).toBe('no credentials');
  });

  it('a connect failure is FAILED and keeps the reason', () => {
    const state = run(JOIN, READY, { kind: 'connect_failed', message: 'no camera' });
    expect(state.phase).toBe(CallPhase.FAILED);
    expect(state.error).toBe('no camera');
  });

  /**
   * The distinction the whole reducer exists for. A disconnect before any
   * connection is a failure to connect; the same event after a live call is
   * the call ending, and only the first should put an error on the screen.
   */
  it('a disconnect that was never a connection is FAILED, not ENDED', () => {
    const state = run(JOIN, READY, { kind: 'disconnected' });
    expect(state.phase).toBe(CallPhase.FAILED);
    expect(state.error).not.toBeNull();
  });

  it('a disconnect after a live call is ENDED, with no error', () => {
    const state = callReducer(live(), { kind: 'disconnected' });
    expect(state.phase).toBe(CallPhase.ENDED);
    expect(state.error).toBeNull();
  });
});

describe('reconnection', () => {
  it('a live call that drops goes to RECONNECTING and back', () => {
    const dropped = callReducer(live(), { kind: 'reconnecting' });
    expect(dropped.phase).toBe(CallPhase.RECONNECTING);
    expect(callReducer(dropped, { kind: 'reconnected' }).phase).toBe(CallPhase.LIVE);
  });

  it('accepts a plain connected as a completed recovery', () => {
    const dropped = callReducer(live(), { kind: 'reconnecting' });
    expect(callReducer(dropped, CONNECTED).phase).toBe(CallPhase.LIVE);
  });

  /**
   * The SDK retries internally while first connecting. Showing "reconnecting"
   * for a call that has never connected would be telling the customer
   * something untrue about a connection they never had.
   */
  it('ignores reconnecting while still connecting for the first time', () => {
    expect(run(JOIN, READY, { kind: 'reconnecting' }).phase).toBe(CallPhase.CONNECTING);
  });

  it('a reconnect that gives up is ENDED, because the call had existed', () => {
    const dropped = callReducer(live(), { kind: 'reconnecting' });
    expect(callReducer(dropped, { kind: 'disconnected' }).phase).toBe(CallPhase.ENDED);
  });
});

describe('joining is guarded', () => {
  it('is allowed from idle, ended, and failed', () => {
    expect(canJoin(initialCallState)).toBe(true);
    expect(canJoin(callReducer(live(), { kind: 'leave' }))).toBe(true);
    expect(canJoin(run(JOIN, { kind: 'token_failed', message: 'x' }))).toBe(true);
  });

  it('is refused while a connection is already being made', () => {
    expect(canJoin(run(JOIN))).toBe(false);
    expect(canJoin(run(JOIN, READY))).toBe(false);
    expect(canJoin(live())).toBe(false);
  });

  it('a second join during connecting changes nothing', () => {
    const connecting = run(JOIN, READY);
    expect(callReducer(connecting, JOIN)).toBe(connecting);
  });

  it('a retry after a failure keeps the memory of having connected', () => {
    const ended = callReducer(live(), { kind: 'disconnected' });
    expect(callReducer(ended, JOIN).hasConnected).toBe(true);
  });
});

describe('leaving', () => {
  it('ends the call from any phase', () => {
    for (const prefix of [[], [JOIN], [JOIN, READY], [JOIN, READY, CONNECTED]]) {
      const state = callReducer(run(...prefix), { kind: 'leave' });
      expect(state.phase).toBe(CallPhase.ENDED);
      expect(state.error).toBeNull();
    }
  });
});

describe('the reducer is total', () => {
  /**
   * Every (phase, event) pair returns a state. Events genuinely arrive out of
   * order — LiveKit can report `reconnecting` while a disconnect is already in
   * flight — and a reducer that threw on those would turn a recoverable blip
   * into a crashed screen.
   */
  it('never throws and always returns a valid phase', () => {
    const reachable: CallState[] = [
      initialCallState,
      run(JOIN),
      run(JOIN, READY),
      live(),
      callReducer(live(), { kind: 'reconnecting' }),
      callReducer(live(), { kind: 'leave' }),
      run(JOIN, { kind: 'token_failed', message: 'x' }),
    ];

    for (const state of reachable) {
      for (const event of ALL_EVENTS) {
        const next = callReducer(state, event);
        expect(ALL_PHASES).toContain(next.phase);
      }
    }
  });

  it('carries an error only while FAILED', () => {
    const reachable = [initialCallState, run(JOIN), run(JOIN, READY), live()];
    for (const state of reachable) {
      for (const event of ALL_EVENTS) {
        const next = callReducer(state, event);
        if (next.phase !== CallPhase.FAILED) expect(next.error).toBeNull();
      }
    }
  });
});

describe('what the screen is told', () => {
  it('says video only while live', () => {
    expect(isLive(live())).toBe(true);
    expect(isLive(run(JOIN, READY))).toBe(false);
    expect(isLive(callReducer(live(), { kind: 'reconnecting' }))).toBe(false);
  });

  it('is busy while getting or keeping a connection', () => {
    expect(isBusy(run(JOIN))).toBe(true);
    expect(isBusy(run(JOIN, READY))).toBe(true);
    expect(isBusy(callReducer(live(), { kind: 'reconnecting' }))).toBe(true);
    expect(isBusy(live())).toBe(false);
    expect(isBusy(initialCallState)).toBe(false);
  });

  it('has a line for every phase, and never an empty one', () => {
    for (const phase of ALL_PHASES) {
      const text = callStatusText({ phase, error: null, hasConnected: false });
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('shows the failure reason when there is one', () => {
    expect(callStatusText(run(JOIN, { kind: 'token_failed', message: 'the reason' }))).toBe(
      'the reason',
    );
  });

  it('never leaks a LiveKit term into customer-facing text', () => {
    for (const phase of ALL_PHASES) {
      const text = callStatusText({ phase, error: null, hasConnected: false });
      expect(text).not.toMatch(/livekit|signal|ice|sfu|webrtc|track/i);
    }
  });
});
