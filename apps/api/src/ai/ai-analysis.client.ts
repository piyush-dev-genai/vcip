/**
 * Asking the AI service to analyse a call, behind a port (T30).
 *
 * The seam exists for the reason `RecordingStarter`'s does: when an analysis
 * should start, and what happens when it cannot, are worth testing without a
 * Python process — and there is exactly one place that knows how the AI
 * service is addressed.
 *
 * D10 in the outbound direction: the shared internal credential is presented
 * on the way out, the same one `InternalTokenGuard` requires on the way in.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AnalyzeRequest } from '@vcip/shared';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { InjectAuthConfig } from '../common/auth/auth.config.js';
import { INTERNAL_TOKEN_HEADER } from '../common/auth/auth-context.js';
import type { AiConfig } from './ai.config.js';
import { InjectAiConfig } from './ai.config.js';

export interface AnalysisStarter {
  /**
   * Ask the AI service to begin analysing one session.
   *
   * Throws if the service refuses or cannot be reached. The caller is on the
   * call-start path and treats that as "no AI for this call", never as a
   * reason to fail the call (D6).
   */
  start(sessionId: string, request: AnalyzeRequest): Promise<void>;
}

export const ANALYSIS_STARTER = Symbol('ANALYSIS_STARTER');

export const InjectAnalysisStarter = (): ParameterDecorator => Inject(ANALYSIS_STARTER);

/** The AI service's route. The session id is in the path, not the body. */
export const analyzePathFor = (sessionId: string): string =>
  `/internal/sessions/${encodeURIComponent(sessionId)}/analyze`;

@Injectable()
export class HttpAnalysisStarter implements AnalysisStarter {
  constructor(
    @InjectAiConfig() private readonly config: AiConfig,
    @InjectAuthConfig() private readonly auth: AuthConfig,
  ) {}

  async start(sessionId: string, request: AnalyzeRequest): Promise<void> {
    // An explicit timeout, because this is awaited on the path that starts a
    // call. Without one, an AI service that accepted the connection and then
    // stopped responding would hold `CALL_STARTED` open for as long as the
    // platform's default socket timeout — minutes, on a path measured in
    // milliseconds.
    const response = await fetch(this.config.baseUrl + analyzePathFor(sessionId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: this.auth.internalToken,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.config.startTimeoutMs),
    });

    if (!response.ok) {
      // The status and nothing else. A 4xx from a strict schema quotes the
      // request back, and the request contains a live LiveKit join token.
      throw new Error(`the AI service answered ${response.status}`);
    }
  }
}
