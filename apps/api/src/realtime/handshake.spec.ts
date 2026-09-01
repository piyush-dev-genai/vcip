import { RealtimeAudience } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import { signJwt } from '../common/auth/tokens.js';
import { CUSTOMER_ACTOR_CLAIM } from '../common/auth/customer-token.guard.js';
import { AGENT_ACTOR_CLAIM } from '../common/auth/agent-jwt.guard.js';
import { HandshakeFailure, authenticate, redactUrl, tokenFromUrl } from './handshake.js';
import { WS_ACTOR_CLAIM } from './ws-token.service.js';

const SECRET = 'FAKE-ws-secret-for-tests-abcdefghijklmnop';
const OTHER_SECRET = 'FAKE-other-secret-for-tests-9876543210zyx';
const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';

const wsToken = (claims: Record<string, unknown>, secret = SECRET, ttlSeconds = 300): string =>
  signJwt({ act: WS_ACTOR_CLAIM, ...claims }, { secret, ttlSeconds });

const customerToken = (): string =>
  wsToken({ aud: RealtimeAudience.CUSTOMER, tid: TENANT, sid: SESSION });

const agentToken = (): string => wsToken({ aud: RealtimeAudience.AGENT, tid: TENANT, uid: AGENT });

const url = (token: string): string => `/v1/ws?token=${encodeURIComponent(token)}`;

describe('tokenFromUrl', () => {
  it('reads the token D9 puts in the query', () => {
    expect(tokenFromUrl('/v1/ws?token=abc')).toBe('abc');
  });

  it('returns null when there is none', () => {
    for (const value of ['/v1/ws', '/v1/ws?', '/v1/ws?token=', undefined, '']) {
      expect(tokenFromUrl(value)).toBeNull();
    }
  });

  it('survives a URL it cannot parse', () => {
    expect(tokenFromUrl('%%%')).toBeNull();
  });
});

describe('what a connection may ask for', () => {
  /**
   * The isolation property: the URL carries one value and everything else is
   * ignored, so a client cannot name a session, tenant, or user of its own.
   */
  it('ignores every query parameter but the token', () => {
    const smuggled = `${url(customerToken())}&session_id=22222222-2222-4222-8222-222222222222&tenant_id=evil&user_id=evil`;
    const result = authenticate(smuggled, SECRET);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toEqual({
      audience: RealtimeAudience.CUSTOMER,
      tenantId: TENANT,
      sessionId: SESSION,
    });
  });
});

describe('a customer token', () => {
  it('yields a scope of tenant plus exactly one session', () => {
    const result = authenticate(url(customerToken()), SECRET);
    expect(result).toEqual({
      ok: true,
      scope: { audience: RealtimeAudience.CUSTOMER, tenantId: TENANT, sessionId: SESSION },
    });
  });

  it('is refused when it names no session', () => {
    const result = authenticate(
      url(wsToken({ aud: RealtimeAudience.CUSTOMER, tid: TENANT })),
      SECRET,
    );
    expect(result).toEqual({ ok: false, reason: HandshakeFailure.INVALID_SCOPE });
  });
});

describe('an agent token', () => {
  it('yields a scope of tenant plus user, and no session', () => {
    const result = authenticate(url(agentToken()), SECRET);
    expect(result).toEqual({
      ok: true,
      scope: { audience: RealtimeAudience.AGENT, tenantId: TENANT, userId: AGENT },
    });
  });

  it('carries no languages: those are read from the profile at connect time', () => {
    const result = authenticate(url(agentToken()), SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.scope).sort()).toEqual(['audience', 'tenantId', 'userId']);
  });

  it('is refused when it names no user', () => {
    const result = authenticate(url(wsToken({ aud: RealtimeAudience.AGENT, tid: TENANT })), SECRET);
    expect(result).toEqual({ ok: false, reason: HandshakeFailure.INVALID_SCOPE });
  });
});

