import { describe, expect, it } from 'vitest';
import { createHeartbeat } from './heartbeat';
import type { TimerHost } from './heartbeat';

/**
 * A timer host that runs nothing until a test says so.
 *
 * Deliberately not fake timers: the assertions are about handles being created
 * and cleared, and a substitute that records those makes "the loop stopped"
 * something the test can see directly rather than infer from a clock.
 */
class TestTimers implements TimerHost {
  private next = 1;
  readonly active = new Map<number, () => void>();
  cleared: number[] = [];

  setInterval(handler: () => void, _ms: number): unknown {
    const handle = this.next++;
    this.active.set(handle, handler);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle as number);
    this.active.delete(handle as number);
  }

  /** Fire every live timer once. */
  tick(): void {
    for (const handler of [...this.active.values()]) handler();
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createHeartbeat', () => {
  it('does not beat before it is started', () => {
    const timers = new TestTimers();
    let beats = 0;
    createHeartbeat({ timers, intervalMs: 5000, beat: async () => void beats++ });

    timers.tick();
    expect(beats).toBe(0);
    expect(timers.active.size).toBe(0);
  });

  it('beats once per tick while running', async () => {
    const timers = new TestTimers();
    let beats = 0;
    const heartbeat = createHeartbeat({
      timers,
      intervalMs: 5000,
      beat: async () => void beats++,
    });

    heartbeat.start();
    expect(heartbeat.running).toBe(true);

    timers.tick();
    await settle();
    timers.tick();
    await settle();

    expect(beats).toBe(2);
  });

  it('stops beating when stopped', async () => {
    const timers = new TestTimers();
    let beats = 0;
    const heartbeat = createHeartbeat({
      timers,
      intervalMs: 5000,
      beat: async () => void beats++,
    });

    heartbeat.start();
    timers.tick();
    await settle();
    heartbeat.stop();

    timers.tick();
    await settle();

    // The timer is gone, not merely inert: an unmounted portal must leave
    // nothing behind that could re-arm a TTL.
    expect(beats).toBe(1);
    expect(heartbeat.running).toBe(false);
    expect(timers.active.size).toBe(0);
    expect(timers.cleared).toHaveLength(1);
  });

  it('starts at most one timer however often start is called', () => {
    const timers = new TestTimers();
    const heartbeat = createHeartbeat({ timers, intervalMs: 5000, beat: async () => undefined });

    heartbeat.start();
    heartbeat.start();
    heartbeat.start();

    // React strict mode runs effects twice in development; a second timer
    // would double the traffic and nobody would notice.
    expect(timers.active.size).toBe(1);
  });

  it('is safe to stop when never started, and to stop twice', () => {
    const timers = new TestTimers();
    const heartbeat = createHeartbeat({ timers, intervalMs: 5000, beat: async () => undefined });

    heartbeat.stop();
    heartbeat.start();
    heartbeat.stop();
    heartbeat.stop();

    expect(heartbeat.running).toBe(false);
    expect(timers.cleared).toHaveLength(1);
  });

  it('restarts cleanly', () => {
    const timers = new TestTimers();
    const heartbeat = createHeartbeat({ timers, intervalMs: 5000, beat: async () => undefined });

    heartbeat.start();
    heartbeat.stop();
    heartbeat.start();

    expect(timers.active.size).toBe(1);
    expect(heartbeat.running).toBe(true);
  });

  it('reports a failed beat instead of throwing into the timer', async () => {
    const timers = new TestTimers();
    const seen: unknown[] = [];
    const heartbeat = createHeartbeat({
      timers,
      intervalMs: 5000,
      beat: () => Promise.reject(new Error('offline')),
      onError: (error) => seen.push(error),
    });

    heartbeat.start();
    timers.tick();
    await settle();

    expect(seen).toHaveLength(1);
    // A failed beat does not stop the loop: the 15-second TTL tolerates three
    // misses, so a blip should not drop an agent who is still there.
    expect(heartbeat.running).toBe(true);
  });

  it('survives a failing beat with no error handler', async () => {
    const timers = new TestTimers();
    const heartbeat = createHeartbeat({
      timers,
      intervalMs: 5000,
      beat: () => Promise.reject(new Error('offline')),
    });

    heartbeat.start();
    timers.tick();
    await settle();

    expect(heartbeat.running).toBe(true);
  });

  it('skips a tick while a beat is still in flight', async () => {
    const timers = new TestTimers();
    let started = 0;
    // Held in a one-element box rather than a `let`: TypeScript narrows a
    // variable only assigned inside a callback to `never` at the call site.
    const release: { resolve: (() => void) | null } = { resolve: null };
    const heartbeat = createHeartbeat({
      timers,
      intervalMs: 5000,
      beat: () => {
        started += 1;
        return new Promise<void>((resolve) => {
          release.resolve = resolve;
        });
      },
    });

    heartbeat.start();
    timers.tick();
    await settle();
    // A slow network or a waking laptop must not stack requests.
    timers.tick();
    timers.tick();
    await settle();
    expect(started).toBe(1);

    release.resolve?.();
    await settle();
    timers.tick();
    await settle();
    expect(started).toBe(2);
  });
});
