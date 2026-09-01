/**
 * LiveKit configuration (T24).
 *
 * Shaped exactly like `auth.config.ts`, and for the same reason: the API secret
 * signs room credentials, so it is a signing key in every sense the customer
 * and agent token secrets are. It comes from the environment, is injected
 * rather than read from `process.env` at the point of use, and cannot survive a
 * `JSON.stringify` or a template interpolation into a log line.
 *
 * `LIVEKIT_URL` is held here but is **not** returned by any endpoint. T24's
 * response is exactly the three fields contract §13 names — `room_name`,
 * `token`, `expires_at` — and how a browser reaches the SFU is T25's problem to
 * solve on the client side. The value is kept because the minter's issuer and
 * the deployment it mints for should come from one object, and because T26 and
 * T28 will need it.
 *
 * `LIVEKIT_WEBHOOK_KEY` is deliberately absent. It authenticates the inbound
 * webhook, which is T26; a config object that carried it now would be a config
 * object nothing validates.
 */

import { Inject } from '@nestjs/common';

export const LIVEKIT_CONFIG = Symbol('LIVEKIT_CONFIG');

/** Inject the LiveKit configuration. */
export const InjectLiveKitConfig = (): ParameterDecorator => Inject(LIVEKIT_CONFIG);

export interface LiveKitConfig {
  /** The SFU the minted credentials are good for. Never returned to a client. */
  readonly url: string;
  /** Public half of the signing pair. Identifies the key, not a secret. */
  readonly apiKey: string;
  /** Signs room credentials. A secret, and treated as one. */
  readonly apiSecret: string;
  /** How long a minted media token may be used to join. */
  readonly tokenTtlSeconds: number;
}

/**
 * Media-token lifetime: fifteen minutes.
 *
 * Short-lived, as contract §13 requires, and long enough to be useful. The
 * constraint that sets the floor is R2: a customer may hold a token while
 * `QUEUED`, so the token is often minted before there is anyone to talk to. A
 * two-minute token would be dead before the queue reached them.
 *
 * The ceiling is that this is a bearer credential to publish camera and
 * microphone into a KYC call. Fifteen minutes bounds how long a leaked one is
 * worth anything.
 *
 * This bounds the *join*, not the call: LiveKit checks the token when the
 * participant connects, and an established connection is not dropped when it
 * lapses. A customer whose wait outlives their token re-fetches one — the
 * endpoint is a GET with no side effects, and `expires_at` is returned so the
 * client knows when to ask again rather than discovering it at connect time.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * The shortest API secret worth accepting.
 *
 * The same floor `auth.config.ts` applies, for the same reason: a deployment
 * that starts with a guessable signing key is worse than one that refuses to
 * start. LiveKit's own generator produces far longer values; the development
 * default in `.env.example` is a placeholder that must be replaced.
 */
const MIN_SECRET_LENGTH = 32;

const required = (name: string, value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value;
};

const requiredSecret = (name: string, value: string | undefined): string => {
  const present = required(name, value);
  if (present.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return present;
};

/**
 * Build the configuration from the environment, failing fast.
 *
 * The error names the missing variable and never its value. A config error is
 * one of the easiest places to spill a secret into a log, and this one holds
 * the key that mints admission to a customer's video call.
 */
export function livekitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  return redactable({
    url: required('LIVEKIT_URL', env['LIVEKIT_URL']),
    // Not a secret — it travels in the JWT header as the issuer — so it is
    // required to be present but not required to be long.
    apiKey: required('LIVEKIT_API_KEY', env['LIVEKIT_API_KEY']),
    apiSecret: requiredSecret('LIVEKIT_API_SECRET', env['LIVEKIT_API_SECRET']),
    tokenTtlSeconds: MEDIA_TOKEN_TTL_SECONDS,
  });
}

/**
 * Wrap a config so stringifying or inspecting it cannot spill the secret.
 *
 * `JSON.stringify`, template interpolation, and `util.inspect` are the three
 * routes a config object takes into a log line. This does not make the object
 * secret-free — `apiSecret` is still readable, as the minter needs it to be —
 * it removes the accidental paths.
 */
export function redactable(config: LiveKitConfig): LiveKitConfig {
  return Object.freeze(
    Object.defineProperties(
      { ...config },
      {
        toJSON: { value: () => '[LiveKitConfig redacted]', enumerable: false },
        toString: { value: () => '[LiveKitConfig redacted]', enumerable: false },
        [Symbol.for('nodejs.util.inspect.custom')]: {
          value: () => '[LiveKitConfig redacted]',
          enumerable: false,
        },
      },
    ) as LiveKitConfig,
  );
}
