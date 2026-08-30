import { describe, expect, it } from 'vitest';
import {
  parseLanguages,
  presenceKey,
  PRESENCE_FIELDS,
  PRESENCE_TTL_SECONDS,
  serialiseLanguages,
} from './presence.keys.js';

const AGENT_A = '00000000-0000-4000-8000-000000000001';
const AGENT_B = '00000000-0000-4000-8000-000000000002';

describe('presenceKey', () => {
  it('is the key `03-system-design.md` §9.3 documents', () => {
    expect(presenceKey(AGENT_A)).toBe(`agent:presence:${AGENT_A}`);
  });

  it('gives two agents two keys', () => {
    // The isolation property, stated at the level it is actually created:
    // if this ever collapsed, every cross-agent test downstream would be
    // testing nothing.
    expect(presenceKey(AGENT_A)).not.toBe(presenceKey(AGENT_B));
  });

  it('uses a namespace no other Redis user in this system writes', () => {
    // T11's idempotency records are `idem:*` and T15's queues are `queue:*`.
    // Presence must not share either, so a flush of one cannot take another
    // with it and a scan of one cannot see another.
    const key = presenceKey(AGENT_A);
    expect(key.startsWith('agent:presence:')).toBe(true);
    expect(key.startsWith('idem:')).toBe(false);
    expect(key.startsWith('queue:')).toBe(false);
  });
});

describe('PRESENCE_TTL_SECONDS', () => {
  it('is the documented 15 seconds', () => {
    expect(PRESENCE_TTL_SECONDS).toBe(15);
  });
});

describe('PRESENCE_FIELDS', () => {
  it('is exactly the four approved fields', () => {
    expect([...PRESENCE_FIELDS]).toEqual(['status', 'languages', 'last_seen', 'tenant_id']);
  });

  it('holds no user identity and no configuration', () => {
    // Data minimisation, asserted rather than assumed. `max_concurrent` in
    // particular is PostgreSQL configuration enforced at claim time (R5); a
    // copy here would be a second answer to the same question.
    for (const forbidden of [
      'email',
      'password',
      'password_hash',
      'token',
      'name',
      'max_concurrent',
      'skills',
    ]) {
      expect(PRESENCE_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('language serialisation', () => {
  it('round-trips', () => {
    for (const languages of [[], ['en'], ['en', 'hi'], ['pt-BR', 'zh-Hans']]) {
      expect(parseLanguages(serialiseLanguages(languages))).toEqual(languages);
    }
  });

  it('survives a tag containing the separator a naive join would use', () => {
    // The reason this is JSON and not a comma-joined string.
    expect(parseLanguages(serialiseLanguages(['en,hi', 'ta']))).toEqual(['en,hi', 'ta']);
  });

  it('reads a corrupt or absent value as no languages, never as a throw', () => {
    // A presence written by a future build, or truncated, must degrade to "we
    // know of no languages" — the queue then simply does not match this agent.
    for (const raw of [undefined, '', 'not json', '{"en":true}', '"en"', '42', 'null']) {
      expect(parseLanguages(raw)).toEqual([]);
    }
  });

  it('drops non-string entries rather than passing them through', () => {
    expect(parseLanguages('["en", 7, null, "hi"]')).toEqual(['en', 'hi']);
  });
});
