/**
 * The origin policy.
 *
 * These matter more than their size suggests: a permissive parse here is the
 * difference between "the customer app may read responses" and "any page on the
 * internet may".
 */

import { describe, expect, it } from 'vitest';
import { corsPolicyFromEnv, parseOrigins } from './cors.config.js';

describe('parseOrigins', () => {
  it('accepts a single origin', () => {
    expect(parseOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });

  it('accepts several, comma separated, ignoring surrounding space', () => {
    expect(parseOrigins('http://localhost:3000, https://demo.example')).toEqual([
      'http://localhost:3000',
      'https://demo.example',
    ]);
  });

  it('is empty when unset, so the default is no cross-origin access', () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins('')).toEqual([]);
    expect(parseOrigins('   ')).toEqual([]);
  });

  it('never accepts a wildcard', () => {
    expect(parseOrigins('*')).toEqual([]);
    expect(parseOrigins('http://localhost:3000,*')).toEqual(['http://localhost:3000']);
  });

  it('rejects an entry carrying a path, query, or trailing slash', () => {
    // A browser sends a bare origin. Anything else is a configuration mistake,
    // and accepting it loosely would mean matching nothing at runtime while
    // looking configured.
    expect(parseOrigins('http://localhost:3000/')).toEqual([]);
    expect(parseOrigins('http://localhost:3000/app')).toEqual([]);
    expect(parseOrigins('http://localhost:3000?x=1')).toEqual([]);
  });

  it('rejects a non-http scheme', () => {
    expect(parseOrigins('file:///tmp')).toEqual([]);
    expect(parseOrigins('ws://localhost:3000')).toEqual([]);
    expect(parseOrigins('javascript:alert(1)')).toEqual([]);
  });

  it('drops an unparseable entry without dropping its neighbours', () => {
    expect(parseOrigins('not-a-url, http://localhost:3000')).toEqual(['http://localhost:3000']);
  });

  it('de-duplicates', () => {
    expect(parseOrigins('http://localhost:3000,http://localhost:3000')).toEqual([
      'http://localhost:3000',
    ]);
  });
});

describe('corsPolicyFromEnv', () => {
  it('reads the allow-list from CUSTOMER_ORIGIN', () => {
    const policy = corsPolicyFromEnv({ CUSTOMER_ORIGIN: 'http://localhost:3000' });
    expect(policy.origin).toEqual(['http://localhost:3000']);
  });

  it('allows no origin when CUSTOMER_ORIGIN is unset', () => {
    expect(corsPolicyFromEnv({}).origin).toEqual([]);
  });

  it('reads the agent portal from AGENT_ORIGIN (T16)', () => {
    const policy = corsPolicyFromEnv({ AGENT_ORIGIN: 'http://localhost:3002' });
    expect(policy.origin).toEqual(['http://localhost:3002']);
  });

  it('allows both apps when both are set', () => {
    const policy = corsPolicyFromEnv({
      CUSTOMER_ORIGIN: 'http://localhost:3000',
      AGENT_ORIGIN: 'http://localhost:3002',
    });
    expect(policy.origin).toEqual(['http://localhost:3000', 'http://localhost:3002']);
  });

  it('does not let one app widen the list by leaving the other blank', () => {
    // An empty string must contribute nothing, not an empty entry that a
    // sloppy join could turn into a wildcard-ish blank origin.
    expect(corsPolicyFromEnv({ CUSTOMER_ORIGIN: '', AGENT_ORIGIN: '' }).origin).toEqual([]);
    expect(
      corsPolicyFromEnv({ CUSTOMER_ORIGIN: '   ', AGENT_ORIGIN: 'http://localhost:3002' }).origin,
    ).toEqual(['http://localhost:3002']);
  });

  it('deduplicates when both variables name the same origin', () => {
    const policy = corsPolicyFromEnv({
      CUSTOMER_ORIGIN: 'http://localhost:3000',
      AGENT_ORIGIN: 'http://localhost:3000',
    });
    expect(policy.origin).toEqual(['http://localhost:3000']);
  });

  it('never enables credentials', () => {
    // The apps authenticate with an Authorization header they set themselves.
    // Allowing ambient credentials would add a CSRF surface for nothing.
    expect(corsPolicyFromEnv({ CUSTOMER_ORIGIN: 'http://localhost:3000' }).credentials).toBe(false);
  });

  it('allows exactly the three headers the browser apps send', () => {
    const policy = corsPolicyFromEnv({});
    expect([...policy.allowedHeaders]).toEqual([
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
    ]);
  });

  it('allows only the verbs the customer flow uses', () => {
    const policy = corsPolicyFromEnv({});
    expect([...policy.methods]).toEqual(['GET', 'POST', 'OPTIONS']);
    expect(policy.methods).not.toContain('DELETE');
    expect(policy.methods).not.toContain('PUT');
  });
});
