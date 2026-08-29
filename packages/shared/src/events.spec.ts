import { describe, expect, it } from 'vitest';
import { SESSION_EVENT_TYPES, SessionEventType, isSessionEventType } from './events.js';

/**
 * The catalogue is written out longhand rather than derived from the
 * implementation. A test that loops over `SessionEventType` would pass for any
 * catalogue, including one with a name silently removed.
 */
const CATALOGUE_FROM_DOCS = [
  'SESSION_CREATED',
  'CONSENT_ACCEPTED',
  'PREFLIGHT_PASSED',
  'PREFLIGHT_FAILED',
  'LOCATION_PASSED',
  'LOCATION_FAILED',
  'SESSION_QUEUED',
  'SESSION_ASSIGNED',
  'AGENT_ACCEPTED',
  'CALL_STARTED',
  'CALL_ENDED',
  'AGENT_DISCONNECTED',
  'AGENT_RECONNECTED',
  'AI_UNAVAILABLE',
  'VERDICT_SUBMITTED',
  'BILLING_CREATED',
  'EGRESS_STARTED',
  'EGRESS_COMPLETED',
  'EXPORT_STARTED',
  'EXPORTED',
  'EXPORT_FAILED',
  'PURGED',
  'WEBHOOK_CREATED',
] as const;

/** Names added beyond §15's "Example Events", documented in `events.ts`. */
const ADDED_BEYOND_DOCS = ['CONSENT_REJECTED', 'SESSION_ABORTED'] as const;

describe('session event catalogue', () => {
  it('contains every event type named in docs/06-database-schema.md §15', () => {
    for (const name of CATALOGUE_FROM_DOCS) {
      expect(SESSION_EVENT_TYPES).toContain(name);
    }
  });

  it('adds exactly the two names the MVP lifecycle needs and no others', () => {
    const extra = SESSION_EVENT_TYPES.filter(
      (name) => !(CATALOGUE_FROM_DOCS as readonly string[]).includes(name),
    );
    expect([...extra].sort()).toEqual([...ADDED_BEYOND_DOCS].sort());
  });

  it('covers the six lifecycle events T12 records', () => {
    expect(SessionEventType.SESSION_CREATED).toBe('SESSION_CREATED');
    expect(SessionEventType.CONSENT_ACCEPTED).toBe('CONSENT_ACCEPTED');
    expect(SessionEventType.PREFLIGHT_PASSED).toBe('PREFLIGHT_PASSED');
    expect(SessionEventType.PREFLIGHT_FAILED).toBe('PREFLIGHT_FAILED');
    expect(SessionEventType.LOCATION_PASSED).toBe('LOCATION_PASSED');
    expect(SessionEventType.LOCATION_FAILED).toBe('LOCATION_FAILED');
  });

  it('maps every key to its own name, so a persisted value is the key', () => {
    for (const [key, value] of Object.entries(SessionEventType)) {
      expect(value).toBe(key);
    }
  });

  it('has no duplicate values', () => {
    expect(new Set(SESSION_EVENT_TYPES).size).toBe(SESSION_EVENT_TYPES.length);
  });
});

describe('isSessionEventType', () => {
  it('accepts every catalogued name', () => {
    for (const name of SESSION_EVENT_TYPES) expect(isSessionEventType(name)).toBe(true);
  });

  it('rejects an uncatalogued name, which is how a stray literal is caught', () => {
    expect(isSessionEventType('SESSION_STARTED')).toBe(false);
    expect(isSessionEventType('consent_accepted')).toBe(false);
    expect(isSessionEventType('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isSessionEventType(undefined)).toBe(false);
    expect(isSessionEventType(null)).toBe(false);
    expect(isSessionEventType(1)).toBe(false);
    expect(isSessionEventType({ SESSION_CREATED: true })).toBe(false);
  });
});
