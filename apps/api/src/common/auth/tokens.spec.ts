import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenError, bearerFrom, nowSeconds, signJwt, verifyJwt } from './tokens.js';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Build a token with an arbitrary header, signed however the caller wants. */
const forge = (header: unknown, payload: unknown, secret: string | null): string => {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature =
    secret === null ? '' : createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
};

describe('signJwt / verifyJwt round trip', () => {
  it('verifies a token it just minted', () => {
    const token = signJwt(
      { act: 'customer', tid: 't1', sid: 's1' },
      { secret: SECRET, ttlSeconds: 60 },
    );
    const claims = verifyJwt(token, SECRET, 'customer');
    expect(claims['tid']).toBe('t1');
    expect(claims['sid']).toBe('s1');
    expect(claims.act).toBe('customer');
  });

  it('stamps iat and exp from the ttl', () => {
    const issuedAt = 1_700_000_000;
    const token = signJwt({ act: 'agent' }, { secret: SECRET, ttlSeconds: 3600, issuedAt });
    const [, payload] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
    };
    expect(decoded.iat).toBe(issuedAt);
    expect(decoded.exp).toBe(issuedAt + 3600);
  });

  it('produces three base64url segments', () => {
    const token = signJwt({ act: 'agent' }, { secret: SECRET, ttlSeconds: 60 });
    expect(token.split('.')).toHaveLength(3);
    expect(token).not.toMatch(/[+/=]/);
  });

  it('refuses to sign with an empty secret', () => {
    expect(() => signJwt({ act: 'agent' }, { secret: '', ttlSeconds: 60 })).toThrow(TokenError);
  });
});

describe('signature verification', () => {
  it('rejects a token signed with a different secret', () => {
    const token = signJwt({ act: 'agent' }, { secret: OTHER_SECRET, ttlSeconds: 60 });
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/invalid signature/);
  });

  it('rejects a tampered payload', () => {
    const token = signJwt({ act: 'agent', tid: 't1' }, { secret: SECRET, ttlSeconds: 60 });
    const [header, , signature] = token.split('.') as [string, string, string];
    const swapped = b64({
      act: 'agent',
      tid: 'ATTACKER',
      iat: nowSeconds(),
      exp: nowSeconds() + 60,
    });
    expect(() => verifyJwt(`${header}.${swapped}.${signature}`, SECRET, 'agent')).toThrow(
      /invalid signature/,
    );
  });

  it('rejects a truncated signature without throwing a length error', () => {
    const token = signJwt({ act: 'agent' }, { secret: SECRET, ttlSeconds: 60 });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    expect(() =>
      verifyJwt(`${header}.${payload}.${signature.slice(0, 10)}`, SECRET, 'agent'),
    ).toThrow(TokenError);
  });

  it('rejects an empty signature', () => {
    const token = signJwt({ act: 'agent' }, { secret: SECRET, ttlSeconds: 60 });
    const [header, payload] = token.split('.') as [string, string, string];
    expect(() => verifyJwt(`${header}.${payload}.`, SECRET, 'agent')).toThrow(TokenError);
  });
});

