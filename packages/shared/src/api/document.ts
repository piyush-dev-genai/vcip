/**
 * The document check contract.
 *
 * An agent-triggered read of one identity document, and the one thing about it
 * that is allowed to leave the AI service:
 *
 * ```text
 * agent portal --POST .../document-check--> apps/api --> apps/ai
 *                                                          |
 *                                            OCR -> fields -> verifier
 *                                                          |
 *                             apps/api <--POST /internal/ai/document-result--
 *                                (status only; the fields never left the process)
 * ```
 *
 * **Triggered, not continuous.** `03-system-design.md` §19: *"OCR should be
 * triggered only when the agent/customer indicates that a document is being
 * shown. Do not run expensive OCR on every frame."* The continuous `ocr_status`
 * on the HUD answers a different question — is a document visible at all — and
 * is unchanged by any of this.
 *
 * **No document contents cross this boundary, ever.** The number, the name and
 * the date of birth are read from the frames, handed to the verifier, and
 * dropped. Four documents say so independently and none of them is being
 * amended: `03-system-design.md` §8.3 (not stored in normal tables), §40 (not
 * logged), the webhook contract (not in payloads), and
 * `06-database-schema.md` (not in event payloads). What survives is a status
 * and the document type — enough for an agent to act on and for an auditor to
 * see that a check happened, and not enough to reconstruct the document.
 *
 * That is why `documentResultSchema` is a `strictObject` with no field for
 * them. A schema is a better guarantee than a rule people remember: a field
 * that existed would eventually be filled in.
 */

import { z } from 'zod';
import { DocumentCheckStatus, DocumentType } from '../enums.js';

/**
 * The status values, as literal tuples.
 *
 * Written out so zod infers the exact union rather than `string`, the same
 * reason `OCR_STATUS_VALUES` exists. `document.spec.ts` asserts each list
 * equals its enum, so a value added to one and not the other fails a test
 * rather than quietly narrowing what the API accepts.
 */
export const DOCUMENT_TYPE_VALUES = [DocumentType.AADHAAR, DocumentType.PAN] as const;

export const DOCUMENT_CHECK_STATUS_VALUES = [
  DocumentCheckStatus.VERIFIED,
  DocumentCheckStatus.NOT_VERIFIED,
  DocumentCheckStatus.UNREADABLE,
  DocumentCheckStatus.UNAVAILABLE,
] as const;

/**
 * `POST /v1/agent/sessions/{id}/document-check` — what the agent sends.
 *
 * Only the document type. Not the frame: the AI service already holds decoded
 * frames for this call (D23), so sending an image from the browser would be a
 * second media path carrying the most sensitive bytes in the system past a
 * client that has no need to hold them.
 *
 * Not an `Idempotency-Key` route either, unlike the six mutations D13 covers.
 * Those are at-most-once operations where a replay must not act twice; this one
 * is deliberately repeatable — an unreadable frame is answered by asking the
 * customer to hold the card still and pressing the button again.
 */
export const documentCheckRequestSchema = z.strictObject({
  document_type: z.enum(DOCUMENT_TYPE_VALUES),
});

export type DocumentCheckRequest = z.infer<typeof documentCheckRequestSchema>;

/**
 * `POST /internal/ai/document-result` — what the AI service reports back.
 *
 * The mirror of `aiResultSchema`, and strict for the same reason: `apps/ai` is
 * outside the build graph and cannot import this package, so it mirrors these
 * names by hand and a misspelled key has to fail loudly rather than arrive as
 * `undefined`.
 *
 * Note what is absent, and that its absence is the design: there is no
 * `document_number`, no `name`, no `date_of_birth`, and no `raw_text`.
 */
