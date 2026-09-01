import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionRegistry } from './connection-registry.js';

/** Sockets are opaque handles here; the registry never writes to one. */
const socket = (name: string): { name: string } => ({ name });

let registry: ConnectionRegistry<{ name: string }>;

beforeEach(() => {
  registry = new ConnectionRegistry();
});

describe('adding a connection', () => {
  it('reports the channels that became newly interesting', () => {
    expect(registry.add(socket('a'), ['rt:one', 'rt:two'])).toEqual({
      opened: ['rt:one', 'rt:two'],
      closed: [],
    });
  });

  /**
   * The reference count. Several agents in a tenant hold the same language
   * channel, and only the first arrival should open a Redis subscription.
   */
  it('opens a channel only for its first listener', () => {
    registry.add(socket('a'), ['rt:queue']);
    expect(registry.add(socket('b'), ['rt:queue'])).toEqual({ opened: [], closed: [] });
  });

  it('lists both listeners for a shared channel', () => {
    const a = socket('a');
    const b = socket('b');
    registry.add(a, ['rt:queue']);
    registry.add(b, ['rt:queue']);
    expect(registry.listeners('rt:queue')).toEqual([a, b]);
  });

  it('ignores a second registration of the same socket', () => {
    const a = socket('a');
    registry.add(a, ['rt:one']);
    expect(registry.add(a, ['rt:two'])).toEqual({ opened: [], closed: [] });
    expect(registry.listeners('rt:two')).toEqual([]);
  });
});

describe('removing a connection', () => {
  it('closes a channel only when its last listener goes', () => {
    const a = socket('a');
    const b = socket('b');
    registry.add(a, ['rt:queue']);
    registry.add(b, ['rt:queue']);

    expect(registry.remove(a)).toEqual({ opened: [], closed: [] });
    expect(registry.remove(b)).toEqual({ opened: [], closed: ['rt:queue'] });
  });

  it('stops delivering to a socket that has gone', () => {
    const a = socket('a');
    registry.add(a, ['rt:one']);
    registry.remove(a);
    expect(registry.listeners('rt:one')).toEqual([]);
  });

  it('closes every channel a departing socket held alone', () => {
    registry.add(socket('a'), ['rt:one', 'rt:two', 'rt:three']);
    const departed = registry.sockets()[0];
    expect(registry.remove(departed!).closed).toEqual(['rt:one', 'rt:two', 'rt:three']);
  });

  /**
   * A handshake can fail after the connection event and before registration,
   * so the disconnect handler must tolerate a socket it never saw.
   */
  it('tolerates a socket that was never added', () => {
    expect(registry.remove(socket('ghost'))).toEqual({ opened: [], closed: [] });
  });

  it('is idempotent', () => {
    const a = socket('a');
    registry.add(a, ['rt:one']);
    registry.remove(a);
    expect(registry.remove(a)).toEqual({ opened: [], closed: [] });
  });
});

describe('counts', () => {
  it('tracks connections and channels', () => {
    registry.add(socket('a'), ['rt:one', 'rt:shared']);
    registry.add(socket('b'), ['rt:two', 'rt:shared']);

    expect(registry.connectionCount).toBe(2);
    expect(registry.channelCount).toBe(3);
  });

  it('returns to zero when everyone leaves', () => {
    const a = socket('a');
    registry.add(a, ['rt:one']);
    registry.remove(a);

    expect(registry.connectionCount).toBe(0);
    expect(registry.channelCount).toBe(0);
  });
});

describe('lookups', () => {
  it('returns nothing for a channel nobody holds', () => {
    expect(registry.listeners('rt:nobody')).toEqual([]);
  });

  it('answers whether a socket is registered', () => {
    const a = socket('a');
    expect(registry.has(a)).toBe(false);
    registry.add(a, ['rt:one']);
    expect(registry.has(a)).toBe(true);
  });

  it('hands back a copy, so a caller cannot mutate the registry', () => {
    const a = socket('a');
    registry.add(a, ['rt:one']);
    const listeners = registry.listeners('rt:one') as { name: string }[];
    listeners.pop();
    expect(registry.listeners('rt:one')).toEqual([a]);
  });
});
