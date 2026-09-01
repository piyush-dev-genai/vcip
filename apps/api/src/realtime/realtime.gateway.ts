/**
 * `GET /v1/ws` — the WebSocket gateway (T27, D9).
 *
 * Native `ws`, not Socket.IO: the contract names a plain URL with a query
 * parameter, and Socket.IO owns its own handshake path and protocol.
 *
 * Four responsibilities and no others.
 *
 * **Authenticate the handshake.** Every connection's scope is derived from the
 * verified token by `handshake.ts` and from nothing the client sends. A socket
 * that fails is closed with 4401 before it is registered anywhere.
 *
 * **Register the connection against the channels its scope entitles it to.**
 * That is where isolation lives: a customer holds one session channel, an agent
 * holds their own plus one per configured language. Delivery to the wrong
 * recipient is not prevented by a filter — it is prevented because no socket is
 * listening.
 *
 * **Route what Redis delivers.** One subscription per channel with a listener,
 * opened on the first arrival and closed on the last departure.
 *
 * **Notice dead sockets.** A browser that vanishes without closing leaves a
 * socket that looks open forever; ping/pong is what reclaims it.
 *
 * What it never does: mutate business state, accept a message that means
 * anything, or become a source of truth (contract §33.11). The gateway is
 * write-only towards the client. It defines no `@SubscribeMessage` handler, so
 * a client that sends anything is ignored — subscriptions are decided here from
 * the token, and a protocol that let a client ask for a channel would be the
 * whole isolation problem.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { WebSocketGateway } from '@nestjs/websockets';
import type { RealtimeMessage } from '@vcip/shared';
import { RealtimeAudience, mayReceive } from '@vcip/shared';
import type { IncomingMessage } from 'node:http';
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import type { AgentRepository } from '../agents/agent.repository.js';
import { InjectAgentRepository } from '../agents/agent.repository.js';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { InjectAuthConfig } from '../common/auth/auth.config.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { ConnectionRegistry } from './connection-registry.js';
import type { VerifiedScope } from './handshake.js';
import { WS_CLOSE_UNAUTHORIZED, authenticate, redactUrl } from './handshake.js';
import type { ConnectionScope } from './realtime.keys.js';
import { channelsFor } from './realtime.keys.js';
import type { RealtimeTransport } from './realtime.transport.js';
import { InjectRealtimeTransport } from './realtime.transport.js';

/**
 * How often the server pings, and therefore how long a dead socket lingers.
 *
 * Fifteen seconds, with one missed pong tolerated: a connection is reclaimed
 * within about thirty. Fast enough that a vanished browser does not hold a
 * registration through a whole verification, slow enough to survive the pause a
 * backgrounded mobile tab takes.
 */
export const WS_PING_INTERVAL_MS = 15_000;

/**
 * Optional override for the ping cadence.
 *
 * A token, for the reason the sweepers have clock tokens: proving that a socket
 * which stops answering is reclaimed should not take thirty seconds of real
 * time, and a test that slept that long would be a test nobody runs.
 */
export const WS_PING_INTERVAL = Symbol('WS_PING_INTERVAL');

/** Marks whether the last ping was answered. Kept off the socket's own type. */
interface Liveness {
  alive: boolean;
}

