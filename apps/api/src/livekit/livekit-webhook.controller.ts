/**
 * `POST /internal/livekit/webhook` (T26, D7).
 *
 * The one route in this codebase authenticated by someone else's signature
 * rather than by a credential of ours. `webhook.verifier.ts` explains why in
 * full: `livekit-server` cannot be configured to send `X-Internal-Token`, so
 * D10's shared credential is unenforceable here and LiveKit's own signed
 * `Authorization` header takes its place. The signature covers the body, so a
 * replayed delivery cannot be edited.
 *
 * The raw body is what gets verified, not a re-serialised object — the hash is
 * over the exact bytes LiveKit sent. `main.ts` enables `rawBody` for this.
 *
 * **Always 200, unless the signature fails.** LiveKit retries a non-2xx, so
 * reporting "this room is not one of ours" or "that session does not exist" as
 * an error would buy an endless redelivery of an event nothing will ever
 * accept. Those are recorded and acknowledged. A bad signature is the one thing
 * worth refusing, and it is a 401 rather than a retry-worthy 5xx.
 */

import { Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import type { CallEventOutcome } from './call-lifecycle.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { CallLifecycleService } from './call-lifecycle.service.js';
import type { WebhookVerifier } from './webhook.verifier.js';
import { InjectWebhookVerifier, WebhookSignatureError } from './webhook.verifier.js';

/**
 * The request surface this route reads.
 *
 * Structural rather than `express.Request`, matching `AuthenticatedRequest` in
 * the auth layer: these two fields are everything the handler touches, and
 * describing exactly that keeps the API free of a dependency on one HTTP
 * framework's types. `rawBody` is populated by `NestFactory.create(..., {
 * rawBody: true })`.
 */
interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody?: Buffer;
}

/** A repeated header arrives as an array; a signature is one value or none. */
const authorizationOf = (request: WebhookRequest): string | undefined => {
  const value = request.headers.authorization;
  return typeof value === 'string' ? value : undefined;
};

@Controller('internal/livekit')
export class LiveKitWebhookController {
  constructor(
    @InjectWebhookVerifier() private readonly verifier: WebhookVerifier,
    private readonly lifecycle: CallLifecycleService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() request: WebhookRequest): Promise<ApiData<CallEventOutcome>> {
    // `rawBody` is a Buffer when the body parser captured one. Its absence
    // means the request arrived with no body at all, which cannot carry a valid
    // signature over its contents.
    const raw = request.rawBody?.toString('utf8') ?? '';

    let event;
    try {
      event = await this.verifier.verify(raw, authorizationOf(request));
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        throw new UnauthorizedException({
          code: ErrorCode.UNAUTHENTICATED,
          message: 'Invalid or missing webhook signature.',
        });
      }
      throw error;
    }

    return data(await this.lifecycle.handle(event));
  }
}
