/**
 * Authentication configuration.
 *
 * Secrets come from the environment and are never written into a committed
 * file. The object is injected rather than read from `process.env` at the point
 * of use, so tests supply their own values instead of mutating global state.
 *
 * `toString`/`toJSON` are overridden on the way out: a config object that lands
 * in a log line or an error must not carry the secrets with it. See
 * `auth.config.spec.ts`, which asserts exactly that.
 */

import { Inject } from '@nestjs/common';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

/** Inject the authentication configuration. */
export const InjectAuthConfig = (): ParameterDecorator => Inject(AUTH_CONFIG);

export interface AuthConfig {
  /** Signs and verifies customer session tokens. */
  readonly customerTokenSecret: string;
  /** Signs and verifies agent JWTs. Distinct from the customer secret. */
  readonly agentJwtSecret: string;
  /** The shared `X-Internal-Token` credential (D10). */
  readonly internalToken: string;
  /**
   * Signs and verifies WebSocket connection tokens (D9, T27).
   *
   * A third distinct secret, for the reason the first two are distinct: a
   * connection token travels in a query parameter, which is the one place this
   * codebase otherwise refuses to put a credential, and query parameters reach
   * access logs and browser history. Signing it with the customer or agent
   * secret would mean a leaked WS token differed from a full session credential
   * by a single `act` claim.
   */
  readonly wsTokenSecret: string;
  /** Customer token lifetime. Two hours per R8. */
  readonly customerTokenTtlSeconds: number;
  /** Agent JWT lifetime. */
  readonly agentJwtTtlSeconds: number;
  /** Connection-token lifetime. Five minutes per T27. */
  readonly wsTokenTtlSeconds: number;
}

/** R8: the customer token lives two hours. There is no refresh endpoint. */
export const CUSTOMER_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/** A working shift plus slack. Agents re-authenticate, they do not refresh. */
export const AGENT_JWT_TTL_SECONDS = 12 * 60 * 60;

/**
 * Connection-token lifetime: five minutes.
 *
 * Long enough that a client which fetches a token, renders, and then opens a
 * socket is not racing the clock, and that an ordinary reconnect inside the
 * window needs no second round trip. Short enough that a token in an access log
 * or a browser history entry is worthless by the time anyone reads it.
 *
 * Deliberately not single-use. A dropped socket reconnecting is the common
 * case, and a one-shot token would make every network blip a REST round trip
 * before the client could try again.
 */
export const WS_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * The shortest secret worth accepting. Short shared secrets are guessable, and
 * a deployment that starts with one is worse than one that refuses to start.
 */
const MIN_SECRET_LENGTH = 32;

const required = (name: string, value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
};

/**
 * Build the configuration from the environment, failing fast.
 *
 * The error names the missing variable and never its value — a config error is
 * one of the easiest places to spill a secret into a log.
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const config: AuthConfig = {
    customerTokenSecret: required('VCIP_CUSTOMER_TOKEN_SECRET', env['VCIP_CUSTOMER_TOKEN_SECRET']),
    agentJwtSecret: required('VCIP_AGENT_JWT_SECRET', env['VCIP_AGENT_JWT_SECRET']),
    internalToken: required('VCIP_INTERNAL_TOKEN', env['VCIP_INTERNAL_TOKEN']),
    wsTokenSecret: required('VCIP_WS_TOKEN_SECRET', env['VCIP_WS_TOKEN_SECRET']),
    customerTokenTtlSeconds: CUSTOMER_TOKEN_TTL_SECONDS,
    agentJwtTtlSeconds: AGENT_JWT_TTL_SECONDS,
    wsTokenTtlSeconds: WS_TOKEN_TTL_SECONDS,
  };

  if (config.customerTokenSecret === config.agentJwtSecret) {
    // Distinct secrets are the second half of purpose binding: with one shared
    // secret, a forged `act` claim would be the only thing standing between a
    // customer token and an agent route.
    throw new Error('VCIP_CUSTOMER_TOKEN_SECRET and VCIP_AGENT_JWT_SECRET must differ');
  }

  if (
    config.wsTokenSecret === config.customerTokenSecret ||
    config.wsTokenSecret === config.agentJwtSecret
  ) {
    // The same argument, for the credential D9 puts in a query parameter. A WS
    // token that shared a signing key with a session credential would differ
    // from it only by an `act` claim, and it travels somewhere logs can see.
    throw new Error('VCIP_WS_TOKEN_SECRET must differ from the customer and agent secrets');
  }

  return redactable(config);
}

/**
 * Wrap a config so stringifying or serialising it cannot spill the secrets.
 *
 * `JSON.stringify`, template interpolation, and most loggers all go through one
 * of these two paths. This does not make the object secret-free — the fields
 * are still readable, as they must be — it removes the accidental routes.
 */
export function redactable(config: AuthConfig): AuthConfig {
  return Object.freeze(
    Object.defineProperties(
      { ...config },
      {
        toJSON: { value: () => '[AuthConfig redacted]', enumerable: false },
        toString: { value: () => '[AuthConfig redacted]', enumerable: false },
        [Symbol.for('nodejs.util.inspect.custom')]: {
          value: () => '[AuthConfig redacted]',
          enumerable: false,
        },
      },
    ) as AuthConfig,
  );
}
