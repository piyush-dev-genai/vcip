import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  AGENT_JWT_TTL_SECONDS,
  CUSTOMER_TOKEN_TTL_SECONDS,
  authConfigFromEnv,
  redactable,
} from './auth.config.js';

const CUSTOMER = 'customer-secret-value-that-is-long-enough';
const AGENT = 'agent-secret-value-that-is-long-enough-xx';
const INTERNAL = 'internal-secret-value-that-is-long-enough';

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  VCIP_CUSTOMER_TOKEN_SECRET: CUSTOMER,
  VCIP_AGENT_JWT_SECRET: AGENT,
  VCIP_INTERNAL_TOKEN: INTERNAL,
  ...overrides,
});

describe('authConfigFromEnv', () => {
  it('reads all three secrets from the environment', () => {
    const config = authConfigFromEnv(env());
    expect(config.customerTokenSecret).toBe(CUSTOMER);
    expect(config.agentJwtSecret).toBe(AGENT);
    expect(config.internalToken).toBe(INTERNAL);
  });

  it('sets the customer token lifetime to two hours, per R8', () => {
    expect(authConfigFromEnv(env()).customerTokenTtlSeconds).toBe(7200);
    expect(CUSTOMER_TOKEN_TTL_SECONDS).toBe(2 * 60 * 60);
  });

  it('gives agent tokens their own lifetime', () => {
    expect(authConfigFromEnv(env()).agentJwtTtlSeconds).toBe(AGENT_JWT_TTL_SECONDS);
  });

  it.each(['VCIP_CUSTOMER_TOKEN_SECRET', 'VCIP_AGENT_JWT_SECRET', 'VCIP_INTERNAL_TOKEN'])(
    'fails fast when %s is missing',
    (name) => {
      expect(() => authConfigFromEnv(env({ [name]: undefined }))).toThrow(`${name} is not set`);
    },
  );

  it.each(['VCIP_CUSTOMER_TOKEN_SECRET', 'VCIP_AGENT_JWT_SECRET', 'VCIP_INTERNAL_TOKEN'])(
    'rejects a blank %s',
    (name) => {
      expect(() => authConfigFromEnv(env({ [name]: '   ' }))).toThrow(`${name} is not set`);
    },
  );

  it('rejects a secret that is too short to be worth having', () => {
    expect(() => authConfigFromEnv(env({ VCIP_INTERNAL_TOKEN: 'short' }))).toThrow(
      /at least 32 characters/,
    );
  });

  it('requires the customer and agent secrets to differ', () => {
    // Shared secrets would leave a forged `act` claim as the only thing
    // separating a customer token from an agent route.
    expect(() => authConfigFromEnv(env({ VCIP_AGENT_JWT_SECRET: CUSTOMER }))).toThrow(
      /must differ/,
    );
  });

  it('names the offending variable without quoting its value', () => {
    try {
      authConfigFromEnv(env({ VCIP_INTERNAL_TOKEN: 'short-secret-value' }));
      throw new Error('expected a rejection');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('VCIP_INTERNAL_TOKEN');
      expect(message).not.toContain('short-secret-value');
    }
  });
});

describe('the config cannot spill its secrets', () => {
  const config = authConfigFromEnv(env());

  it('redacts under JSON.stringify, the usual route into a log line', () => {
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain(CUSTOMER);
    expect(serialised).not.toContain(AGENT);
    expect(serialised).not.toContain(INTERNAL);
    expect(serialised).toContain('redacted');
  });

  it('redacts under string interpolation', () => {
    const text = `config=${String(config)}`;
    expect(text).not.toContain(CUSTOMER);
    expect(text).not.toContain(AGENT);
    expect(text).not.toContain(INTERNAL);
  });

  it('redacts under util.inspect, which console.log uses', () => {
    const text = inspect(config);
    expect(text).not.toContain(CUSTOMER);
    expect(text).not.toContain(AGENT);
    expect(text).not.toContain(INTERNAL);
  });

  it('redacts when nested inside another logged object', () => {
    const text = JSON.stringify({ context: 'startup', config });
    expect(text).not.toContain(INTERNAL);
  });

  it('still exposes the values to code that asks for a field directly', () => {
    // Redaction is about accidental serialisation, not about hiding the
    // secrets from the guards that must compare against them.
    expect(config.internalToken).toBe(INTERNAL);
  });

  it('is frozen, so nothing can swap a secret at run time', () => {
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('applies to any config built through redactable', () => {
    const custom = redactable({
      customerTokenSecret: 'c'.repeat(40),
      agentJwtSecret: 'a'.repeat(40),
      internalToken: 'i'.repeat(40),
      customerTokenTtlSeconds: 1,
      agentJwtTtlSeconds: 1,
    });
    expect(JSON.stringify(custom)).not.toContain('iiii');
  });
});