describe('algorithm attacks', () => {
  it('rejects alg: none', () => {
    const token = forge(
      { alg: 'none', typ: 'JWT' },
      { act: 'agent', tid: 't1', iat: nowSeconds(), exp: nowSeconds() + 60 },
      null,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/unsupported token header/);
  });

  it('rejects alg: NONE regardless of case', () => {
    const token = forge(
      { alg: 'NONE', typ: 'JWT' },
      { act: 'agent', iat: nowSeconds(), exp: nowSeconds() + 60 },
      null,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/unsupported token header/);
  });

  it('rejects a different HMAC algorithm even when correctly signed', () => {
    const token = forge(
      { alg: 'HS512', typ: 'JWT' },
      { act: 'agent', iat: nowSeconds(), exp: nowSeconds() + 60 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/unsupported token header/);
  });

  it('rejects an RS256 header, the classic confusion attack', () => {
    const token = forge(
      { alg: 'RS256', typ: 'JWT' },
      { act: 'agent', iat: nowSeconds(), exp: nowSeconds() + 60 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/unsupported token header/);
  });

  it('rejects a missing or wrong typ', () => {
    for (const header of [{ alg: 'HS256' }, { alg: 'HS256', typ: 'JWE' }]) {
      const token = forge(
        header,
        { act: 'agent', iat: nowSeconds(), exp: nowSeconds() + 60 },
        SECRET,
      );
      expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/unsupported token header/);
    }
  });

  it('checks the header before the signature, so a forged alg never reaches the HMAC', () => {
    // Signed with the WRONG secret and carrying alg: none. If the header check
    // ran second, the error would mention the signature instead.
    const token = forge(
      { alg: 'none', typ: 'JWT' },
      { act: 'agent', iat: nowSeconds(), exp: nowSeconds() + 60 },
      OTHER_SECRET,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/unsupported token header/);
  });
});

describe('expiry', () => {
  it('rejects an expired token', () => {
    const token = signJwt(
      { act: 'agent' },
      { secret: SECRET, ttlSeconds: 60, issuedAt: nowSeconds() - 3600 },
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/token expired/);
  });

  it('rejects a token expiring exactly now', () => {
    const token = forge(
      { alg: 'HS256', typ: 'JWT' },
      { act: 'agent', iat: nowSeconds() - 10, exp: nowSeconds() },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/token expired/);
  });

  it('rejects a token with no exp at all', () => {
    const token = forge({ alg: 'HS256', typ: 'JWT' }, { act: 'agent', iat: nowSeconds() }, SECRET);
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/missing expiry/);
  });

  it('rejects a non-numeric exp', () => {
    for (const exp of ['9999999999', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const token = forge(
        { alg: 'HS256', typ: 'JWT' },
        { act: 'agent', iat: nowSeconds(), exp },
        SECRET,
      );
      expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(TokenError);
    }
  });

  it('rejects a token with no iat', () => {
    const token = forge(
      { alg: 'HS256', typ: 'JWT' },
      { act: 'agent', exp: nowSeconds() + 60 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/missing issued-at/);
  });
});

describe('purpose binding', () => {
  it('rejects a customer token presented where an agent token is expected', () => {
    const token = signJwt({ act: 'customer' }, { secret: SECRET, ttlSeconds: 60 });
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/wrong token type/);
  });

  it('rejects a token with no act claim', () => {
    const token = forge(
      { alg: 'HS256', typ: 'JWT' },
      { tid: 't1', iat: nowSeconds(), exp: nowSeconds() + 60 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/wrong token type/);
  });
});

describe('malformed input', () => {
  it.each([
    ['empty string', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['not base64', '!!!.???.###'],
  ])('rejects %s', (_label, token) => {
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(TokenError);
  });

  it('rejects a payload that is an array rather than an object', () => {
    const token = forge({ alg: 'HS256', typ: 'JWT' }, [1, 2, 3], SECRET);
    expect(() => verifyJwt(token, SECRET, 'agent')).toThrow(/malformed token payload/);
  });

  it('refuses to verify with an empty secret', () => {
    const token = signJwt({ act: 'agent' }, { secret: SECRET, ttlSeconds: 60 });
    expect(() => verifyJwt(token, '', 'agent')).toThrow(/verification secret is empty/);
  });
});

describe('errors never quote the credential', () => {
  it('keeps the token and the secret out of every message', () => {
    const token = signJwt({ act: 'customer', tid: 't1' }, { secret: OTHER_SECRET, ttlSeconds: 60 });
    const attempts: Array<() => unknown> = [
      () => verifyJwt(token, SECRET, 'agent'),
      () => verifyJwt('a.b.c', SECRET, 'agent'),
      () => verifyJwt('', SECRET, 'agent'),
      () => verifyJwt(token, '', 'agent'),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error('expected a rejection');
      } catch (error) {
        const text =
          error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(OTHER_SECRET);
        expect(text).not.toContain(token);
      }
    }
  });
});

describe('bearerFrom', () => {
  it('extracts a well-formed bearer credential', () => {
    expect(bearerFrom('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('tolerates surrounding whitespace', () => {
    expect(bearerFrom('  Bearer abc  ')).toBe('abc');
  });

  it.each([
    ['undefined', undefined],
    ['an array of headers', ['Bearer a', 'Bearer b']],
    ['a bare token', 'abc'],
    ['the wrong scheme', 'Basic abc'],
    ['lowercase scheme', 'bearer abc'],
    ['no credential', 'Bearer'],
    ['an empty credential', 'Bearer '],
    ['two credentials', 'Bearer a b'],
  ])('returns null for %s', (_label, header) => {
    expect(bearerFrom(header)).toBeNull();
  });
});
