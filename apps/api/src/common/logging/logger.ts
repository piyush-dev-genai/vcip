/**
 * The application logger.
 *
 * `docs/03-system-design.md` §40 states what logs must never contain — raw
 * video, GPS, PAN, Aadhaar, face images, OCR text, passwords, API keys, JWTs —
 * and what they should prefer: session_id, tenant_id, event, duration, status,
 * error_code. This module encodes both halves.
 *
 * Redaction is configured on the pino instance itself, not applied by callers.
 * A rule that depends on every call site remembering it is not a rule; this way
 * a secret is removed even when someone logs a whole request object by mistake.
 */

import { pino } from 'pino';
import type { Logger } from 'pino';
import { currentRequestContext } from './request-context.js';

/**
 * Field names that must never reach a log, wherever they appear.
 *
 * Two forms of each path: the direct one and a wildcard, because a credential
 * is as likely to arrive nested inside `req.headers` or a config object as at
 * the top level. Pino matches these paths literally, so both are needed.
 *
 * The list covers the credentials this system actually holds — the four from
 * T09, database and signing material, and the payload field names the API
 * contract uses.
 */
export const REDACT_KEYS = [
  // --- transport credentials -------------------------------------------
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'x-internal-token',
  'X-Internal-Token',

  // --- the four T09 credentials ----------------------------------------
  'apiKey',
  'api_key',
  'apikey',
  'tenantApiKey',
  'tenant_api_key',
  'customerToken',
  'customer_token',
  'customerSessionToken',
  'agentJwt',
  'agent_jwt',
  'jwt',
  'internalToken',
  'internal_token',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'connectionToken',
  'connection_token',

  // --- passwords and hashes --------------------------------------------
  'password',
  'passwordHash',
  'password_hash',
  'keyHash',
  'key_hash',

  // --- signing and storage material -------------------------------------
  'privateKey',
  'private_key',
  'signingKey',
  'signing_key',
  'secret',
  'secretRef',
  'secret_ref',
  'clientSecret',
  'client_secret',

  // --- infrastructure credentials ---------------------------------------
  'DATABASE_URL',
  'databaseUrl',
  'database_url',
  'connectionString',
  'connection_string',
  'REDIS_URL',
  'POSTGRES_PASSWORD',
  'LIVEKIT_API_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'VCIP_INTERNAL_TOKEN',
  'VCIP_AGENT_JWT_SECRET',
  'VCIP_CUSTOMER_TOKEN_SECRET',
] as const;

/**
 * Where those keys are looked for.
 *
 * Pino's redact paths are not recursive by default, so each key is registered
 * at the top level, one level deep, two levels deep, and inside the request and
 * response objects a logged HTTP call would carry.
 */
export const REDACT_PATHS: string[] = REDACT_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `req.headers.${key}`,
  `request.headers.${key}`,
  `res.headers.${key}`,
  `headers.${key}`,
  `config.${key}`,
  `env.${key}`,
  `body.${key}`,
  `payload.${key}`,
]);

export const REDACTED = '[redacted]';

/**
 * Sensitive customer data that must not be logged at all (§39/§40).
 *
 * These are removed rather than replaced with a marker: unlike a credential,
 * whose presence is worth knowing about, a GPS fix or an OCR string has no
 * business appearing in a log line even as an acknowledgement.
 */
export const DROPPED_KEYS = [
  'gps',
  'gpsCoordinates',
  'latitude',
  'longitude',
  'pan',
  'aadhaar',
  'faceImage',
  'face_image',
  'ocrText',
  'ocr_text',
  'referenceFace',
  'frame',
  'frames',
] as const;

const DROPPED_PATHS: string[] = DROPPED_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

/**
 * Stamp every line with the current request context.
 *
 * This is why a service can log `{ event: 'session.queued' }` and still produce
 * a line that correlates with the error the customer saw.
 */
const mixin = (): Record<string, unknown> => {
  const context = currentRequestContext();
  if (context === undefined) return {};
  return {
    request_id: context.requestId,
    ...(context.tenantId === undefined ? {} : { tenant_id: context.tenantId }),
    ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
  };
};

export interface LoggerOptions {
  readonly level?: string;
  /** Test seam: pino writes here instead of stdout. */
  readonly destination?: NodeJS.WritableStream;
}

/**
 * Build a logger with the redaction policy applied.
 *
 * Exported so tests can assert against a real pino instance writing real NDJSON
 * rather than against a helper that merely claims to redact.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const config = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: [...REDACT_PATHS, ...DROPPED_PATHS],
      censor: (_value: unknown, path: string[]): unknown => {
        const key = path[path.length - 1] ?? '';
        return (DROPPED_KEYS as readonly string[]).includes(key) ? undefined : REDACTED;
      },
    },
    // Errors are serialised without their stack: a stack names internal paths
    // and can quote arguments. Diagnostics come from the code and type instead.
    serializers: {
      err: (error: Error & { code?: string }) => ({
        type: error.name,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
      }),
    },
    mixin,
    base: { service: 'api' },
  };

  return options.destination === undefined
    ? pino(config)
    : pino(config, options.destination as never);
}

/** The process-wide logger. */
export const logger: Logger = createLogger();
