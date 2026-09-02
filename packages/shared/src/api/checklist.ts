/**
 * The verification checklist contract (T33, D8).
 *
 * `GET /v1/agent/sessions/:id/checklist` answers with the template **pinned to
 * that session**, never with the tenant's current one. Schema §18 is explicit
 * about why: changing a tenant's active checklist must not change the meaning
 * of a verification that has already happened. `sessions.checklist_template_id`
 * is written once at creation (T12) and read here.
 *
 * The item shape is defined here rather than in the API because two parties
 * need the same answer for different reasons: the Control API validates what
 * PostgreSQL hands back, and T34 will validate what an agent submits against
 * the same keys. One definition means a template the API accepts cannot be a
 * template the verdict rejects.
 *
 * `checklist_templates.items` is `jsonb` with no shape constraint at the
 * database level, so this schema is not decoration — it is the only thing
 * standing between a malformed template and an agent being shown a checklist
 * with items missing. It is deliberately strict, and the API treats a failure
 * as a data-integrity error rather than degrading to a shorter list: a
 * verification approved against silently-dropped required items is the one
 * outcome this file exists to prevent.
 */

import { z } from 'zod';

/**
 * An item key, as it appears in a template and in a verdict payload.
 *
 * Lowercase snake_case, matching `face_visible` / `document_shown` /
 * `customer_verified` in schema §10. Constrained rather than free text because
 * the key is a stable identifier: it is the primary key of
 * `session_checklist_items` alongside the session, it travels in the verdict
 * request, and it will appear in the evidence package. A key that differed
 * only by case or whitespace would produce two rows meaning one thing.
 */
export const CHECKLIST_ITEM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const checklistItemSchema = z.strictObject({
  key: z.string().regex(CHECKLIST_ITEM_KEY_PATTERN),
  /** What the agent reads on screen. Human text, not an identifier. */
  label: z.string().min(1).max(200),
  /**
   * Whether a verdict may be submitted without this item checked (T34).
   *
   * Required rather than defaulted. A template that omitted the field would
   * otherwise become a template of optional items, which is the safe-looking
   * default and the wrong one: it turns a checklist into a suggestion.
   */
  required: z.boolean(),
});

export type ChecklistItem = z.infer<typeof checklistItemSchema>;

/**
 * A template's items, as stored in `checklist_templates.items`.
 *
 * At least one item, because a checklist with nothing in it is not a checklist
 * — an active template in that state is a misconfiguration worth surfacing,
 * not a session that skips verification. Capped at fifty because the list is
 * read on screen during a live call by a person.
 *
 * Keys are unique. Duplicates would collide on `session_checklist_items`'
 * primary key at verdict time, which is a long way from here to discover a
 * template was wrong.
 */
export const checklistItemsSchema = z
  .array(checklistItemSchema)
  .min(1)
  .max(50)
  .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
    message: 'checklist item keys must be unique',
  });

/**
 * `GET /v1/agent/sessions/:id/checklist` — `05-api-contract.md` §32.
 *
 * `template_id` and `version` are carried alongside the items because "which
 * checklist was this verification judged against" is a question asked after
 * the fact — by the evidence package, and by whoever is disputing a verdict.
 * Returning only the items would make it unanswerable from the response the
 * agent's portal actually received.
 */
export interface ChecklistResult {
  readonly session_id: string;
  readonly template_id: string;
  /** `checklist_templates.version`. Unique per tenant (schema §10). */
  readonly version: number;
  readonly items: readonly ChecklistItem[];
}

// ------------------------------------------------------------- submission

/**
 * One answer, as an agent submits it (`05-api-contract.md` §18).
 *
 * A key and a boolean, and nothing else. Not a label — the agent does not get
 * to restate what they were asked; not a timestamp — the server stamps
 * `checked_at`; and not a `required` flag, which belongs to the template and
 * would be the client telling the server what the rules are.
 */
export const checklistAnswerSchema = z.strictObject({
  key: z.string().regex(CHECKLIST_ITEM_KEY_PATTERN),
  checked: z.boolean(),
});

export type ChecklistAnswer = z.infer<typeof checklistAnswerSchema>;

/**
 * The `checklist` field of a verdict request.
 *
 * Bounded exactly like a template, because it is answering one: a submission
 * longer than the longest possible checklist is answering something else.
 * Duplicate keys are refused here rather than at the database, where they
 * would collide on `session_checklist_items`' primary key and turn a client
 * mistake into a failed transaction.
 *
 * **Completeness is not checked here**, and cannot be: whether every item was
 * answered is a question about the template this session is pinned to, which
 * only the server can see. `validateSubmission` in the Control API is where
 * the two meet.
 */
