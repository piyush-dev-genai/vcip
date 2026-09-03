import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { DOCUMENT_READER, HttpDocumentReader } from './ai-document.client.js';
import { AI_CONFIG, aiConfigFromEnv } from './ai.config.js';

/**
 * How to reach the AI service, and nothing else.
 *
 * Extracted for the same reason `AiHudModule` was: `AiModule` needs
 * `LivekitModule` to mint the analyzer's join token, and anything that imported
 * `AiModule` to get at one small port was made to drag a LiveKit configuration
 * in with it. `AgentsModule` needs exactly one thing from the AI boundary — the
 * client that asks for a document check — and it has no business requiring a
 * LiveKit signing key to be present in order to construct.
 *
 * So the two pieces with no dependencies of their own live here: the config
 * built from the environment at boot, and the outbound client that reads it.
 * `AuthModule` supplies the shared internal credential the client presents on
 * the way out (D10).
 *
 * Nothing here decides anything. It knows a base URL, a timeout and a token.
 */
@Module({
  imports: [AuthModule],
  providers: [
    { provide: AI_CONFIG, useFactory: () => aiConfigFromEnv() },
    { provide: DOCUMENT_READER, useClass: HttpDocumentReader },
  ],
  exports: [AI_CONFIG, DOCUMENT_READER],
})
export class AiClientModule {}
