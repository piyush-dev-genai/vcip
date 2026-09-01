/**
 * The realtime fan-out, behind a port (T27).
 *
 * Redis Pub/Sub, so a notification published on one API instance reaches a
 * client connected to another. That is not a future concern to be retrofitted:
 * a gateway that only delivers to sockets on its own process is correct on one
 * instance and silently wrong on two, and the failure mode — some customers
 * never hear anything — is invisible in development.
 *
 * **Pub/Sub is fire-and-forget, and that is the right shape here.** A message
 * published while nobody is subscribed is dropped, with no queue and no replay.
 * For a notification transport that is exactly correct (contract §33.11): a
 * client that was not connected finds out by reading. Anything durable would be
 * a second source of truth, which is the thing the design forbids.
 *
 * A port, so the gateway and the publisher can be tested without a Redis, and
 * so the one place that knows the transport is this file.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { RealtimeMessage } from '@vcip/shared';
import { InjectRedis } from '../common/redis/redis.tokens.js';

/** Called with each message arriving on a subscribed channel. */
export type ChannelListener = (channel: string, message: RealtimeMessage) => void;

export interface RealtimeTransport {
  /** Send one message to whoever is listening on `channel`, if anyone is. */
  publish(channel: string, message: RealtimeMessage): Promise<void>;

  /**
   * Start listening on a channel.
   *
   * Reference-counted by the caller's use: subscribing twice to the same
   * channel is safe and the second call is a no-op on the wire.
   */
  subscribe(channel: string): Promise<void>;

  /** Stop listening. Safe to call for a channel that is not subscribed. */
  unsubscribe(channel: string): Promise<void>;

  /** Register the sink for every subscribed channel. Called once, at startup. */
  onMessage(listener: ChannelListener): void;
}

export const REALTIME_TRANSPORT = Symbol('REALTIME_TRANSPORT');

export const InjectRealtimeTransport = (): ParameterDecorator => Inject(REALTIME_TRANSPORT);

@Injectable()
export class RedisRealtimeTransport implements RealtimeTransport {
  /**
   * A second connection, because a Redis client in subscriber mode may not run
   * ordinary commands. `duplicate()` copies the configured URL and database, so
   * the subscriber cannot drift onto a different db than the publisher (D2).
   */
  private readonly subscriber: Redis;

  private listener: ChannelListener | null = null;

  /** Channels currently subscribed, so repeat calls do not re-issue commands. */
  private readonly subscribed = new Set<string>();

  constructor(@InjectRedis() private readonly redis: Redis) {
    this.subscriber = redis.duplicate();
    this.subscriber.on('message', (channel: string, raw: string) => {
      if (this.listener === null) return;
      let parsed: RealtimeMessage;
      try {
        parsed = JSON.parse(raw) as RealtimeMessage;
      } catch {
        // A message this process cannot parse is one it must not act on. Redis
        // is shared infrastructure and another writer could publish anything.
        return;
      }
      this.listener(channel, parsed);
    });
  }

  onMessage(listener: ChannelListener): void {
    this.listener = listener;
  }

  async publish(channel: string, message: RealtimeMessage): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string): Promise<void> {
    if (this.subscribed.has(channel)) return;
    await this.subscriber.subscribe(channel);
    this.subscribed.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    if (!this.subscribed.has(channel)) return;
    await this.subscriber.unsubscribe(channel);
    this.subscribed.delete(channel);
  }

  /** Closes the second connection. The application's own client is not ours. */
  async onApplicationShutdown(): Promise<void> {
    await this.subscriber.quit();
  }
}
