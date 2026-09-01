import { Global, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AuthModule } from '../common/auth/auth.module.js';
import { NOTIFICATIONS, TransportNotifications } from './notifications.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { REALTIME_TRANSPORT, RedisRealtimeTransport } from './realtime.transport.js';
import { WsTokenController } from './ws-token.controller.js';
import { WsTokenService } from './ws-token.service.js';

/**
 * Realtime notifications (T27).
 *
 * Three things: the two connection-token routes (D9), the WebSocket gateway,
 * and the publisher every other module uses to say something happened.
 *
 * **Global, and that is the unusual part.** Six modules publish notifications —
 * the queue, the claim, the accept, the offer sweeper, the call lifecycle, and
 * later the AI and verdict paths — and having each import a realtime module
 * would put a transport dependency in the import list of nearly every business
 * module. Worse, `LivekitModule` already imports `AgentsModule` and
 * `SessionsModule`, and a realtime module importing those in turn would build a
 * cycle. `@Global` exports one token, `NOTIFICATIONS`, and business modules
 * inject it without declaring anything.
 *
 * They inject the *interface*, never the gateway. A producer says
 * "`sessionOffered(id)`"; whether that reaches a socket, and whose, is decided
 * here. That is what keeps T27's rule — transport, not timing — enforceable
 * rather than aspirational.
 *
 * `AgentsModule` supplies `AGENT_REPOSITORY`, which the gateway reads at
 * connect time for the agent's languages. Those decide which queue channels the
 * connection joins, and they are read then rather than carried in the token so
 * a profile change takes effect on the next connection.
 *
 * `AuthModule` supplies the two guards, `TenantGuard`, and the signing secrets.
 *
 * Deliberately absent: `SessionsModule`, `QueueModule`, and anything else that
 * owns business state. This module transports notifications; it never decides
 * that one is warranted, and it holds no repository through which it could.
 */
@Global()
@Module({
  imports: [AuthModule, AgentsModule],
  controllers: [WsTokenController],
  providers: [
    { provide: REALTIME_TRANSPORT, useClass: RedisRealtimeTransport },
    { provide: NOTIFICATIONS, useClass: TransportNotifications },
    WsTokenService,
    RealtimeGateway,
  ],
  exports: [NOTIFICATIONS, REALTIME_TRANSPORT],
})
export class RealtimeModule {}
