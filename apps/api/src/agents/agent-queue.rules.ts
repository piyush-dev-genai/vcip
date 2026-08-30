/**
 * The agent queue view's rules, as pure functions.
 *
 * Isolated from anything that touches Redis or PostgreSQL for the same reason
 * `queue.keys.ts` is: these are the decisions worth reading in one place, and
 * every one of them is testable without a server.
 *
 * Three rules live here.
 *
 * **Languages are normalised on both sides.** `createSessionSchema` accepts
 * `EN` and `en-IN` and normalises neither, so `sessions.language` holds
 * whatever the enterprise sent; `queueKey` lower-cases before building a key,
 * so that same session sits in `queue:{tenant}:en`. An eligibility check that
 * compared the raw strings would find the session in Redis and then silently
 * drop it against the profile — a hole that only opens for tenants who happen
 * to send mixed case. Both sides go through `normaliseLanguage`, the same
 * function the key builder uses, so they cannot disagree.
 *
 * `en` and `en-IN` remain **different** queues. R13 shards by the language tag
 * as given, and an agent configured for `en` does not see `en-IN`. That is the
 * documented behaviour, not an oversight: collapsing them would be routing, and
 * routing is not in this task.
 *
 * **The merge is by score, then by id.** Redis orders a ZSET by score and
 * breaks ties lexically by member. A merged view across an agent's language
 * queues has to reproduce both halves of that, or two sessions queued in the
 * same millisecond would order differently on each request.
 *
 * **Wait time is derived, never stored.** It is a function of the server clock
 * and `queued_at`, so two calls a second apart legitimately disagree.
 */

import { normaliseLanguage } from '../queue/queue.keys.js';
import type { QueueCandidate } from '../queue/queue.repository.js';

/**
 * How many sessions the agent queue view returns.
 *
 * Fixed, not a request parameter: `docs/05-api-contract.md` §16 defines no
 * request parameters, and a cap the client cannot name is a cap that cannot be
 * argued with. Twenty is a screenful.
 *
 * It is also the per-language candidate bound. The merged top-20 can be drawn
 * entirely from one language, so each queue must contribute up to 20 for the
 * merge to be correct.
 */
export const AGENT_QUEUE_LIMIT = 20;

/**
 * The agent's languages, normalised, de-duplicated, and emptied of blanks.
 *
 * `agent_profiles.languages` is a free-text array with no normalisation on
 * write, so this is where its contents become comparable.
 */
export function eligibleLanguages(languages: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const language of languages) {
    const normalised = normaliseLanguage(language);
    if (normalised.length === 0) continue;
    seen.add(normalised);
  }
  return Object.freeze([...seen]);
}

/** Whether a session's language — as PostgreSQL stored it — is one the agent works. */
export function speaks(languages: readonly string[], sessionLanguage: string): boolean {
  return languages.includes(normaliseLanguage(sessionLanguage));
}

/**
 * Merge per-language candidate lists into one FIFO-ordered list.
 *
 * Ordering is `score` ascending — `sessions.queued_at` in milliseconds, which
 * is what makes the result FIFO across languages rather than grouped by them.
 * Ties break on `sessionId`, matching Redis's own tiebreak within a single
 * queue, so the order is total and stable.
 *
 * A session id appearing in two queues keeps its lowest score. That cannot
 * happen while a session has one language, but a merge that silently duplicated
 * a member would be worse than one that does not.
 */
export function mergeCandidates(
  lists: readonly (readonly QueueCandidate[])[],
): readonly QueueCandidate[] {
  const best = new Map<string, number>();
  for (const list of lists) {
    for (const candidate of list) {
      const existing = best.get(candidate.sessionId);
      if (existing === undefined || candidate.score < existing) {
        best.set(candidate.sessionId, candidate.score);
      }
    }
  }

  return Object.freeze(
    [...best.entries()]
      .map(([sessionId, score]) => ({ sessionId, score }))
      .sort(
        (a, b) =>
          a.score - b.score || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
      ),
  );
}

/**
 * Seconds a session has been waiting, from the server clock.
 *
 * Floored, and never negative. A `queued_at` in the future is clock skew
 * between the API and PostgreSQL, and reporting a negative wait would be
 * reporting the skew rather than the wait.
 */
export function waitSeconds(queuedAt: Date, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - queuedAt.getTime()) / 1000));
}
