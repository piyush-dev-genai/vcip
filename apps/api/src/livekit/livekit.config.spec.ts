import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MEDIA_TOKEN_TTL_SECONDS, livekitConfigFromEnv, redactable } from './livekit.config.js';

const SECRET = 'FAKE-livekit-secret-for-tests-0123456789';

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: SECRET,
  ...overrides,
});

describe('livekitConfigFromEnv', () => {
  it('reads the deployment from the environment', () => {
    const config = livekitConfigFromEnv(env());
    expect(config.url).toBe('ws://localhost:7880');
    expect(config.apiKey).toBe('devkey');
    expect(config.apiSecret).toBe(SECRET);
  });

  it('fixes the media-token lifetime at fifteen minutes', () => {
    expect(MEDIA_TOKEN_TTL_SECONDS).toBe(900);
    expect(livekitConfigFromEnv(env()).tokenTtlSeconds).toBe(900);
  });

  it.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])(
    'refuses to start without %s',
    (name) => {
      expect(() => livekitConfigFromEnv(env({ [name]: undefined }))).toThrow(`${name} is not set`);
    },
  );

  it('treats a blank value as missing', () => {
    expect(() => livekitConfigFromEnv(env({ LIVEKIT_API_SECRET: '   ' }))).toThrow(
      'LIVEKIT_API_SECRET is not set',
    );
  });

  it('refuses a short signing secret', () => {
    expect(() => livekitConfigFromEnv(env({ LIVEKIT_API_SECRET: 'too-short' }))).toThrow(
      'LIVEKIT_API_SECRET must be at least 32 characters',
    );
  });

  /**
   * The key travels in the JWT header as the issuer, so it is an identifier
   * rather than a secret and a short one is not a weakness.
   */
  it('accepts a short API key', () => {
    expect(livekitConfigFromEnv(env({ LIVEKIT_API_KEY: 'devkey' })).apiKey).toBe('devkey');
  });

  it('never names the value in the error it throws', () => {
    try {
      livekitConfigFromEnv(env({ LIVEKIT_API_SECRET: 'too-short' }));
      expect.unreachable('expected a throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('too-short');
    }
  });
});

describe('redaction', () => {
  const config = livekitConfigFromEnv(env());

  it('does not carry the secret into JSON', () => {
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(JSON.stringify({ config })).not.toContain(SECRET);
  });

  it('does not carry the secret into an interpolated string', () => {
    expect(`${String(config)}`).not.toContain(SECRET);
  });

  it('does not carry the secret into util.inspect, which is how pino logs objects', () => {
    expect(inspect(config)).not.toContain(SECRET);
  });

  it('still exposes the secret to the minter that needs it', () => {
    expect(config.apiSecret).toBe(SECRET);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('redacts a config built by hand, not only one read from the environment', () => {
    const wrapped = redactable({
      url: 'ws://localhost:7880',
      apiKey: 'devkey',
      apiSecret: SECRET,
      tokenTtlSeconds: 900,
    });
    expect(JSON.stringify(wrapped)).not.toContain(SECRET);
  });
});
