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
