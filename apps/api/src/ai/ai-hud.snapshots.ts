/**
 * What an agent's connection is owed the moment it opens (T31).
 *
 * The AI publishes every couple of seconds, so an agent who connects mid-call
 * would see a HUD soon enough — but "soon enough" is a blank panel for up to
 * two seconds on every page load and reconnect, and indistinguishable from an
 * AI that is not running at all. The gateway hands over what is already known
 * instead, and the stream takes over from there.
 *
 * A narrow port rather than the gateway querying for itself. T27 owns
 * transport and routing and should keep owning only that: it asks one question
 * — what does this connection already have coming to it — and forwards the
 * answers. Which sessions an agent holds and what a HUD contains are this
 * module's business.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AiHudPayload } from '@vcip/shared';
import { SessionStatus } from '@vcip/shared';
import type { Logger } from 'pino';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
import type { AiHudRepository } from './ai-hud.repository.js';
import { InjectAiHudRepository } from './ai-hud.repository.js';

export interface AiHudSnapshots {
  /**
   * The current HUD for every call this agent is on.
   *
   * Empty is the ordinary answer: an agent with no call, or a call the AI has
   * said nothing about yet. Never throws — a connection must not be refused
   * because a HUD could not be read.
   */
  forAgent(tenantId: string, userId: string): Promise<readonly AiHudPayload[]>;
}

export const AI_HUD_SNAPSHOTS = Symbol('AI_HUD_SNAPSHOTS');

export const InjectAiHudSnapshots = (): ParameterDecorator => Inject(AI_HUD_SNAPSHOTS);

@Injectable()
export class SessionAiHudSnapshots implements AiHudSnapshots {
  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectAiHudRepository() private readonly hud: AiHudRepository,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async forAgent(tenantId: string, userId: string): Promise<readonly AiHudPayload[]> {
    try {
      const work = await this.sessions.findActiveWork(tenantId, userId);
      // `IN_CALL` only. An `OFFERED` session has nobody in the room, so it has
      // no HUD worth having, and sending one would put an AI panel on a screen
      // where there is not yet a call.
      const calls = work.filter((row) => row.status === SessionStatus.IN_CALL);

      const huds = await Promise.all(calls.map((row) => this.hud.read(row.id)));
      return huds.filter((hud): hud is AiHudPayload => hud !== null);
    } catch (error) {
      this.logger.warn(
        { event: 'ai.snapshot_failed', tenant_id: tenantId, err: error },
        'could not read the AI HUD for a connecting agent; the stream will fill it in',
      );
      return [];
    }
  }
}