export const documentResultSchema = z.strictObject({
  /** The session checked. The AI service is told which; it never chooses. */
  session_id: z.uuid(),

  /** Which document was asked for — echoed, so the HUD can label the result. */
  document_type: z.enum(DOCUMENT_TYPE_VALUES),

  status: z.enum(DOCUMENT_CHECK_STATUS_VALUES),

  /**
   * Why, when the status is not `VERIFIED`, in words safe to store.
   *
   * A short machine token such as `no_document_in_frame` or `verifier_timeout`,
   * never the document's contents and never a verifier's raw error body — that
   * is where a number would leak back in under a different name. Bounded, and
   * optional because `VERIFIED` needs no explanation.
   */
  reason: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/)
    .nullable()
    .optional(),

  /**
   * Which reader and which verifier produced this, e.g.
   * `{ "document_ocr": "demo-v1", "document_verifier": "mock-v1" }`.
   *
   * Same shape and same purpose as the continuous result's `model_versions`:
   * the answer to "which model made the call that is being disputed", from the
   * only party that ever knew it.
   */
  model_versions: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
});

export type DocumentResultRequest = z.infer<typeof documentResultSchema>;

/**
 * `POST /internal/sessions/{id}/document` on the **AI service** — the request
 * the Control API makes of it.
 *
 * The session id travels in the path, as it does for `analyze`. Carrying it in
 * both places would be two statements of one fact that a caller could make
 * disagree.
 */
export const documentReadRequestSchema = z.strictObject({
  document_type: z.enum(DOCUMENT_TYPE_VALUES),
});

export type DocumentReadRequest = z.infer<typeof documentReadRequestSchema>;

/**
 * What the agent's portal gets back when it presses the button.
 *
 * `accepted`, not a result. The read runs against a frame burst and then calls
 * an external registry, which is far too long to hold an HTTP request open on
 * a live call; the answer arrives on the socket the HUD already uses (T31).
 * The portal shows "reading..." until it does.
 *
 * `accepted: false` means there was no analysis attached to this call to ask —
 * the AI was never started, or it has already stopped. The call is unaffected
 * either way (D6, T32), which is why this is a normal response and not an error.
 */
export interface DocumentCheckResult {
  readonly session_id: string;
  readonly document_type: DocumentType;
  readonly accepted: boolean;
  /**
   * Why it was not run. Null when it was.
   *
   * A bare boolean was not enough, and the gap showed up the first time this
   * was used in anger: five different situations answered `accepted: false`,
   * the portal had one sentence for all of them, and an agent who double-clicked
   * was told the AI was missing when it was working perfectly.
   *
   * These are facts about our own infrastructure, not about the document or the
   * customer, so there is nothing sensitive in reporting them precisely.
   */
  readonly reason: DocumentCheckRefusal | null;
}

/**
 * The complete set of reasons a check was not run.
 *
 * Closed, so the portal can render a message per case and a new reason cannot
 * appear without someone deciding what the agent should be told.
 *
 *   - `AI_DISABLED` — this deployment is running without AI.
 *   - `NO_ANALYSIS` — nothing is analysing this call: never started, or stopped.
 *   - `UNREACHABLE` — the AI service could not be reached or refused.
 *   - `IN_PROGRESS` — a check for this session is already running. Not a
 *     failure at all: it exists so a double-press does not spend two registry
 *     lookups on one card. A retry *after* an answer is always allowed, which
 *     is the whole point — `UNREADABLE` is answered by repositioning the card
 *     and checking again.
 */
export const DocumentCheckRefusal = {
  AI_DISABLED: 'AI_DISABLED',
  NO_ANALYSIS: 'NO_ANALYSIS',
  UNREACHABLE: 'UNREACHABLE',
  IN_PROGRESS: 'IN_PROGRESS',
} as const;

export type DocumentCheckRefusal = (typeof DocumentCheckRefusal)[keyof typeof DocumentCheckRefusal];

export const DOCUMENT_CHECK_REFUSALS: readonly DocumentCheckRefusal[] = Object.freeze(
  Object.values(DocumentCheckRefusal),
);
