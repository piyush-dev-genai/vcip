/**
 * Verifying that a webhook really came from LiveKit (T26, D7).
 *
 * LiveKit signs each delivery with a JWT in the `Authorization` header whose
 * claim carries a SHA-256 of the body, signed with the same API key pair that
 * mints media tokens. `WebhookReceiver` checks both halves: the signature, and
 * that the body hashes to what the signature promised.
 *
 * **This route does not carry `X-Internal-Token`, and that is a deliberate
 * amendment to D10.** D10 requires the shared internal credential on every
 * `/internal/*` route, and the other two — `/internal/ai/result` and
 * `/internal/egress/completed` — are called by services this repository
 * controls, which can send whatever header they are told to. LiveKit is not:
 * `livekit-server` has no configuration for custom webhook headers, it sends
 * its own signed `Authorization` and nothing else. Requiring a header the
 * sender cannot produce would leave the endpoint permanently unreachable.
 *
 * What D10 is actually protecting — that an internal route is authenticated and
 * not open to the public — still holds: an unsigned or wrongly signed request
 * is refused, and the signature is over the body, so a replayed body cannot be
 * edited. The route stays off the public router the same way the others do.
 *
 * The verifier is a port for the reason the minter is: the lifecycle logic
 * above it is worth testing without a signing key, and there is exactly one
 * place that knows how LiveKit authenticates.
 */

import { Inject, Injectable } from '@nestjs/common';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { LiveKitConfig } from './livekit.config.js';
import { InjectLiveKitConfig } from './livekit.config.js';
import type { CallWebhookEvent } from './call-events.rules.js';

/** Thrown when a delivery is not authentically LiveKit's. */
export class WebhookSignatureError extends Error {
  constructor() {
    super('the webhook signature did not verify');
    this.name = 'WebhookSignatureError';
  }
}

export interface WebhookVerifier {
  /**
   * Verify and parse one delivery.
   *
   * Takes the **raw** body, because the signature covers the exact bytes
   * LiveKit sent. A re-serialised object would hash differently even when it
   * carries the same fields.
   *
   * Throws `WebhookSignatureError` for anything that does not verify.
   */
  verify(rawBody: string, authorization: string | undefined): Promise<CallWebhookEvent>;
}

export const WEBHOOK_VERIFIER = Symbol('WEBHOOK_VERIFIER');

export const InjectWebhookVerifier = (): ParameterDecorator => Inject(WEBHOOK_VERIFIER);

@Injectable()
export class LiveKitWebhookVerifier implements WebhookVerifier {
  private readonly receiver: WebhookReceiver;

  constructor(@InjectLiveKitConfig() config: LiveKitConfig) {
    this.receiver = new WebhookReceiver(config.apiKey, config.apiSecret);
  }

  async verify(rawBody: string, authorization: string | undefined): Promise<CallWebhookEvent> {
    let parsed;
    try {
      parsed = await this.receiver.receive(rawBody, authorization);
    } catch {
      // The reason is swallowed: a malformed body, a wrong key, and a tampered
      // hash must be indistinguishable to the caller, exactly as the auth
      // guards treat expired and forged tokens alike.
      throw new WebhookSignatureError();
    }

    return {
      event: parsed.event,
      id: parsed.id,
      roomName: parsed.room?.name ?? null,
      participantIdentity: parsed.participant?.identity ?? null,
      disconnectReason: parsed.participant?.disconnectReason ?? null,
    };
  }
}
