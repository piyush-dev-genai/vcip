/**
 * Which sockets are listening on which channel (T27).
 *
 * Deliberately free of `ws`, Redis, and Nest: it is a bidirectional map with
 * reference counting, and that is worth testing without a server. The socket is
 * an opaque handle here — the registry never writes to one, so it cannot
 * accidentally deliver anything.
 *
 * The reference counting is the point. Several agents in one tenant subscribe
 * to the same language channel, so the first arrival must open the Redis
 * subscription and only the last departure may close it. Getting that wrong in
 * either direction is a real failure: too eager and an agent stops hearing
 * about queued sessions, too lazy and the process holds subscriptions for
 * connections that are long gone.
 */

/** What the registry reports when a channel's listener count reaches a bound. */
export interface ChannelDelta {
  /** Channels that now have their first listener and need subscribing. */
  readonly opened: readonly string[];
  /** Channels that lost their last listener and can be unsubscribed. */
  readonly closed: readonly string[];
}

const EMPTY: ChannelDelta = Object.freeze({ opened: [], closed: [] });

export class ConnectionRegistry<TSocket> {
  /** channel -> the sockets listening on it. */
  private readonly byChannel = new Map<string, Set<TSocket>>();

  /** socket -> the channels it holds, so a disconnect needs no scan. */
  private readonly bySocket = new Map<TSocket, readonly string[]>();

  /**
   * Register a socket against every channel its scope entitles it to.
   *
   * Returns the channels that became newly interesting, so the caller can
   * subscribe to exactly those.
   */
  add(socket: TSocket, channels: readonly string[]): ChannelDelta {
    if (this.bySocket.has(socket)) return EMPTY;

    const opened: string[] = [];
    for (const channel of channels) {
      const listeners = this.byChannel.get(channel);
      if (listeners === undefined) {
        this.byChannel.set(channel, new Set([socket]));
        opened.push(channel);
      } else {
        listeners.add(socket);
      }
    }
    this.bySocket.set(socket, [...channels]);

    return { opened, closed: [] };
  }

  /**
   * Forget a socket.
   *
   * Returns the channels nobody is listening on any more. Safe to call for a
   * socket that was never added — a handshake can fail after the connection
   * event and before registration.
   */
  remove(socket: TSocket): ChannelDelta {
    const channels = this.bySocket.get(socket);
    if (channels === undefined) return EMPTY;

    const closed: string[] = [];
    for (const channel of channels) {
      const listeners = this.byChannel.get(channel);
      if (listeners === undefined) continue;
      listeners.delete(socket);
      if (listeners.size === 0) {
        this.byChannel.delete(channel);
        closed.push(channel);
      }
    }
    this.bySocket.delete(socket);

    return { opened: [], closed };
  }

  /** The sockets entitled to a channel's messages. Empty for an unknown one. */
  listeners(channel: string): readonly TSocket[] {
    const found = this.byChannel.get(channel);
    return found === undefined ? [] : [...found];
  }

  /** Is this socket registered? */
  has(socket: TSocket): boolean {
    return this.bySocket.has(socket);
  }

  get connectionCount(): number {
    return this.bySocket.size;
  }

  get channelCount(): number {
    return this.byChannel.size;
  }

  /** Every registered socket, for shutdown. */
  sockets(): readonly TSocket[] {
    return [...this.bySocket.keys()];
  }
}
