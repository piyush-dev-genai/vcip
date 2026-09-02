import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_ITEM_KEY_PATTERN,
  checklistItemSchema,
  checklistItemsSchema,
} from './checklist.js';

const item = (over: Record<string, unknown> = {}) => ({
  key: 'face_visible',
  label: 'Customer face visible',
  required: true,
  ...over,
});

describe('a checklist item', () => {
  it('accepts the shape `06-database-schema.md` §10 documents', () => {
    expect(checklistItemSchema.safeParse(item()).success).toBe(true);
  });

  it('requires `required` to be stated', () => {
    // Not defaulted anywhere. A template whose items forgot to say they were
    // required would silently become a checklist of suggestions.
    const { key, label } = item();

    expect(checklistItemSchema.safeParse({ key, label }).success).toBe(false);
  });

  it('caps the label at a length a person can read on a call', () => {
    expect(checklistItemSchema.safeParse(item({ label: 'x'.repeat(200) })).success).toBe(true);
    expect(checklistItemSchema.safeParse(item({ label: 'x'.repeat(201) })).success).toBe(false);
  });

  it('constrains the key, which is an identifier rather than text', () => {
    // It is half the primary key of `session_checklist_items`, it travels in
    // the verdict payload, and it will appear in the evidence package.
    expect(CHECKLIST_ITEM_KEY_PATTERN.test('face_visible')).toBe(true);
    expect(CHECKLIST_ITEM_KEY_PATTERN.test('Face_Visible')).toBe(false);
    expect(CHECKLIST_ITEM_KEY_PATTERN.test('face visible')).toBe(false);
    expect(CHECKLIST_ITEM_KEY_PATTERN.test('_face')).toBe(false);
  });

  it('caps the key at the length the pattern allows', () => {
    expect(checklistItemSchema.safeParse(item({ key: `a${'b'.repeat(63)}` })).success).toBe(true);
    expect(checklistItemSchema.safeParse(item({ key: `a${'b'.repeat(64)}` })).success).toBe(false);
  });
});

describe('a template of items', () => {
  it('needs at least one item', () => {
    // A checklist with nothing in it is a misconfiguration, not a verification
    // that skips its checks.
    expect(checklistItemsSchema.safeParse([]).success).toBe(false);
  });

  it('caps the list at a length a person works through during a call', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_unused, index) => item({ key: `item_${String(index)}` }));

    expect(checklistItemsSchema.safeParse(many(50)).success).toBe(true);
    expect(checklistItemsSchema.safeParse(many(51)).success).toBe(false);
  });

  it('refuses duplicate keys', () => {
    // They would collide on `session_checklist_items`' primary key at verdict
    // time, a long way from here to discover the template was wrong.
    expect(checklistItemsSchema.safeParse([item(), item()]).success).toBe(false);
  });

  it('keeps the order the tenant configured', () => {
    const ordered = [item(), item({ key: 'document_shown' })];
    const parsed = checklistItemsSchema.parse(ordered);

    expect(parsed.map((entry) => entry.key)).toEqual(['face_visible', 'document_shown']);
  });
});
