import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../common/auth/auth.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { CALL_REPOSITORY, RedisCallRepository } from './call.repository.js';
import { CallLifecycleService } from './call-lifecycle.service.js';
import { CallSweeperController } from './call-sweeper.controller.js';
import { CALL_SWEEP_ENABLED, CallSweeper } from './call-sweeper.service.js';
import { LiveKitWebhookController } from './livekit-webhook.controller.js';
import { LIVEKIT_CONFIG, livekitConfigFromEnv } from './livekit.config.js';
import { MediaTokenController } from './media-token.controller.js';
import { LiveKitTokenMinter, MEDIA_TOKEN_MINTER } from './media-token.minter.js';
import { MediaTokenService } from './media-token.service.js';
import { RecordingRetryController } from './recording-retry.controller.js';
import { RECORDING_RETRY_ENABLED, RecordingRetrySweeper } from './recording-retry.service.js';
import { LiveKitRecordingStarter, RECORDING_STARTER } from './recording.client.js';
import type { RecordingConfig } from './recording.config.js';
import { RECORDING_CONFIG, recordingConfigFromEnv } from './recording.config.js';
import { RecordingService } from './recording.service.js';
import { LiveKitWebhookVerifier, WEBHOOK_VERIFIER } from './webhook.verifier.js';

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
 * T26 extends it rather than adding a module beside it, because the webhook is
 * the same boundary and the same credentials: LiveKit talking to us instead of
 * us talking to LiveKit. It brings two imports.
 *
 * `TenantsModule` supplies `agent_reconnect_timeout_seconds` (D18) — the
 * reconnect window is per-tenant configuration, not a server constant.
 *
 * `AiModule` is imported through `forwardRef`, and the cycle it resolves is
 * real rather than accidental. This module owns token minting, which the AI
 * module needs so the analyzer holds no LiveKit signing key of its own; the AI
 * module owns the analysis, which `CALL_STARTED` here has to start. Both
 * directions are the right way round, so the dependency is declared rather
 * than broken by moving one of them somewhere it does not belong.
 *
 * `AgentsModule` supplies `PresenceService`, because a call that ends without
 * a verdict has to free the agent holding it (R5). That is the one write
 * outside PostgreSQL this module performs, it is not authoritative for
 * anything, and a failure is logged rather than allowed to fail a committed
 * transition.
 *
 * `EventsModule` is still absent: session events are appended through
 * `SESSION_REPOSITORY`, inside the same transaction as the transition they
 * describe, which is the only way an append-only log stays consistent with the
 * row it explains.
 *
 * T28 adds the evidence recording, and it brings no new imports either. A
 * recording is LiveKit asking LiveKit to compose a room — the same boundary and
 * the same credentials — and the file never passes through this process (I6):
 * the egress container writes it to object storage itself, which is why
 * `RECORDING_CONFIG` holds storage settings this module hands onward rather
 * than uses.
 *
 * Nothing here stops a recording. Room-composite egress ends when the room
 * does, and `infra/livekit.yaml` closes an empty room after `empty_timeout`.
 *
 * `RECORDING_ENABLED=false` stops one being *started*, which is a different
 * thing and is what a deployment that ends at the Core MVP wants: T38 onwards
 * do not exist yet, so there is nothing to read the file. The flag is read once
 * by `recordingConfigFromEnv`, and both the webhook path and the retry sweeper
 * derive from that single answer rather than asking the environment twice. See
 * `docs/07-deployment.md`.
 */
@Module({
  imports: [AuthModule, SessionsModule, TenantsModule, AgentsModule, forwardRef(() => AiModule)],
  controllers: [
    MediaTokenController,
    LiveKitWebhookController,
    CallSweeperController,
    RecordingRetryController,
  ],
  providers: [
    { provide: LIVEKIT_CONFIG, useFactory: () => livekitConfigFromEnv() },
    { provide: MEDIA_TOKEN_MINTER, useClass: LiveKitTokenMinter },
    { provide: WEBHOOK_VERIFIER, useClass: LiveKitWebhookVerifier },
    { provide: CALL_REPOSITORY, useClass: RedisCallRepository },
    MediaTokenService,
    CallLifecycleService,
    // The interval runs in the application; test modules build their own graph
    // and leave it off, so no pass fires between cases.
    { provide: CALL_SWEEP_ENABLED, useValue: true },
    CallSweeper,
    { provide: RECORDING_CONFIG, useFactory: () => recordingConfigFromEnv() },
    { provide: RECORDING_STARTER, useClass: LiveKitRecordingStarter },
    RecordingService,
    // Derived rather than fixed, because a sweeper looking for calls with
    // nothing recording them finds every call when recording is off. Left on,
    // it would run a database query every ten seconds to discover the same
    // thing it discovered last time and do nothing about it.
    {
      provide: RECORDING_RETRY_ENABLED,
      useFactory: (config: RecordingConfig) => config.enabled,
      inject: [RECORDING_CONFIG],
    },
    RecordingRetrySweeper,
  ],
  exports: [MEDIA_TOKEN_MINTER, LIVEKIT_CONFIG],
})
export class LivekitModule {}
