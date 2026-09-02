/**
 * The two pure decisions a checklist read makes (T33).
 *
 * No database, no Nest container, no HTTP. The authorization matrix is small
 * enough to cover exhaustively, and the template parser is the only thing
 * between a `jsonb` column with no shape constraint and what an agent is shown.
 */

import { describe, expect, it } from 'vitest';
import { decideChecklistRead, parseTemplateItems } from './checklist.rules.js';

const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

const items = (over: Record<string, unknown> = {}) => [
  { key: 'face_visible', label: 'Customer face visible', required: true, ...over },
];

describe('who may read a checklist', () => {
  it('lets the assigned agent read it', () => {
    expect(decideChecklistRead({ assignedAgentId: AGENT, requestingAgentId: AGENT })).toEqual({
      kind: 'ALLOWED',
    });
  });

  it('refuses another agent in the same tenant', () => {
    // Tenant ownership is checked before this and is not enough. Every agent in
    // a tenant can already see a session in the queue; this is the list of
    // things a named agent is about to attest to.
    expect(decideChecklistRead({ assignedAgentId: AGENT, requestingAgentId: OTHER })).toEqual({
      kind: 'NOT_ASSIGNED',
    });
  });

  it('refuses when nobody is assigned yet', () => {
    // A session before accept has no `agent_id`. "Nobody is assigned" must
    // never read as "you are assigned".
    expect(decideChecklistRead({ assignedAgentId: null, requestingAgentId: AGENT })).toEqual({
      kind: 'NOT_ASSIGNED',
    });
  });
});

describe('reading a template out of jsonb', () => {
  it('accepts a well-formed checklist', () => {
    const parsed = parseTemplateItems(items());

    expect(parsed).toEqual({ kind: 'OK', items: items() });
  });

  it('accepts the seeded three-item checklist', () => {
    // The one in `06-database-schema.md` §10 and in `db/seed.ts`. If this ever
    // stopped parsing, every demo verification would 500.
    const seeded = [
      { key: 'face_visible', label: 'Customer face visible', required: true },
      { key: 'document_shown', label: 'Original document shown', required: true },
      { key: 'customer_verified', label: 'Customer verified', required: true },
    ];

    expect(parseTemplateItems(seeded).kind).toBe('OK');
  });

  it.each([
    ['null', null],
    ['an object', { items: [] }],
    ['a string', '[]'],
    ['an empty list', []],
  ])('refuses %s', (_case, value) => {
    expect(parseTemplateItems(value).kind).toBe('MALFORMED');
  });

  it('refuses an item missing `required`', () => {
    // The field is not defaulted anywhere. A template of items that forgot to
    // say they were required would become a checklist of suggestions.
    expect(parseTemplateItems([{ key: 'face_visible', label: 'Face' }]).kind).toBe('MALFORMED');
  });

  it('refuses an unknown field rather than dropping it', () => {
    // Strict, because an unrecognised key is more likely a template written
    // against a newer shape than a harmless extra.
    expect(parseTemplateItems(items({ weight: 3 })).kind).toBe('MALFORMED');
  });

  it.each([
    ['upper case', 'Face_Visible'],
    ['a space', 'face visible'],
    ['a leading digit', '1face'],
    ['empty', ''],
  ])('refuses a key with %s', (_case, key) => {
    // The key is the primary key of `session_checklist_items` and travels in
    // the verdict payload. Two keys differing only by case would be two rows
    // meaning one thing.
    expect(parseTemplateItems(items({ key })).kind).toBe('MALFORMED');
  });

  it('refuses duplicate keys', () => {
    // They would collide on `session_checklist_items` at verdict time, which
    // is a long way from here to find out the template was wrong.
    const duplicated = [...items(), ...items()];

    expect(parseTemplateItems(duplicated).kind).toBe('MALFORMED');
  });

  it('refuses an empty label, which would render as a blank row', () => {
    expect(parseTemplateItems(items({ label: '' })).kind).toBe('MALFORMED');
  });

  it('never returns a partial list', () => {
    // The whole point. Dropping the malformed item and keeping the rest would
    // let a verdict be submitted against a checklist quietly shorter than the
    // tenant configured.
    const mixed = [
      { key: 'face_visible', label: 'Customer face visible', required: true },
      { key: 'BROKEN', label: '', required: 'yes' },
    ];

    expect(parseTemplateItems(mixed).kind).toBe('MALFORMED');
  });

  it('reports why, for the log', () => {
    const parsed = parseTemplateItems(null);

    expect(parsed.kind === 'MALFORMED' && parsed.reason.length > 0).toBe(true);
  });
});