@Injectable()
@WebSocketGateway({ path: '/v1/ws' })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly registry = new ConnectionRegistry<WebSocket>();
  private readonly liveness = new WeakMap<WebSocket, Liveness>();
  private readonly audiences = new WeakMap<WebSocket, RealtimeAudience>();
  private pinger: NodeJS.Timeout | null = null;

  constructor(
    @InjectRealtimeTransport() private readonly transport: RealtimeTransport,
    @InjectAuthConfig() private readonly config: AuthConfig,
    @InjectAgentRepository() private readonly agents: AgentRepository,
    @InjectLogger() private readonly logger: Logger,
    @Optional()
    @Inject(WS_PING_INTERVAL)
    private readonly pingIntervalMs: number = WS_PING_INTERVAL_MS,
  ) {}

  afterInit(): void {
    // One sink for every subscribed channel. Registered once: the transport
    // holds a single subscriber connection and fans out from it.
    this.transport.onMessage((channel, message) => {
      this.deliver(channel, message);
    });

    this.pinger = setInterval(() => {
      this.sweepDeadConnections();
    }, this.pingIntervalMs);
    this.pinger.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pinger !== null) clearInterval(this.pinger);
    this.pinger = null;
  }

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    const result = authenticate(request.url, this.config.wsTokenSecret);

    if (!result.ok) {
      this.logger.info(
        // The URL is redacted here and everywhere else it is logged: D9 puts a
        // credential in the query string, and a refusal is exactly the line an
        // operator reads.
        { event: 'ws.handshake.refused', reason: result.reason, url: redactUrl(request.url) },
        'websocket handshake refused',
      );
      client.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const scope = await this.completeScope(result.scope);
    const channels = channelsFor(scope);

    const { opened } = this.registry.add(client, channels);
    this.audiences.set(client, scope.audience);
    this.liveness.set(client, { alive: true });
    client.on('pong', () => {
      const state = this.liveness.get(client);
      if (state !== undefined) state.alive = true;
    });

    for (const channel of opened) {
      try {
        await this.transport.subscribe(channel);
      } catch (error) {
        // The connection stays open. It will hear nothing on this channel until
        // a later connection reopens it, and REST remains the recovery path —
        // closing the socket would take away the client's other channels too.
        this.logger.error(
          { event: 'ws.subscribe_failed', channel, err: error },
          'could not subscribe to a channel for a connected client',
        );
      }
    }

    this.logger.info(
      {
        event: 'ws.connected',
        audience: scope.audience,
        tenant_id: scope.tenantId,
        channels: channels.length,
        connections: this.registry.connectionCount,
      },
      'websocket connected',
    );
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const { closed } = this.registry.remove(client);
    for (const channel of closed) {
      try {
        await this.transport.unsubscribe(channel);
      } catch (error) {
        this.logger.warn(
          { event: 'ws.unsubscribe_failed', channel, err: error },
          'could not unsubscribe a channel with no listeners left',
        );
      }
    }
    this.logger.info(
      { event: 'ws.disconnected', connections: this.registry.connectionCount },
      'websocket disconnected',
    );
  }

  /**
   * Fill in the parts of a scope that are not in the token.
   *
   * An agent's languages are read from `agent_profiles` at connect time rather
   * than carried in the credential, so an operator who changes a profile does
   * not have to wait for a token to expire. A profile that cannot be read
   * yields no languages: the agent still receives their own events and simply
   * hears nothing from the queue, which is a degraded connection rather than a
   * refused one.
   */
  private async completeScope(scope: VerifiedScope): Promise<ConnectionScope> {
    if (scope.audience === RealtimeAudience.CUSTOMER) return scope;

    const agent = scope;
    try {
      const profile = await this.agents.findProfile(agent.userId, agent.tenantId);
      return { ...agent, languages: profile?.languages ?? [] };
    } catch (error) {
      this.logger.warn(
        { event: 'ws.profile_unavailable', tenant_id: agent.tenantId, err: error },
        'connected an agent with no queue channels: their profile could not be read',
      );
      return { ...agent, languages: [] };
    }
  }

  /**
   * Write one message to every socket entitled to it.
   *
   * The audience check is a second lock on a door the channel already closed:
   * only agent sockets hold an agent channel, so an agent event cannot reach a
   * customer. It is asserted anyway, because "no customer is subscribed to that
   * channel" is a property of code elsewhere, and the cost of confirming it
   * here is one array lookup.
   */
  private deliver(channel: string, message: RealtimeMessage): void {
    const payload = JSON.stringify(message);

    for (const socket of this.registry.listeners(channel)) {
      const audience = this.audiences.get(socket);
      if (audience === undefined || !mayReceive(audience, message.event)) {
        this.logger.error(
          { event: 'ws.audience_mismatch', channel, notification: message.event },
          'refused to deliver an event to the wrong audience',
        );
        continue;
      }
      try {
        socket.send(payload);
      } catch (error) {
        this.logger.warn(
          { event: 'ws.send_failed', channel, err: error },
          'could not write to a connected client',
        );
      }
    }
  }

  /**
   * Terminate sockets that did not answer the last ping.
   *
   * `terminate()` rather than `close()`: a socket that is not answering is not
   * going to complete a closing handshake either, and waiting for one is how
   * dead connections accumulate.
   */
  private sweepDeadConnections(): void {
    for (const socket of this.registry.sockets()) {
      const state = this.liveness.get(socket);
      if (state === undefined) continue;

      if (!state.alive) {
        this.logger.info(
          { event: 'ws.dead_connection' },
          'terminating a connection that did not answer a ping',
        );
        socket.terminate();
        continue;
      }

      state.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }
}
