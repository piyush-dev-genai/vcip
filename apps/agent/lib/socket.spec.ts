import type { RealtimeMessage } from '@vcip/shared';
import { AgentEvent } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SocketLike } from './socket';
import {
  RECONNECT_DELAYS_MS,
  createRealtimeSocket,
  parseMessage,
  reconnectDelayMs,
  websocketUrl,
} from './socket';

/** A socket the test drives by hand. */
class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = 0;

  constructor(readonly url: string) {}

  close(): void {
    this.closed += 1;
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let opened: FakeSocket[];
let scheduled: { fn: () => void; delayMs: number }[];
let received: RealtimeMessage[];
let minted: number;

const build = (options: { mintFails?: boolean } = {}) => {
  opened = [];
  scheduled = [];
  received = [];
  minted = 0;

  return createRealtimeSocket({
    baseUrl: 'http://localhost:3001',
    mintToken: () => {
      minted += 1;
      return options.mintFails ? Promise.reject(new Error('401')) : Promise.resolve('a.ws.token');
    },
    onMessage: (message) => received.push(message),
    socketImpl: (url) => {
      const socket = new FakeSocket(url);
      opened.push(socket);
      return socket;
    },
    scheduleImpl: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
    },
  });
};

/** Let the queued `mintToken` promise resolve. */
const settle = (): Promise<void> => Promise.resolve().then(() => undefined);

describe('the websocket url', () => {
  it('is derived from the API base url', () => {
    expect(websocketUrl('http://localhost:3001', 'abc')).toBe(
      'ws://localhost:3001/v1/ws?token=abc',
    );
  });

  it('upgrades with the scheme, so a TLS API gets a TLS socket', () => {
    expect(websocketUrl('https://api.example.com', 'abc').startsWith('wss://')).toBe(true);
  });

  it('encodes the token, which is a credential in a query string (D9)', () => {
    expect(websocketUrl('http://localhost:3001', 'a b/c')).toContain('token=a%20b%2Fc');
  });

  it('tolerates a trailing slash on the base url', () => {
    expect(websocketUrl('http://localhost:3001/', 'abc')).toBe(
      'ws://localhost:3001/v1/ws?token=abc',
    );
  });
});

describe('reconnect backoff', () => {
  it('starts short, because most drops are a blip', () => {
    expect(reconnectDelayMs(0)).toBe(500);
  });

  it('backs off, so a dead API is not hammered by every open portal', () => {
    expect(reconnectDelayMs(1)).toBeGreaterThan(reconnectDelayMs(0));
    expect(reconnectDelayMs(3)).toBeGreaterThan(reconnectDelayMs(1));
  });

  it('keeps trying rather than giving up', () => {
    // A portal left open against a dead API should recover on its own, not
    // require a reload nobody knows to do.
    const last = RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    expect(reconnectDelayMs(99)).toBe(last);
  });
});

describe('reading a frame', () => {
  it('accepts a well-formed message', () => {
    expect(parseMessage(JSON.stringify({ event: 'ai.updated', data: { a: 1 } }))).toEqual({
      event: 'ai.updated',
      data: { a: 1 },
    });
  });

  it.each([
    ['not json', 'garbage'],
    ['no event', JSON.stringify({ data: {} })],
    ['no data', JSON.stringify({ event: 'ai.updated' })],
    ['an array', JSON.stringify([1, 2])],
    ['null', JSON.stringify(null)],
  ])('drops %s rather than throwing inside a socket callback', (_case, raw) => {
    expect(parseMessage(raw)).toBeNull();
  });

  it('drops a binary frame', () => {
    expect(parseMessage(new Uint8Array([1, 2]))).toBeNull();
  });
});

describe('the connection', () => {
  beforeEach(() => {
    build();
  });

  it('mints a fresh token for every attempt', async () => {
    // D9's token is short-lived and travels in a URL; keeping one would be
    // holding a credential longer than it is meant to live.
    const socket = build();
    socket.start();
    await settle();

    expect(minted).toBe(1);
    expect(opened[0]!.url).toContain('token=a.ws.token');
  });

  it('delivers messages to the handler', async () => {
    const socket = build();
    socket.start();
    await settle();

    opened[0]!.receive({ event: AgentEvent.AI_UPDATED, data: { session_id: 's1' } });

    expect(received).toEqual([{ event: AgentEvent.AI_UPDATED, data: { session_id: 's1' } }]);
  });

  it('reconnects when the socket closes', async () => {
    const socket = build();
    socket.start();
    await settle();

    opened[0]!.onclose?.();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(500);
  });

  it('backs off across repeated failures', async () => {
    const socket = build();
    socket.start();
    await settle();

    opened[0]!.onclose?.();
    scheduled[0]!.fn();
    await settle();
    opened[1]!.onclose?.();

    expect(scheduled[1]!.delayMs).toBeGreaterThan(scheduled[0]!.delayMs);
  });

  it('resets the backoff only once a connection actually opens', async () => {
    // A server that accepts and immediately drops would otherwise be retried
    // at the shortest delay forever.
    const socket = build();
    socket.start();
    await settle();

    opened[0]!.onclose?.();
    scheduled[0]!.fn();
    await settle();
    opened[1]!.onopen?.();
    opened[1]!.onclose?.();

    expect(scheduled[1]!.delayMs).toBe(500);
  });

  it('retries when the token cannot be minted', async () => {
    // Usually a session that ended rather than a network fault; either way the
    // answer is to wait and ask again, and nothing is shown to the agent.
    const socket = build({ mintFails: true });
    socket.start();
    await settle();
    await settle();

    expect(opened).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
  });

  it('stops for good when told', async () => {
    const socket = build();
    socket.start();
    await settle();

    socket.stop();

    expect(opened[0]!.closed).toBe(1);
    opened[0]!.onclose?.();
    expect(scheduled).toHaveLength(0);
  });

  it('does not reconnect after stopping, even from a queued retry', async () => {
    const socket = build();
    socket.start();
    await settle();
    opened[0]!.onclose?.();

    socket.stop();
    scheduled[0]!.fn();
    await settle();

    expect(opened).toHaveLength(1);
  });

  it('opens nothing if it is stopped while minting', async () => {
    // A socket opened after the screen has gone is a socket nobody closes.
    const socket = build();
    socket.start();
    socket.stop();
    await settle();

    expect(opened).toHaveLength(0);
  });
});
