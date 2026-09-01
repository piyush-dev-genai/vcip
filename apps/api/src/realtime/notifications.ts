/**
 * How a business module tells a client something happened (T27).
 *
 * This is the whole surface the rest of the application sees. `QueueService`
 * calls `queuePosition(...)`; the claim calls `sessionOffered(...)`; T26's
 * lifecycle calls `agentJoined(...)`. None of them imports a socket, a gateway,
 * or Redis, and none of them decides who receives anything — they say what
 * happened, and routing is `realtime.keys.ts`.
 *
 * **Publishing never fails a business operation.** Every method here swallows
 * its errors and logs. A notification is not the source of truth (contract
 * §33.11): a customer who misses `session.assigned` finds out from the next
 * REST read, whereas a claim that rolled back because Redis hiccuped would have
 * cost someone their place in the queue. The transaction has already committed
 * by the time any of this is called, and nothing here may reach back into it.
 *
 * **T27 owns transport, not timing.** Each call sits at a decision point that
 * already existed — the same statement that moved the session is what publishes
 * — so no business logic moved into this module and none of these methods
 * decides *whether* something happened.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { SessionStatus } from '@vcip/shared';
import { AgentEvent, CustomerEvent } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { RealtimeTransport } from './realtime.transport.js';
import { InjectRealtimeTransport } from './realtime.transport.js';
import { agentChannel, queueChannel, sessionChannel } from './realtime.keys.js';

/**
 * The notifications the application can send.
 *
 * Named for the business fact rather than for the wire event, so a call site
 * reads as what happened. One method per producer, and the argument lists are
 * deliberately narrow: a method that took a whole session row would invite a
 * payload that carries customer data.
 */
export interface Notifications {
  /** T15: this customer joined the queue and stands at `position`. */
  queuePosition(sessionId: string, position: number | null): Promise<void>;

  /** T15: a session an agent of this language could work is waiting. */
  queueNewSession(tenantId: string, language: string, sessionId: string): Promise<void>;

  /** T18: an agent was offered this session. */
  sessionOffered(sessionId: string): Promise<void>;

  /** T18: the session an agent tried for went to somebody else. */
  sessionClaimedElsewhere(tenantId: string, userId: string, sessionId: string): Promise<void>;

  /** T20: an offer this agent held lapsed. */
  sessionOfferExpired(tenantId: string, userId: string, sessionId: string): Promise<void>;

  /** T19: an agent accepted; the session is `IN_CALL`. */
  sessionAssigned(sessionId: string, tenantId: string, userId: string): Promise<void>;

  /** T26: the agent's participant is in the room. */
  agentJoined(sessionId: string): Promise<void>;

  /** Any status change worth telling the customer about. */
  sessionUpdated(sessionId: string, status: SessionStatus): Promise<void>;

  /**
   * A session ended.
   *
   * Both audiences are told, because both have a screen to leave: the customer
   * sees the outcome, the agent's portal releases the work.
   */
  sessionCompleted(
    sessionId: string,
    status: SessionStatus,
    verdict: string | null,
    agent: { readonly tenantId: string; readonly userId: string } | null,
  ): Promise<void>;
}

export const NOTIFICATIONS = Symbol('NOTIFICATIONS');

export const InjectNotifications = (): ParameterDecorator => Inject(NOTIFICATIONS);

@Injectable()
export class TransportNotifications implements Notifications {
  constructor(
    @InjectRealtimeTransport() private readonly transport: RealtimeTransport,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /**
   * Publish, and never let it matter.
   *
   * The one place errors are swallowed, so no call site has to remember to.
   */
  private async send(channel: string, event: string, data: unknown): Promise<void> {
    try {
      await this.transport.publish(channel, { event, data });
    } catch (error) {
      this.logger.warn(
        { event: 'realtime.publish_failed', notification: event, err: error },
        'a notification could not be published; the client will find out by polling',
      );
    }
  }

  async queuePosition(sessionId: string, position: number | null): Promise<void> {
    await this.send(sessionChannel(sessionId), CustomerEvent.QUEUE_POSITION, {
      session_id: sessionId,
      position,
    });
  }

  async queueNewSession(tenantId: string, language: string, sessionId: string): Promise<void> {
    // Targeted by language, not broadcast: only agents whose profile covers
    // this language hold the channel.
    await this.send(queueChannel(tenantId, language), AgentEvent.QUEUE_NEW_SESSION, {
      session_id: sessionId,
      language,
    });
  }

  async sessionOffered(sessionId: string): Promise<void> {
    await this.send(sessionChannel(sessionId), CustomerEvent.SESSION_OFFERED, {
      session_id: sessionId,
    });
  }

  async sessionClaimedElsewhere(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    await this.send(agentChannel(tenantId, userId), AgentEvent.SESSION_CLAIMED_ELSEWHERE, {
      session_id: sessionId,
    });
  }

  async sessionOfferExpired(tenantId: string, userId: string, sessionId: string): Promise<void> {
    await this.send(agentChannel(tenantId, userId), AgentEvent.SESSION_OFFER_EXPIRED, {
      session_id: sessionId,
    });
  }

  async sessionAssigned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    await this.send(sessionChannel(sessionId), CustomerEvent.SESSION_ASSIGNED, {
      session_id: sessionId,
    });
    await this.send(agentChannel(tenantId, userId), AgentEvent.SESSION_UPDATED, {
      session_id: sessionId,
      status: 'IN_CALL',
    });
  }

  async agentJoined(sessionId: string): Promise<void> {
    await this.send(sessionChannel(sessionId), CustomerEvent.AGENT_JOINED, {
      session_id: sessionId,
    });
  }

  async sessionUpdated(sessionId: string, status: SessionStatus): Promise<void> {
    await this.send(sessionChannel(sessionId), CustomerEvent.SESSION_UPDATED, {
      session_id: sessionId,
      status,
    });
  }

  async sessionCompleted(
    sessionId: string,
    status: SessionStatus,
    verdict: string | null,
    agent: { readonly tenantId: string; readonly userId: string } | null,
  ): Promise<void> {
    await this.send(sessionChannel(sessionId), CustomerEvent.SESSION_COMPLETED, {
      session_id: sessionId,
      status,
      verdict,
    });
    if (agent !== null) {
      await this.send(agentChannel(agent.tenantId, agent.userId), AgentEvent.SESSION_CANCELLED, {
        session_id: sessionId,
      });
    }
  }
}
