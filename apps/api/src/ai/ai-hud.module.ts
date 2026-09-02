import { Module } from '@nestjs/common';
import { AI_HUD_REPOSITORY, RedisAiHudRepository } from './ai-hud.repository.js';

/**
 * Where the AI HUD lives, and nothing else (T31, split out by T35).
 *
 * One provider, no imports. That is the whole point: the HUD is a Redis hash
 * and knows nothing about LiveKit, tokens, analyses, or sessions, so a module
 * holding only the HUD can be imported from anywhere without dragging the AI
 * boundary along with it.
 *
 * It was split from `AiModule` when the verdict transaction needed to read a
 * HUD to snapshot it (§45). `AiModule` imports `LivekitModule` for the
 * analyzer's token, `LivekitModule` imports `AgentsModule`, and `AgentsModule`
 * is where the verdict lives — so importing `AiModule` from there closed a
 * module cycle that no `forwardRef` would have made honest. The dependency
 * that actually existed was on a Redis key, not on the AI subsystem, and this
 * module is that dependency stated accurately.
 *
 * `RedisModule` is global, so nothing needs importing to reach the client.
 */
@Module({
  providers: [{ provide: AI_HUD_REPOSITORY, useClass: RedisAiHudRepository }],
  exports: [AI_HUD_REPOSITORY],
})
export class AiHudModule {}
