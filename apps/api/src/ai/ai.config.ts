/**
 * Where the AI service is, and whether to call it (T30).
 *
 * `AI_ENABLED` is a switch rather than a comment because AI is the one
 * subsystem the product is designed to run without (D6). A demo on a machine
 * that cannot spare a core for frame decoding turns it off and everything else
 * behaves exactly as it does when the AI service is simply down — which is a
 * path that has to work anyway, so having a way to exercise it deliberately is
 * worth one variable.
 *
 * No secret lives here. The credential the Control API presents to the AI
 * service is the shared internal token `AuthConfig` already owns (D10), and the
 * LiveKit signing key stays in `LiveKitConfig`.
 */

import { Inject } from '@nestjs/common';

export const AI_CONFIG = Symbol('AI_CONFIG');

export const InjectAiConfig = (): ParameterDecorator => Inject(AI_CONFIG);

/**
 * How long the Control API waits for the AI service to accept an analysis.
 *
 * Short, and this is the number that keeps D6 true. The call is `await`ed on
 * the path that starts a call, so this is time added to `CALL_STARTED` — and
 * `CALL_STARTED` is what starts the evidence recording. The AI service answers
 * before it joins the room precisely so this can be small.
 */
export const AI_START_TIMEOUT_MS = 2_000;

export interface AiConfig {
  /** Whether to ask for an analysis at all. */
  readonly enabled: boolean;
  /** The AI service's internal base URL, no trailing slash. */
  readonly baseUrl: string;
  /** Milliseconds to wait for the analysis request to be accepted. */
  readonly startTimeoutMs: number;
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const enabled = (env['AI_ENABLED'] ?? 'true').toLowerCase() !== 'false';
  const baseUrl = (env['AI_INTERNAL_URL'] ?? '').trim().replace(/\/+$/, '');

  // Enabled with nowhere to send it is a misconfiguration worth failing on:
  // the alternative is a demo that silently has no AI and no error to explain
  // it. Disabled needs no URL, so the check is inside the branch.
  if (enabled && baseUrl.length === 0) {
    throw new Error('AI_INTERNAL_URL is not set (set AI_ENABLED=false to run without AI)');
  }

  return Object.freeze({
    enabled,
    baseUrl,
    startTimeoutMs: AI_START_TIMEOUT_MS,
  });
}
