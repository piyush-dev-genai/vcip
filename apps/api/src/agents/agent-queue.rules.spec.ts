/**
 * The agent queue's pure rules.
 *
 * No Redis, no PostgreSQL, no Nest — these are the decisions the queue view is
 * built from, and each one is asserted on its own so a failure names the rule
 * that broke rather than the endpoint that used it.
 */

import { describe, expect, it } from 'vitest';
import { queueKey } from '../queue/queue.keys.js';
import type { QueueCandidate } from '../queue/queue.repository.js';
import {
  AGENT_QUEUE_LIMIT,
  eligibleLanguages,
  mergeCandidates,
  speaks,
  waitSeconds,
} from './agent-queue.rules.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

const candidate = (sessionId: string, score: number): QueueCandidate => ({ sessionId, score });

describe('tenant-scoped queue keys', () => {
  it('puts the tenant in the key, so a read cannot span tenants', () => {
    expect(queueKey(TENANT_A, 'en')).toBe(`queue:${TENANT_A}:en`);
    expect(queueKey(TENANT_B, 'en')).toBe(`queue:${TENANT_B}:en`);
    expect(queueKey(TENANT_A, 'en')).not.toBe(queueKey(TENANT_B, 'en'));
  });

  it('never produces a wildcard, whatever the language', () => {
    for (const language of ['en', 'HI', 'ta', '  en  ']) {
      expect(queueKey(TENANT_A, language)).not.toContain('*');
      expect(queueKey(TENANT_A, language).startsWith(`queue:${TENANT_A}:`)).toBe(true);
    }
  });
});

describe('language normalisation', () => {
  it('lower-cases and trims, so profile spelling cannot split a queue', () => {
    expect(eligibleLanguages(['EN', 'Hi', '  ta  '])).toEqual(['en', 'hi', 'ta']);
  });

  it('de-duplicates values that differ only by case', () => {
    expect(eligibleLanguages(['en', 'EN', 'En'])).toEqual(['en']);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(eligibleLanguages(['en', '', '   '])).toEqual(['en']);
  });

  it('normalises to exactly what the queue key uses', () => {
    const [language] = eligibleLanguages(['EN']);
    expect(queueKey(TENANT_A, 'EN')).toBe(`queue:${TENANT_A}:${language ?? ''}`);
  });

  it('keeps en and en-IN apart — R13 shards by the tag as given', () => {
    expect(eligibleLanguages(['en'])).not.toContain('en-in');
    expect(speaks(eligibleLanguages(['en']), 'en-IN')).toBe(false);
  });
});

describe('agent language matching', () => {
  const languages = eligibleLanguages(['en', 'hi']);

  it('matches a session language regardless of the case PostgreSQL stored', () => {
    expect(speaks(languages, 'en')).toBe(true);
    expect(speaks(languages, 'EN')).toBe(true);
    expect(speaks(languages, 'Hi')).toBe(true);
  });

  it('rejects a language the agent does not work', () => {
    expect(speaks(languages, 'ta')).toBe(false);
  });

  it('rejects everything when the agent has no languages', () => {
    expect(speaks(eligibleLanguages([]), 'en')).toBe(false);
  });
});

describe('merging language queues', () => {
  it('orders by enqueue time across queues, not by language', () => {
    // en: A@10:00, C@10:05   hi: B@10:02, D@10:06  ->  A B C D
    const en = [candidate('A', 1000), candidate('C', 5000)];
    const hi = [candidate('B', 2000), candidate('D', 6000)];

    expect(mergeCandidates([en, hi]).map((c) => c.sessionId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('gives the same answer whichever order the queues were read in', () => {
    const en = [candidate('A', 1000), candidate('C', 5000)];
    const hi = [candidate('B', 2000), candidate('D', 6000)];

    expect(mergeCandidates([en, hi])).toEqual(mergeCandidates([hi, en]));
  });

  it('breaks equal scores on session id, the way Redis does within one queue', () => {
    const first = [candidate('zzz', 1000)];
    const second = [candidate('aaa', 1000)];

    expect(mergeCandidates([first, second]).map((c) => c.sessionId)).toEqual(['aaa', 'zzz']);
    expect(mergeCandidates([second, first]).map((c) => c.sessionId)).toEqual(['aaa', 'zzz']);
  });

  it('is FIFO: an older session always precedes a newer one', () => {
    const merged = mergeCandidates([
      [candidate('newest', 9000)],
      [candidate('oldest', 1000)],
      [candidate('middle', 5000)],
    ]);
    expect(merged.map((c) => c.sessionId)).toEqual(['oldest', 'middle', 'newest']);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]!.score).toBeGreaterThanOrEqual(merged[i - 1]!.score);
    }
  });

  it('does not duplicate a session that appears in two queues', () => {
    const merged = mergeCandidates([[candidate('A', 5000)], [candidate('A', 1000)]]);
    expect(merged).toEqual([candidate('A', 1000)]);
  });

  it('returns nothing for no queues and for empty queues', () => {
    expect(mergeCandidates([])).toEqual([]);
    expect(mergeCandidates([[], []])).toEqual([]);
  });
});

describe('the result bound', () => {
  it('is a small explicit constant', () => {
    expect(AGENT_QUEUE_LIMIT).toBe(20);
  });

  it('is enough per language that the merged head can come from one queue', () => {
    // All 20 from `en`, none from `hi`: if the per-language read were
    // AGENT_QUEUE_LIMIT / languages.length, half of these would be missing.
    const en = Array.from({ length: AGENT_QUEUE_LIMIT }, (_, i) =>
      candidate(`en-${String(i).padStart(2, '0')}`, 1000 + i),
    );
    const merged = mergeCandidates([en, []]).slice(0, AGENT_QUEUE_LIMIT);

    expect(merged).toHaveLength(AGENT_QUEUE_LIMIT);
    expect(merged[0]!.sessionId).toBe('en-00');
    expect(merged[AGENT_QUEUE_LIMIT - 1]!.sessionId).toBe('en-19');
  });

  it('keeps the oldest when more candidates exist than the bound', () => {
    const many = Array.from({ length: AGENT_QUEUE_LIMIT * 3 }, (_, i) =>
      candidate(`s-${String(i).padStart(3, '0')}`, 1000 + i),
    );
    const merged = mergeCandidates([many]).slice(0, AGENT_QUEUE_LIMIT);

    expect(merged).toHaveLength(AGENT_QUEUE_LIMIT);
    expect(merged.at(-1)!.sessionId).toBe('s-019');
  });
});

describe('wait_seconds', () => {
  const queuedAt = new Date('2026-08-31T10:00:00.000Z');
  const at = (iso: string): number => Date.parse(iso);

  it('is the whole seconds since queued_at', () => {
    expect(waitSeconds(queuedAt, at('2026-08-31T10:00:32.000Z'))).toBe(32);
  });

  it('floors a partial second rather than rounding up', () => {
    expect(waitSeconds(queuedAt, at('2026-08-31T10:00:32.900Z'))).toBe(32);
  });

  it('is zero at the instant of queueing', () => {
    expect(waitSeconds(queuedAt, queuedAt.getTime())).toBe(0);
  });

  it('never goes negative when the clocks disagree', () => {
    expect(waitSeconds(queuedAt, at('2026-08-31T09:59:50.000Z'))).toBe(0);
  });

  it('grows with the server clock, so two reads legitimately differ', () => {
    const first = waitSeconds(queuedAt, at('2026-08-31T10:00:05.000Z'));
    const second = waitSeconds(queuedAt, at('2026-08-31T10:00:09.000Z'));
    expect(second).toBeGreaterThan(first);
  });
});
