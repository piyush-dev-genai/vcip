/**
 * Validating and recording a submitted checklist (T34).
 *
 * The rule itself lives in `@vcip/shared` and is exhaustively tested there,
 * because the agent portal applies the same one. What is tested here is the
 * service around it: that it checks against the template *this session* is
 * pinned to, that a refusal becomes the right error, and that the write goes
 * to the caller's transaction rather than opening one.
 */

import { Writable } from 'node:stream';
import type { ResolvedChecklistItem } from '@vcip/shared';
import { DomainError, ErrorCode } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../common/logging/logger.js';
import type { DbExecutor } from '../common/events/session-event.writer.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import type { ChecklistRepository, ChecklistSessionRow } from './checklist.repository.js';
import { ChecklistService } from './checklist.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const TEMPLATE = '22222222-2222-4222-8222-222222222222';

const ITEMS = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
  { key: 'notes_taken', label: 'Notes taken', required: false },
];

const row = (over: Partial<ChecklistSessionRow> = {}): ChecklistSessionRow => ({
  sessionId: SESSION,
  tenantId: TENANT,
  assignedAgentId: AGENT,
  templateId: TEMPLATE,
  version: 1,
  items: ITEMS,
  ...over,
});

class FakeRepository implements ChecklistRepository {
  stored: ChecklistSessionRow | null = row();
  readonly writes: {
    sessionId: string;
    items: readonly ResolvedChecklistItem[];
    executor: DbExecutor;
  }[] = [];

  findForSession(tenantId: string, sessionId: string): Promise<ChecklistSessionRow | null> {
    const found =
      this.stored?.tenantId === tenantId && this.stored.sessionId === sessionId
        ? this.stored
        : null;
    return Promise.resolve(found);
  }

  saveAnswers(
    sessionId: string,
    items: readonly ResolvedChecklistItem[],
    executor: DbExecutor,
  ): Promise<void> {
    this.writes.push({ sessionId, items, executor });
    return Promise.resolve();
  }
}

/** Stands in for the verdict's transaction. Identity is what is asserted. */
const transaction: DbExecutor = { execute: () => Promise.resolve([]) };

const answers = (over: Record<string, boolean> = {}) =>
  ITEMS.map((item) => ({ key: item.key, checked: over[item.key] ?? true }));

let repository: FakeRepository;
let service: ChecklistService;

beforeEach(() => {
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  repository = new FakeRepository();
  service = new ChecklistService(
    repository,
    new TenantScope(),
    createLogger({ level: 'silent', destination: sink }),
  );
});

const validate = (over: Partial<Parameters<ChecklistService['validate']>[0]> = {}) =>
  service.validate({
    tenantId: TENANT,
    sessionId: SESSION,
    answers: answers(),
    requireAllChecked: true,
    ...over,
  });

describe('validating against the pinned template', () => {
  it('accepts a complete, fully checked submission', async () => {
    await expect(validate()).resolves.toEqual([
      { key: 'face_visible', checked: true },
      { key: 'document_shown', checked: true },
      { key: 'notes_taken', checked: true },
    ]);
  });

  it('checks against the template this session is pinned to, not the active one', async () => {
    // The read goes through the same query the agent's GET used, so the list
    // they ticked and the list this checks cannot be two lists.
    repository.stored = row({ items: [ITEMS[0]] });

    await expect(validate({ answers: [{ key: 'face_visible', checked: true }] })).resolves.toEqual([
      { key: 'face_visible', checked: true },
    ]);
  });

  it('refuses an approval with a required item unchecked', async () => {
    await expect(validate({ answers: answers({ document_shown: false }) })).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE,
    });
  });

  it('names the offending items, which the agent is looking at on screen', async () => {
    await expect(validate({ answers: answers({ document_shown: false }) })).rejects.toThrow(
      /document_shown/,
    );
  });

  it('lets a rejection through with a required item unchecked', async () => {
    // An agent rejects *because* a check failed. Requiring every box first
    // would make the only submittable rejection one where nothing was wrong.
    await expect(
      validate({ answers: answers({ face_visible: false }), requireAllChecked: false }),
    ).resolves.toEqual([
      { key: 'face_visible', checked: false },
      { key: 'document_shown', checked: true },
      { key: 'notes_taken', checked: true },
    ]);
  });

  it('refuses a submission that answers an item the template does not have', async () => {
    const extra = [...answers(), { key: 'invented', checked: true }];

    await expect(validate({ answers: extra })).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE,
    });
  });

  it('refuses a submission that skips an item, on any verdict', async () => {
    for (const requireAllChecked of [true, false]) {
      await expect(
        validate({ answers: answers().slice(0, 1), requireAllChecked }),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it('refuses when the pinned template is missing', async () => {
    // The same data-integrity answer the read gives. A submission validated
    // against no template is a submission validated against nothing.
    repository.stored = row({ templateId: null, items: null });

    await expect(validate()).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('refuses when the pinned template is not a checklist', async () => {
    repository.stored = row({ items: [{ key: 'face_visible' }] });

    await expect(validate()).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('writes nothing, whatever the outcome', async () => {
    await validate();
    await validate({ answers: answers({ document_shown: false }) }).catch(() => undefined);

    expect(repository.writes).toEqual([]);
  });
});

describe('recording the answers', () => {
  it('writes them through the executor it was handed', async () => {
    // The verdict's transaction. The answers commit with the verdict or not at
    // all: a checklist beside a verdict that rolled back would be an
    // attestation for a decision nobody made.
    const items = await validate();
    await service.record(SESSION, items, transaction);

    expect(repository.writes).toEqual([{ sessionId: SESSION, items, executor: transaction }]);
  });

  it('writes exactly what validation resolved, in template order', async () => {
    const items = await validate({
      answers: [...answers({ notes_taken: false })].reverse(),
    });
    await service.record(SESSION, items, transaction);

    expect(repository.writes[0]?.items).toEqual([
      { key: 'face_visible', checked: true },
      { key: 'document_shown', checked: true },
      { key: 'notes_taken', checked: false },
    ]);
  });

  it('opens no transaction of its own', async () => {
    // Asserted structurally: the only executor the repository ever sees is the
    // one passed in. A service that opened one would have to pass something
    // else.
    await service.record(SESSION, await validate(), transaction);

    expect(repository.writes.every((write) => write.executor === transaction)).toBe(true);
  });
});
