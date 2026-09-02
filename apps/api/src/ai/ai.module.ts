import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { LivekitModule } from '../livekit/livekit.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { ANALYSIS_STARTER, HttpAnalysisStarter } from './ai-analysis.client.js';
import { AiHudModule } from './ai-hud.module.js';
import { AI_HUD_SNAPSHOTS, SessionAiHudSnapshots } from './ai-hud.snapshots.js';
import { AiAnalysisService } from './ai-analysis.service.js';
import { AiResultController } from './ai-result.controller.js';
import { AiResultService } from './ai-result.service.js';
import { AI_CONFIG, aiConfigFromEnv } from './ai.config.js';

/**
 * The AI boundary, both directions (T30).
 *
 * ```text
 * CALL_STARTED -> AiAnalysisService -> AI service
 * AI service   -> POST /internal/ai/result -> AiResultService
 * ```
 *
 * Its imports are its boundary, and the absences are the point: no queue, no
 * billing, no checklist, no verdict. AI is assistive (D6) and decides nothing
 * (I7), so this module can start an analysis and take delivery of a result,
 * and it has no way to change what happens to a session.
 *
 * `LivekitModule` is a `forwardRef` because the two modules genuinely need
 * each other: this one needs the token minter, and `CALL_STARTED` over there
 * needs to start an analysis. Neither direction is avoidable without putting
 * minting or analysis in a module that should not own it.
 *
 * `LivekitModule` supplies `MEDIA_TOKEN_MINTER` and `LIVEKIT_CONFIG`. The
 * analyzer's token is minted through the same port the customer's and agent's
 * are, so `grantsFor` stays the single place where any participant's powers
 * are decided — and the AI service holds no LiveKit signing key at all.
 *
 * `SessionsModule` supplies `SESSION_REPOSITORY`, used for one thing:
 * appending `AI_UNAVAILABLE` when an analysis cannot be started. It is the
 * repository rather than `SessionsService` for the same reason T24 and T28
 * reach for it — this module has no business in the customer lifecycle, and
 * one event append is not a reason to import one.
 *
 * `AuthModule` supplies `InternalTokenGuard` for the inbound route, and the
 * shared internal credential the outbound client presents (D10, both ways).
 *
 * `EventsModule`-style writes aside, nothing here is idempotency-protected:
 * D13 covers operations that must happen at most once, and a HUD update whose
 * successor arrives two seconds later is not one.
 *
 * `AI_CONFIG` is built from the environment at boot, so a deployment that
 * enables AI without saying where it lives fails to start rather than failing
 * silently on the first call.
 *
 * T31 adds the HUD: a Redis repository and the snapshot port the WebSocket
 * gateway asks on connect. `AI_HUD_SNAPSHOTS` is exported for that, and it is
 * the only thing `RealtimeModule` takes from here — the fan-out itself goes
 * the other way, through the global `NOTIFICATIONS` port, so T27 keeps owning
 * transport and this module keeps owning what a HUD is.
 */
@Module({
  imports: [AuthModule, forwardRef(() => LivekitModule), SessionsModule, AiHudModule],
  controllers: [AiResultController],
  providers: [
    { provide: AI_CONFIG, useFactory: () => aiConfigFromEnv() },
    { provide: ANALYSIS_STARTER, useClass: HttpAnalysisStarter },
    { provide: AI_HUD_SNAPSHOTS, useClass: SessionAiHudSnapshots },
    AiAnalysisService,
    AiResultService,
  ],
  // Not `AI_HUD_REPOSITORY`: it is `AiHudModule`'s to export now, and a module
  // may only export what it provides or re-exports. Anything needing the HUD
  // imports that module directly, which is the dependency it actually has.
  exports: [AiAnalysisService, AI_HUD_SNAPSHOTS],
})
export class AiModule {}