export const checklistSubmissionSchema = z
  .array(checklistAnswerSchema)
  .min(1)
  .max(50)
  .refine((answers) => new Set(answers.map((answer) => answer.key)).size === answers.length, {
    message: 'checklist answers must not repeat a key',
  });

export type ChecklistSubmission = z.infer<typeof checklistSubmissionSchema>;

/** One answered item, ready to be written to `session_checklist_items`. */
export interface ResolvedChecklistItem {
  readonly key: string;
  readonly checked: boolean;
}

export type SubmissionDecision =
  | { readonly kind: 'ACCEPTED'; readonly items: readonly ResolvedChecklistItem[] }
  /** Answers naming items this session's template does not contain. */
  | { readonly kind: 'UNKNOWN_ITEMS'; readonly keys: readonly string[] }
  /** Template items the submission did not answer at all. */
  | { readonly kind: 'MISSING_ITEMS'; readonly keys: readonly string[] }
  /** Required items answered `false` on a verdict that requires them. */
  | { readonly kind: 'REQUIRED_UNCHECKED'; readonly keys: readonly string[] };

export interface SubmissionOptions {
  /**
   * Whether every `required` item must be `checked` for this verdict.
   *
   * True for `APPROVED`, false for `REJECTED` and `ABORTED` — a reading of
   * contract §18 rather than a quotation of it. §18 lists "Required checklist
   * items = checked" under preconditions without naming a verdict, and applied
   * literally that makes a rejection impossible in the only case rejections
   * exist for: an agent rejects *because* a required check failed, so demanding
   * every required item be `true` first would leave the only submittable
   * rejection one where nothing was wrong.
   *
   * The checklist is recorded in full for every verdict either way. What varies
   * is whether it gates, not whether it is kept — an auditor asking why a
   * verification was rejected gets the same rows, and the unchecked item is the
   * answer.
   */
  readonly requireAllChecked: boolean;
}

/**
 * Check one submission against the template the session is pinned to (T34).
 *
 * Lives here rather than in the Control API because both sides need the same
 * answer: the server decides whether a verdict may be recorded, and the agent
 * portal decides whether the approve button may be pressed. Two copies of this
 * rule would drift into a button that promises what the server refuses.
 *
 * **Every template item must be answered.** A submission missing a key is
 * refused rather than treated as unchecked: "the agent left it blank" and "the
 * portal is running against an older template than this session is pinned to"
 * produce the same request, and silently recording the second as the first
 * would write down an attestation nobody made.
 *
 * The refusals are ordered from "you are answering the wrong question" to "you
 * answered it in a way this verdict does not allow". Keys come back in template
 * order, so two clients sending the same wrong thing are told the same thing.
 */
export function validateSubmission(
  template: readonly ChecklistItem[],
  answers: readonly ChecklistAnswer[],
  options: SubmissionOptions,
): SubmissionDecision {
  const answered = new Map(answers.map((answer) => [answer.key, answer.checked]));
  const known = new Set(template.map((item) => item.key));

  const unknown = answers.map((answer) => answer.key).filter((key) => !known.has(key));
  if (unknown.length > 0) return { kind: 'UNKNOWN_ITEMS', keys: unknown };

  const missing = template.filter((item) => !answered.has(item.key)).map((item) => item.key);
  if (missing.length > 0) return { kind: 'MISSING_ITEMS', keys: missing };

  if (options.requireAllChecked) {
    const unchecked = template
      .filter((item) => item.required && answered.get(item.key) !== true)
      .map((item) => item.key);
    if (unchecked.length > 0) return { kind: 'REQUIRED_UNCHECKED', keys: unchecked };
  }

  // Template order, not submission order. These rows are the record of what was
  // asked and answered; the order a client serialised them in is not part of it.
  return {
    kind: 'ACCEPTED',
    items: template.map((item) => ({ key: item.key, checked: answered.get(item.key) === true })),
  };
}

/**
 * Would this checklist, as answered, permit an approval?
 *
 * The portal-facing form of the same rule: whether the approve button may be
 * enabled. Asking the rule rather than reimplementing it is the point.
 */
export function approvalReady(
  template: readonly ChecklistItem[],
  answers: readonly ChecklistAnswer[],
): boolean {
  return validateSubmission(template, answers, { requireAllChecked: true }).kind === 'ACCEPTED';
}
