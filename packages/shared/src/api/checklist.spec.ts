import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_ITEM_KEY_PATTERN,
  approvalReady,
  checklistItemSchema,
  checklistItemsSchema,
  validateSubmission,
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

// ------------------------------------------------------------- submission

const TEMPLATE = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
  { key: 'notes_taken', label: 'Notes taken', required: false },
];

const answers = (over: Record<string, boolean> = {}) =>
  TEMPLATE.map((entry) => ({ key: entry.key, checked: over[entry.key] ?? true }));

const approving = { requireAllChecked: true };
const rejecting = { requireAllChecked: false };

describe('validating a submitted checklist', () => {
  it('accepts a complete, fully checked submission', () => {
    const decision = validateSubmission(TEMPLATE, answers(), approving);

    expect(decision.kind).toBe('ACCEPTED');
  });

  it('returns the items in template order, not submission order', () => {
    // These rows are the record of what was asked and answered. The order a
    // client happened to serialise them in is not part of that.
    const shuffled = [...answers()].reverse();
    const decision = validateSubmission(TEMPLATE, shuffled, approving);

    expect(decision.kind === 'ACCEPTED' && decision.items.map((item) => item.key)).toEqual([
      'face_visible',
      'document_shown',
      'notes_taken',
    ]);
  });

  it('refuses a submission that skips an item rather than reading it as unchecked', () => {
    // "The agent left it blank" and "the portal is running against an older
    // template" arrive looking identical. Recording the second as the first
    // would write down an attestation nobody made.
    const partial = answers().slice(0, 2);
    const decision = validateSubmission(TEMPLATE, partial, approving);

    expect(decision).toEqual({ kind: 'MISSING_ITEMS', keys: ['notes_taken'] });
  });

  it('refuses answers to items this template does not contain', () => {
    const extra = [...answers(), { key: 'invented', checked: true }];
    const decision = validateSubmission(TEMPLATE, extra, approving);

    expect(decision).toEqual({ kind: 'UNKNOWN_ITEMS', keys: ['invented'] });
  });

  it('reports an unknown item before an unchecked one', () => {
    // A caller sending keys the template never had is most likely running a
    // stale portal; telling them which required item was unticked would answer
    // a question they did not ask.
    const both = [
      { key: 'face_visible', checked: false },
      { key: 'invented', checked: true },
    ];

    expect(validateSubmission(TEMPLATE, both, approving).kind).toBe('UNKNOWN_ITEMS');
  });

  it('refuses an approval with a required item unchecked', () => {
    const decision = validateSubmission(TEMPLATE, answers({ document_shown: false }), approving);

    expect(decision).toEqual({ kind: 'REQUIRED_UNCHECKED', keys: ['document_shown'] });
  });

  it('names every unchecked required item, not just the first', () => {
    const decision = validateSubmission(
      TEMPLATE,
      answers({ face_visible: false, document_shown: false }),
      approving,
    );

    expect(decision).toEqual({
      kind: 'REQUIRED_UNCHECKED',
      keys: ['face_visible', 'document_shown'],
    });
  });

  it('ignores an unchecked optional item', () => {
    expect(validateSubmission(TEMPLATE, answers({ notes_taken: false }), approving).kind).toBe(
      'ACCEPTED',
    );
  });

  it('lets a rejection through with required items unchecked', () => {
    // The reading of contract §18 that makes rejection possible at all: an
    // agent rejects *because* a required check failed.
    const decision = validateSubmission(TEMPLATE, answers({ face_visible: false }), rejecting);

    expect(decision.kind).toBe('ACCEPTED');
  });

  it('records the rejection exactly as answered', () => {
    // What varies by verdict is whether the checklist gates, never whether it
    // is kept. The unchecked item is the answer to "why was this rejected".
    const decision = validateSubmission(TEMPLATE, answers({ face_visible: false }), rejecting);

    expect(decision.kind === 'ACCEPTED' && decision.items[0]).toEqual({
      key: 'face_visible',
      checked: false,
    });
  });

  it('still demands completeness on a rejection', () => {
    // Gating is what relaxes. Answering a different set of questions is not.
    const decision = validateSubmission(TEMPLATE, answers().slice(0, 1), rejecting);

    expect(decision.kind).toBe('MISSING_ITEMS');
  });
});

describe('whether an approval is ready', () => {
  it('is true only when every required item is checked', () => {
    expect(approvalReady(TEMPLATE, answers())).toBe(true);
    expect(approvalReady(TEMPLATE, answers({ face_visible: false }))).toBe(false);
  });

  it('is false before every item has been answered', () => {
    expect(approvalReady(TEMPLATE, [])).toBe(false);
  });

  it('agrees with the rule the server applies', () => {
    // The portal enables its approve control from this; the API refuses from
    // `validateSubmission`. Two implementations would drift into a button that
    // promises what the server declines.
    for (const submitted of [answers(), answers({ document_shown: false }), []]) {
      expect(approvalReady(TEMPLATE, submitted)).toBe(
        validateSubmission(TEMPLATE, submitted, approving).kind === 'ACCEPTED',
      );
    }
  });
});
