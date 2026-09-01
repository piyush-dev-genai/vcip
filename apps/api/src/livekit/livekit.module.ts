import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { LIVEKIT_CONFIG, livekitConfigFromEnv } from './livekit.config.js';
import { MediaTokenController } from './media-token.controller.js';
import { LiveKitTokenMinter, MEDIA_TOKEN_MINTER } from './media-token.minter.js';
import { MediaTokenService } from './media-token.service.js';

/**
 * LiveKit credentials (T24).
 *
 * Its imports are its boundary, and the absences are the point: no agents, no
 * queue, no presence, no billing, no events. This module answers one question —
 * may this caller hold room credentials for this session, and if so, which ones
 * — and it answers it without changing anything.
 *
 * `SessionsModule` supplies `SESSION_REPOSITORY`, which is how the decision
 * reaches PostgreSQL. It is imported rather than `SessionsService` because the
 * media token is a read of four columns, and the customer lifecycle has no part
 * in it; going through the repository port also keeps every SQL statement
 * against `sessions` in the file that already owns them.
 *
 * The dependency points this way on purpose. Sessions knows nothing about
 * LiveKit — `room_name` has been on the row since creation (R2) and is a name,
 * not an admission ticket — so the module that mints tokens depends on the one
 * that owns sessions, and never the reverse.
 *
 * `AuthModule` supplies the two guards and `TenantScope`.
 *
 * `EventsModule` is deliberately absent: issuing a credential appends nothing
 * to `session_events`. So is `IdempotencyModule` — the route is a GET, and D13
 * protects operations that must happen at most once. So is `QueueModule`, and
 * so is anything that could start a recording.
 *
 * `LIVEKIT_CONFIG` is built from the environment at boot with a factory, so a
 * deployment missing `LIVEKIT_API_SECRET` fails to start rather than failing on
 * the first customer to reach the call screen.
 *
 * Later tasks extend this module rather than adding new ones beside it: T26's
 * webhook receiver and T28's recording both belong to the same boundary and the
 * same credentials.
 */
@Module({
  imports: [AuthModule, SessionsModule],
  controllers: [MediaTokenController],
  providers: [
    { provide: LIVEKIT_CONFIG, useFactory: () => livekitConfigFromEnv() },
    { provide: MEDIA_TOKEN_MINTER, useClass: LiveKitTokenMinter },
    MediaTokenService,
  ],
  exports: [MEDIA_TOKEN_MINTER, LIVEKIT_CONFIG],
})
export class LivekitModule {}
