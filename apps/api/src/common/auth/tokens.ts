/**
 * Minimal HS256 JWT, on `node:crypto`.
 *
 * The repository has no JWT library and this needs exactly one algorithm, in a
 * closed system where the same service both mints and verifies. What makes
 * hand-rolled JWT dangerous is well documented, so each hazard is closed
 * explicitly and tested adversarially in `tokens.spec.ts`:
 *
 *   - `alg: none` and algorithm confusion — the header must be exactly
 *     `{alg: 'HS256', typ: 'JWT'}`; nothing else is even considered.
 *   - Signature comparison timing — `timingSafeEqual`, after a length check.
 *   - Missing expiry — `exp` is required, not optional.
 *   - Cross-purpose reuse — every token carries an `act` claim, and customer
 *     and agent tokens are signed with different secrets, so neither is
 *     verifiable as the other even if the claim were forged.
 *
 * There is no refresh and no revocation (R8): these tokens are short-lived and
 * stateless by design.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Thrown for every verification failure. The message never quotes the token. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/** The only algorithm this system issues or accepts. */
const ALG = 'HS256';

export interface JwtClaims {
  /** Actor kind. Binds a token to its purpose. */
  readonly act: string;
  /** Seconds since the epoch. Required. */
  readonly exp: number;
  /** Seconds since the epoch. */
  readonly iat: number;
  readonly [claim: string]: unknown;
}

const b64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');

const sign = (signingInput: string, secret: string): string =>
  createHmac('sha256', secret).update(signingInput).digest('base64url');

/** Seconds since the epoch, floored. Injectable so tests are not clock-bound. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface SignOptions {
  readonly secret: string;
  readonly ttlSeconds: number;
  /** Overrides the issue time. Tests only. */
  readonly issuedAt?: number;
}

/**
 * Mint a token. Used by later tasks to issue customer and agent credentials;
 * present here because a verifier that has never been tested against a real
 * minted token is not a verifier.
 */
export function signJwt(
  claims: Record<string, unknown> & { act: string },
  options: SignOptions,
): string {
  if (options.secret.length === 0) throw new TokenError('signing secret is empty');

  const iat = options.issuedAt ?? nowSeconds();
  const header = b64url(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat, exp: iat + options.ttlSeconds }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput, options.secret)}`;
}

/**
 * Verify a token and return its claims.
 *
 * Throws `TokenError` on anything wrong — a bad signature, a wrong algorithm, a
 * missing expiry, an expired token. The caller cannot tell these apart from the
 * HTTP response, which is deliberate.
 */
export function verifyJwt(token: string, secret: string, expectedActor: string): JwtClaims {
  if (secret.length === 0) throw new TokenError('verification secret is empty');
  if (typeof token !== 'string' || token.length === 0) throw new TokenError('missing token');

  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed token');
  const [encodedHeader, encodedPayload, providedSignature] = parts as [string, string, string];

  // The header is checked BEFORE the signature, and only an exact match passes.
  // This is the `alg: none` and algorithm-confusion defence: an attacker cannot
  // nominate the algorithm, because only one is ever considered.
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('malformed token header');
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as Record<string, unknown>)['alg'] !== ALG ||
    (header as Record<string, unknown>)['typ'] !== 'JWT'
  ) {
    throw new TokenError('unsupported token header');
  }

  const expected = Buffer.from(sign(`${encodedHeader}.${encodedPayload}`, secret), 'utf8');
  const provided = Buffer.from(providedSignature, 'utf8');
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first. Length is not a secret; the bytes are.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new TokenError('invalid signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('malformed token payload');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TokenError('malformed token payload');
  }

  const claims = payload as Record<string, unknown>;

  // An expiry is mandatory. A token without one would be a permanent
  // credential, which is precisely what a short-lived token must never become.
  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new TokenError('missing expiry');
  if (exp <= nowSeconds()) throw new TokenError('token expired');

  const iat = claims['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) throw new TokenError('missing issued-at');

  // Purpose binding: a customer token presented to an agent route fails here
  // even before the differing secrets would have rejected it.
  if (claims['act'] !== expectedActor) throw new TokenError('wrong token type');

  return claims as unknown as JwtClaims;
}

/**
 * Extract a bearer credential from an Authorization header.
 *
 * Returns null rather than throwing: "no credential" and "bad credential" are
 * the same 401 to the caller, and the guard decides the message.
 */
export function bearerFrom(headerValue: unknown): string | null {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(headerValue.trim());
  return match?.[1] ?? null;
}
