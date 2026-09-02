import { describe, expect, it } from 'vitest';
import { AI_START_TIMEOUT_MS, aiConfigFromEnv } from './ai.config.js';

describe('aiConfigFromEnv', () => {
  it('is enabled by default', () => {
    const config = aiConfigFromEnv({ AI_INTERNAL_URL: 'http://ai:8000' });

    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe('http://ai:8000');
  });

  it('trims a trailing slash so the joined path has one separator', () => {
    expect(aiConfigFromEnv({ AI_INTERNAL_URL: 'http://ai:8000/' }).baseUrl).toBe('http://ai:8000');
  });

  it('can be switched off, which needs no URL', () => {
    // The one subsystem the product is designed to run without (D6), and the
    // path a demo on a small machine takes deliberately.
    const config = aiConfigFromEnv({ AI_ENABLED: 'false' });

    expect(config.enabled).toBe(false);
  });

  it('refuses to start enabled with nowhere to send an analysis', () => {
    // The alternative is a demo that silently has no AI and no error saying so.
    expect(() => aiConfigFromEnv({})).toThrow(/AI_INTERNAL_URL/);
  });

  it('names the escape hatch in the error', () => {
    expect(() => aiConfigFromEnv({})).toThrow(/AI_ENABLED=false/);
  });

  it('bounds the wait, because this is awaited on the call-start path', () => {
    // CALL_STARTED also starts the evidence recording. A hung AI service must
    // not hold that open for a platform default measured in minutes.
    expect(aiConfigFromEnv({ AI_INTERNAL_URL: 'http://ai:8000' }).startTimeoutMs).toBe(
      AI_START_TIMEOUT_MS,
    );
    expect(AI_START_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it('is frozen, so nothing edits the configuration at runtime', () => {
    const config = aiConfigFromEnv({ AI_INTERNAL_URL: 'http://ai:8000' });

    expect(Object.isFrozen(config)).toBe(true);
  });
});