describe('tokens that must not open a connection', () => {
  it('refuses a missing token', () => {
    expect(authenticate('/v1/ws', SECRET)).toEqual({
      ok: false,
      reason: HandshakeFailure.MISSING_TOKEN,
    });
  });

  it('refuses one signed with a different secret', () => {
    const result = authenticate(url(customerToken()), OTHER_SECRET);
    expect(result).toEqual({ ok: false, reason: HandshakeFailure.INVALID_TOKEN });
  });

  it('refuses an expired token', () => {
    const expired = wsToken(
      { aud: RealtimeAudience.CUSTOMER, tid: TENANT, sid: SESSION },
      SECRET,
      -60,
    );
    expect(authenticate(url(expired), SECRET)).toEqual({
      ok: false,
      reason: HandshakeFailure.INVALID_TOKEN,
    });
  });

  /**
   * Purpose confusion is the specific risk D9 introduces by putting a
   * credential in a URL. A session credential presented here fails on the
   * `act` claim, before the distinct signing secret is even considered.
   */
  it('refuses a customer session token', () => {
    const session = signJwt(
      { act: CUSTOMER_ACTOR_CLAIM, tid: TENANT, sid: SESSION },
      { secret: SECRET, ttlSeconds: 7200 },
    );
    expect(authenticate(url(session), SECRET)).toEqual({
      ok: false,
      reason: HandshakeFailure.INVALID_TOKEN,
    });
  });

  it('refuses an agent JWT', () => {
    const jwt = signJwt(
      { act: AGENT_ACTOR_CLAIM, tid: TENANT, uid: AGENT, role: 'AGENT' },
      { secret: SECRET, ttlSeconds: 3600 },
    );
    expect(authenticate(url(jwt), SECRET)).toEqual({
      ok: false,
      reason: HandshakeFailure.INVALID_TOKEN,
    });
  });

  it('refuses a token with no tenant', () => {
    const result = authenticate(
      url(wsToken({ aud: RealtimeAudience.CUSTOMER, sid: SESSION })),
      SECRET,
    );
    expect(result).toEqual({ ok: false, reason: HandshakeFailure.INVALID_SCOPE });
  });

  it('refuses an unknown audience', () => {
    const result = authenticate(url(wsToken({ aud: 'admin', tid: TENANT })), SECRET);
    expect(result).toEqual({ ok: false, reason: HandshakeFailure.INVALID_SCOPE });
  });

  it('tells expired and forged apart to nobody', () => {
    const expired = wsToken(
      { aud: RealtimeAudience.CUSTOMER, tid: TENANT, sid: SESSION },
      SECRET,
      -1,
    );
    const forged = customerToken();
    expect(authenticate(url(expired), SECRET)).toEqual(authenticate(url(forged), OTHER_SECRET));
  });
});

describe('redactUrl', () => {
  /**
   * D9 requires the credential in a query parameter — the one place this
   * codebase otherwise refuses to put one — and query strings reach access
   * logs, proxies, and browser history. Every log line goes through this.
   */
  it('removes the token but records that there was one', () => {
    const redacted = redactUrl(url(customerToken()));
    expect(redacted).toContain('token=%5Bredacted%5D');
    expect(redacted).not.toContain(customerToken());
  });

  it('leaks no fragment of the token', () => {
    const token = customerToken();
    const redacted = redactUrl(url(token));
    for (const part of token.split('.')) {
      expect(redacted).not.toContain(part);
    }
  });

  it('keeps the path, which is what makes a log line useful', () => {
    expect(redactUrl(url(customerToken())).startsWith('/v1/ws')).toBe(true);
  });

  it('leaves a URL with no token alone', () => {
    expect(redactUrl('/v1/ws')).toBe('/v1/ws');
    expect(redactUrl(undefined)).toBe('');
  });

  /**
   * The property that actually matters, asserted over the shapes a handshake
   * can arrive in rather than over one hand-picked string: whatever goes in,
   * no token comes out.
   */
  it('never returns a token, whatever it is given', () => {
    const token = customerToken();
    for (const input of [
      url(token),
      `/v1/ws?a=1&token=${token}&b=2`,
      `${url(token)}#frag`,
      '%%%',
      '//host/v1/ws?token=' + token,
    ]) {
      expect(redactUrl(input)).not.toContain(token);
    }
  });
});
