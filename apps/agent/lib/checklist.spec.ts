/**
 * The agent's ticks across a reload (T34).
 *
 * Under plain Node with a fake storage, which is the whole reason the browser
 * surface is injected: a reload is just a second `restoreTicks` against the
 * same store, and the rules about what may come back out of it are testable
 * without a browser.
 */

import type { ChecklistItem } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChecklistHost } from './checklist';
import { forgetTicks, rememberTicks, restoreTicks, toAnswers } from './checklist';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const TEMPLATE: ChecklistItem[] = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
];

/** `sessionStorage`, in memory. */
class FakeStorage {
  readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

/** Storage that refuses everything, as Safari's private mode does. */
const HOSTILE: ChecklistHost = {
  storage: {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  },
};

let storage: FakeStorage;
let host: ChecklistHost;

beforeEach(() => {
  storage = new FakeStorage();
  host = { storage };
});

describe('before anything is ticked', () => {
  it('starts every template item unticked', () => {
    expect(restoreTicks(host, SESSION, TEMPLATE)).toEqual({
      face_visible: false,
      document_shown: false,
    });
  });

  it('pre-ticks nothing, ever', () => {
    // Each tick is a statement a named person made about a named verification.
    // A default of "checked" would make it a statement nobody made.
    const restored = restoreTicks(host, SESSION, TEMPLATE);

    expect(Object.values(restored).some(Boolean)).toBe(false);
  });
});

describe('surviving a reload', () => {
  it('gives back what was ticked', () => {
    // The whole point: a refresh mid-call must not blank what the agent has
    // already confirmed while talking to someone.
    rememberTicks(host, SESSION, { face_visible: true, document_shown: false });

    expect(restoreTicks(host, SESSION, TEMPLATE)).toEqual({
      face_visible: true,
      document_shown: false,
    });
  });

  it('gives back an unticking too', () => {
    rememberTicks(host, SESSION, { face_visible: true, document_shown: true });
    rememberTicks(host, SESSION, { face_visible: false, document_shown: true });

    expect(restoreTicks(host, SESSION, TEMPLATE).face_visible).toBe(false);
  });

  it('keeps two calls apart', () => {
    // An agent may hold more than one session, and the wrong customer's
    // answers restored into the wrong checklist is the worst thing this module
    // could do.
    rememberTicks(host, SESSION, { face_visible: true, document_shown: true });

    expect(restoreTicks(host, OTHER, TEMPLATE)).toEqual({
      face_visible: false,
      document_shown: false,
    });
  });

  it('forgets a session once its verdict is in', () => {
    rememberTicks(host, SESSION, { face_visible: true, document_shown: true });
    forgetTicks(host, SESSION);

    expect(restoreTicks(host, SESSION, TEMPLATE).face_visible).toBe(false);
  });

  it('forgets only the session it was asked about', () => {
    rememberTicks(host, SESSION, { face_visible: true, document_shown: true });
    rememberTicks(host, OTHER, { face_visible: true, document_shown: true });

    forgetTicks(host, SESSION);

    expect(restoreTicks(host, OTHER, TEMPLATE).face_visible).toBe(true);
  });
});

describe('what the template is allowed to change', () => {
  it('drops a remembered answer to an item that is no longer asked', () => {
    // The template is the authority on which items exist. A stale answer must
    // not resurrect a question that is not on the checklist.
    rememberTicks(host, SESSION, { face_visible: true, retired_item: true });

    expect(restoreTicks(host, SESSION, TEMPLATE)).toEqual({
      face_visible: true,
      document_shown: false,
    });
  });

  it('starts a newly added item unticked', () => {
    rememberTicks(host, SESSION, { face_visible: true });
    const extended = [...TEMPLATE, { key: 'notes_taken', label: 'Notes', required: false }];

    expect(restoreTicks(host, SESSION, extended).notes_taken).toBe(false);
  });
});

describe('storage that cannot be trusted', () => {
  it.each([
    ['not json', 'garbage'],
    ['an array', '[true]'],
    ['null', 'null'],
    ['a string', '"face_visible"'],
  ])('reads %s as nothing remembered', (_case, raw) => {
    storage.setItem(`vcip.agent.checklist.${SESSION}`, raw);

    expect(restoreTicks(host, SESSION, TEMPLATE).face_visible).toBe(false);
  });

  it('ignores a remembered value that is not a boolean', () => {
    // A hand-edited entry must not become a tick the agent did not make.
    storage.setItem(`vcip.agent.checklist.${SESSION}`, JSON.stringify({ face_visible: 'yes' }));

    expect(restoreTicks(host, SESSION, TEMPLATE).face_visible).toBe(false);
  });

  it('works with no storage at all', () => {
    const none: ChecklistHost = { storage: null };
    rememberTicks(none, SESSION, { face_visible: true });

    expect(restoreTicks(none, SESSION, TEMPLATE).face_visible).toBe(false);
  });

  it('never throws when storage rejects every call', () => {
    // Safari's private mode and a blocked-cookies setting both throw rather
    // than returning null. A portal that white-screened mid-call would be far
    // worse than one that lost the ticks.
    expect(() => {
      rememberTicks(HOSTILE, SESSION, { face_visible: true });
      forgetTicks(HOSTILE, SESSION);
    }).not.toThrow();

    expect(restoreTicks(HOSTILE, SESSION, TEMPLATE).face_visible).toBe(false);
  });
});

describe('turning ticks into a submission', () => {
  it('answers every template item, in template order', () => {
    // The server refuses a submission that skips an item rather than reading
    // it as unchecked, so the portal must never send a partial one.
    expect(toAnswers(TEMPLATE, { face_visible: true })).toEqual([
      { key: 'face_visible', checked: true },
      { key: 'document_shown', checked: false },
    ]);
  });

  it('sends nothing for an item the template does not have', () => {
    const answers = toAnswers(TEMPLATE, { face_visible: true, retired_item: true });

    expect(answers.map((answer) => answer.key)).not.toContain('retired_item');
  });
});
