import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the properties of the seed script that must hold at rest, in the
 * committed source, without a database.
 *
 * The behavioural properties — idempotency, what gets created — are verified by
 * running it against a real database. What is checked here is what a test can
 * check better than a human reviewer will, every time: that no secret was ever
 * hardcoded, and that every identifier is unmistakably demo data.
 */

const SEED_SOURCE = readFileSync(path.join(__dirname, '..', '..', 'db', 'seed.ts'), 'utf8');

describe('the seed commits no secret', () => {
  it('generates the API key at run time rather than embedding one', () => {
    expect(SEED_SOURCE).toContain('randomBytes(');
    // A literal long enough to be a real key has no business in this file.
    const suspiciousLiterals = [...SEED_SOURCE.matchAll(/'([A-Za-z0-9_\-+/=]{24,})'/g)].map(
      (m) => m[1],
    );
    expect(suspiciousLiterals).toEqual([]);
  });

  it('stores only a hash, never the plaintext', () => {
    expect(SEED_SOURCE).toContain('keyHash: hashApiKey(');
    // Every use of the generated key must be either hashed or logged. A bare
    // `something: issuedKey` would be the plaintext reaching a column.
    const columnAssignments = [...SEED_SOURCE.matchAll(/(\w+)\s*:\s*issuedKey\b/g)].map(
      (m) => m[0],
    );
    expect(columnAssignments).toEqual([]);
  });

  it('never writes the key to disk', () => {
    for (const sink of ['writeFileSync', 'writeFile', 'appendFile', 'createWriteStream']) {
      expect(SEED_SOURCE).not.toContain(sink);
    }
  });

  it('keeps the webhook signing secret behind a reference, not a column', () => {
    expect(SEED_SOURCE).toContain("secretRef: 'env:");
  });
});

describe('everything seeded is clearly demo data', () => {
  it('names the tenant as development only', () => {
    expect(SEED_SOURCE).toContain("tenantSlug: 'demo-bank'");
    expect(SEED_SOURCE).toMatch(/tenantName: '[^']*development only[^']*'/);
  });

  it('uses a reserved .local domain for agent emails, never a real one', () => {
    const emails = [...SEED_SOURCE.matchAll(/email: '([^']+)'/g)].map((m) => m[1] ?? '');
    expect(emails.length).toBe(2);
    for (const email of emails) expect(email).toMatch(/@demo\.local$/);
  });

  it('points the webhook at loopback, never at an external host', () => {
    const urls = [...SEED_SOURCE.matchAll(/webhookUrl: '([^']+)'/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBe(1);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('prefixes the API key so a demo credential is recognisable on sight', () => {
    expect(SEED_SOURCE).toContain("apiKeyPrefix: 'vcip_demo'");
  });
});

describe('the seed creates no business history', () => {
  it('inserts into exactly the six provisioning tables', () => {
    const inserted = [...SEED_SOURCE.matchAll(/\.insert\((\w+)\)/g)].map((m) => m[1]);
    expect([...new Set(inserted)].sort()).toEqual([
      'agentProfiles',
      'checklistTemplates',
      'tenantApiKeys',
      'tenants',
      'users',
      'webhookEndpoints',
    ]);
  });

  it('never inserts a session, event, verdict, or billing row', () => {
    for (const table of [
      'sessions',
      'sessionEvents',
      'sessionChecklistItems',
      'sessionAiSummaries',
      'billingEntries',
      'exports',
      'webhookEvents',
      'webhookDeliveries',
    ]) {
      expect(SEED_SOURCE).not.toContain(`.insert(${table})`);
    }
  });

  it('deletes nothing - a re-run must not destroy real session history', () => {
    expect(SEED_SOURCE).not.toContain('.delete(');
    expect(SEED_SOURCE).not.toMatch(/TRUNCATE|DROP TABLE/i);
  });
});

describe('idempotency is structural, not incidental', () => {
  it('resolves every insert against a natural key', () => {
    const inserts = (SEED_SOURCE.match(/\.insert\(/g) ?? []).length;
    const upserts = (SEED_SOURCE.match(/\.onConflictDo/g) ?? []).length;
    // Two documented look-up-then-inserts, and they are look-ups for opposite
    // reasons:
    //
    //   - the webhook endpoint, because the approved schema has no unique
    //     index on (tenant_id, url) to conflict against;
    //   - the checklist template, because it has one and must not be
    //     overwritten through it (T33 — see the pinning tests below).
    expect(upserts).toBe(inserts - 2);
    expect(SEED_SOURCE).toContain('existingEndpoint');
  });

  it('refuses to run against production without an explicit override', () => {
    expect(SEED_SOURCE).toContain("process.env.NODE_ENV === 'production'");
    expect(SEED_SOURCE).toContain('VCIP_SEED_FORCE');
  });

  it('does not silently reissue the API key on a re-run', () => {
    expect(SEED_SOURCE).toContain('VCIP_SEED_ROTATE_KEY');
  });
});

/**
 * A pinned template must keep meaning what it meant (T33).
 *
 * `sessions.checklist_template_id` pins a session to a template row, and schema
 * §18 promises that changing a tenant's checklist cannot change what an
 * existing verification was judged against. The pin holds an *id*, so that
 * promise only holds while the row it points at is immutable — and the seed is
 * the one thing in this repository that writes template rows.
 */
describe('the checklist template is never rewritten', () => {
  it('does not upsert over an existing version', () => {
    // The failure this replaced: `onConflictDoUpdate` on (tenant_id, version)
    // silently rewrote `items`, retroactively changing every session already
    // pinned to that row, with nothing in the history to say so.
    const templateBlock = SEED_SOURCE.slice(
      SEED_SOURCE.indexOf('4. checklist template'),
      SEED_SOURCE.indexOf('5. API key'),
    );

    expect(templateBlock.length).toBeGreaterThan(0);
    expect(templateBlock).not.toContain('onConflictDo');
  });

  it('compares what is stored against what is intended', () => {
    expect(SEED_SOURCE).toContain('fingerprint(');
  });

  it('fails loudly rather than diverging, and says how to publish a change', () => {
    expect(SEED_SOURCE).toContain('bump DEMO.checklistVersion');
  });
});
