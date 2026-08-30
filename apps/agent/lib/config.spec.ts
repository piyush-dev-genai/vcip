import { afterEach, describe, expect, it } from 'vitest';
import { apiBaseUrl, HEARTBEAT_INTERVAL_MS } from './config';

const ORIGINAL = process.env.NEXT_PUBLIC_API_BASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = ORIGINAL;
});

describe('apiBaseUrl', () => {
  it('falls back to the local Control API port', () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    expect(apiBaseUrl()).toBe('http://localhost:3001');
  });

  it('uses the configured value', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
    expect(apiBaseUrl()).toBe('https://api.example');
  });

  it('trims a trailing slash so paths do not double up', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example///';
    expect(apiBaseUrl()).toBe('https://api.example');
  });

  it('ignores a blank value', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = '   ';
    expect(apiBaseUrl()).toBe('http://localhost:3001');
  });
});

describe('HEARTBEAT_INTERVAL_MS', () => {
  it('allows three misses inside the server’s 15-second TTL', () => {
    // The server's TTL is 15s (apps/api/src/agents/presence.keys.ts). Beating
    // at most every 5s means a transient failure does not drop an agent who is
    // actually there; anything at or above the TTL would.
    const ttlMs = 15_000;
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(ttlMs / 3);
    // ...and not so often that it is pointless Redis traffic.
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
  });
});
