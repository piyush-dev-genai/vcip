import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION, apiBaseUrl, livekitUrl } from './config';

const original = process.env.NEXT_PUBLIC_API_BASE_URL;

afterEach(() => {
  if (original === undefined) {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_API_BASE_URL = original;
  }
});

const originalLivekit = process.env.NEXT_PUBLIC_LIVEKIT_URL;

afterEach(() => {
  if (originalLivekit === undefined) {
    delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
  } else {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = originalLivekit;
  }
});

describe('apiBaseUrl', () => {
  it('defaults to the local Control API port', () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    expect(apiBaseUrl()).toBe('http://localhost:3001');
  });

  it('uses the configured value, so the demo needs no code change (D24)', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.demo.example';
    expect(apiBaseUrl()).toBe('https://api.demo.example');
  });

  it('strips a trailing slash, which would otherwise double up in every path', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.demo.example/';
    expect(`${apiBaseUrl()}/v1/sessions`).toBe('https://api.demo.example/v1/sessions');
  });

  it('falls back when the value is blank', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = '   ';
    expect(apiBaseUrl()).toBe('http://localhost:3001');
  });
});

describe('CONSENT_VERSION', () => {
  it('is a non-empty string the consent schema accepts', () => {
    expect(CONSENT_VERSION.length).toBeGreaterThan(0);
    expect(CONSENT_VERSION.length).toBeLessThanOrEqual(64);
  });
});

describe('livekitUrl', () => {
  it('defaults to the local Docker Compose SFU', () => {
    delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
    expect(livekitUrl()).toBe('ws://localhost:7880');
  });

  it('uses the configured value, so the demo needs no code change (D24)', () => {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = 'wss://demo.livekit.cloud';
    expect(livekitUrl()).toBe('wss://demo.livekit.cloud');
  });

  it('strips a trailing slash', () => {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = 'wss://demo.livekit.cloud/';
    expect(livekitUrl()).toBe('wss://demo.livekit.cloud');
  });

  it('falls back when the value is blank', () => {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = '   ';
    expect(livekitUrl()).toBe('ws://localhost:7880');
  });

  /**
   * The address is not the credential. It says where the SFU is; the media
   * token says who may enter which room, it is minted per session and per role
   * by the Control API (T24), and `LIVEKIT_API_SECRET` never leaves the server.
   */
  it('is an address and never a credential', () => {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = 'wss://demo.livekit.cloud';
    expect(livekitUrl()).not.toMatch(/token|key|secret|[?&]/i);
  });
});
