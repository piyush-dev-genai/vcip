/**
 * Password hashing for agent login, on `node:crypto`'s scrypt.
 *
 * Why scrypt and not argon2 or bcrypt: both are native addons, and this
 * repository has deliberately kept its authentication primitives on the
 * standard library (see `tokens.ts`, which hand-rolls one JWT algorithm for the
 * same reason). scrypt is a memory-hard KDF in the Node core, is what the
 * platform will still ship in five years, and needs no build toolchain on a
 * developer's machine. `hashApiKey` in `api-key.store.ts` uses a plain SHA-256
 * and is *correct* to — an API key is generated entropy with no dictionary to
 * attack. A human-chosen password is the opposite case, and gets a KDF.
 *
 * The stored form carries its own parameters:
 *
 *     scrypt$<N>$<r>$<p>$<salt base64>$<derived key base64>
 *
 * Reading the cost out of the stored string rather than from a constant is what
 * makes the cost changeable later: an old hash still verifies with the
 * parameters it was made with, and only new hashes get the new cost. A verifier
 * pinned to today's constant would lock every existing password out the day the
 * cost is raised.
 *
 * Nothing here logs, and no function takes or returns a plaintext it does not
 * need. `verifyPassword` never throws for a malformed or absent stored hash —
 * it returns false, because "this row has no usable credential" and "the wrong
 * password" must be indistinguishable from outside.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** The prefix identifying the algorithm. Present so a future one can coexist. */
const SCHEME = 'scrypt';

/**
 * Cost parameters for newly created hashes.
 *
 * N = 2^15 with r = 8 is ~32 MiB and ~100 ms of work per attempt on a
 * development machine — enough to make offline guessing expensive, small
 * enough that a login does not feel slow. `maxmem` must be raised explicitly:
 * Node's 32 MiB default is exactly at this working set and would reject it.
 */
const PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAXMEM = 128 * 1024 * 1024;

/** Sanity bounds, so a stored string cannot ask for an unbounded allocation. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

/**
 * Hash a password for storage.
 *
 * The salt is fresh per call, so two agents who chose the same password do not
 * produce the same stored value.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plaintext, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });
  return [
    SCHEME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly derived: Buffer;
}

/** Parse a stored hash, or null if it is not one this module produced. */
function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, rawN, rawR, rawP, rawSalt, rawDerived] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== SCHEME) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;

  const salt = Buffer.from(rawSalt, 'base64');
  const derived = Buffer.from(rawDerived, 'base64');
  if (salt.length === 0 || derived.length === 0) return null;

  return { N, r, p, salt, derived };
}

/**
 * Verify a password against a stored hash.
 *
 * False for every failure — wrong password, malformed stored value, a user row
 * whose `password_hash` is null. The caller turns all of them into the same
 * response, and giving it a single boolean is what stops a well-meaning branch
 * from reporting them differently.
 */
export async function verifyPassword(
  plaintext: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (typeof stored !== 'string' || stored.length === 0) return false;

  const parsed = parse(stored);
  if (parsed === null) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(plaintext, parsed.salt, parsed.derived.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
  } catch {
    // An allocation this large failing is an operational fault, not an
    // authentication result. Either way the answer to "is this the password"
    // is no.
    return false;
  }

  // Lengths are equal by construction — the key length came from the stored
  // hash — but timingSafeEqual throws rather than returning false on a
  // mismatch, and a throw here would escape as a 500.
  return derived.length === parsed.derived.length && timingSafeEqual(derived, parsed.derived);
}

/**
 * A hash of a password nobody knows, for equalising the unknown-user path.
 *
 * Without this, "no such email" returns in microseconds while "wrong password"
 * takes ~100 ms of scrypt, and the difference is a user-enumeration oracle that
 * works across tenants — exactly what the login flow must not leak. The service
 * verifies against this when it found no user, so both paths do the same work.
 *
 * Computed once, lazily: the plaintext is 32 random bytes that are discarded
 * immediately and never leave this function, so no password can match it and
 * no constant in the repository looks like a credential.
 */
let dummy: Promise<string> | null = null;

export function unknownUserHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('hex'));
  return dummy;
}
