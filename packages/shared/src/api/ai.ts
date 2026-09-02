/**
 * The AI result contract (T30).
 *
 * One schema for the one payload that crosses the boundary between the Python
 * AI service and the Control API:
 *
 * ```text
 * apps/ai  --POST /internal/ai/result-->  apps/api  --T31-->  Redis HUD --> WS
 * ```
 *
 * `05-development-plan.md` §4 puts `apps/ai` outside the build graph — it
 * cannot import this package — so the Python side mirrors these field names by
 * hand. That makes this file the specification rather than a convenience, and
 * it is why the schema is strict: a misspelled key from a service nobody can
 * type-check against is exactly the failure this catches.
 *
 * The AI never decides anything (I7, D6). This payload is a signal for the
 * agent to weigh, the Control API stores it as a summary, and no field here
 * participates in a verdict.
 */

import { z } from 'zod';
import { LivenessStatus, OcrStatus } from '../enums.js';

/**
 * A model score, or nothing.
 *
 * Integer 0-100. `session_ai_summaries` types the columns `NUMERIC(5,2)`,
 * which holds an integer exactly; two decimal places would be precision the
 * model does not have.
 *
 * Nullable because an undecided check has no score, and a zero would render on
 * the agent's HUD as a confident failure. `null` and `0` mean opposite things
 * here, so the schema refuses to let one stand in for the other.
 */
const scoreOrNull = () => z.number().int().min(0).max(100).nullable();

/**
 * The status values, as literal tuples.
 *
 * Written out so zod infers the exact union rather than `string`, which is the
 * same reason `AGENT_AVAILABILITY_VALUES` exists. `ai.spec.ts` asserts each
 * list equals its enum, so a value added to one and not the other fails a test
 * instead of quietly narrowing what the API accepts.
 */
export const LIVENESS_STATUS_VALUES = [
  LivenessStatus.LIVE,
  LivenessStatus.NOT_LIVE,
  LivenessStatus.UNKNOWN,
  LivenessStatus.UNAVAILABLE,
] as const;

export const OCR_STATUS_VALUES = [
  OcrStatus.PASS,
  OcrStatus.FAIL,
  OcrStatus.NO_DOCUMENT,
  OcrStatus.UNAVAILABLE,
] as const;

/**
 * `POST /internal/ai/result` — `05-api-contract.md` §23.
 *
 * Two departures from the example payload printed there, both required for the
 * result to survive to the column it is stored in:
 *
 *   - The scores are nullable. §23 shows a healthy call; an unavailable check
 *     has no number to report, and `session_ai_summaries` types both score
 *     columns `NULL`-able for that reason.
 *   - `model_versions` is carried. §23 omits it and §19 stores it, and the AI
 *     service is the only party that knows which models produced the result.
 *     Without it the column could only ever be filled by the Control API
 *     guessing.
 */
export const aiResultSchema = z.strictObject({
  /** The session analysed. The AI service is told which; it never chooses. */
  session_id: z.uuid(),

  liveness_score: scoreOrNull(),
  liveness_status: z.enum(LIVENESS_STATUS_VALUES),

  /**
   * Face match reports a score and no status on the wire.
   *
   * The AI service tracks a status internally — "the model said 43" and "the
   * model never ran" are different facts — but §23 and §19 both give face
   * match a score alone, and inventing a column here would be this task
   * changing the database schema.
   */
  face_match_score: scoreOrNull(),

  ocr_status: z.enum(OCR_STATUS_VALUES),

  /**
   * Which model produced each check, e.g. `{ "liveness": "demo-v1" }`
   * (`06-database-schema.md` §19).
   *
   * Per check rather than one version for the service, because the three are
   * separate models that will not move together. Kept small and opaque: it is
   * stored as JSONB and read by humans asking which model made a call that is
   * being disputed.
   */
  model_versions: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
});

export type AiResultRequest = z.infer<typeof aiResultSchema>;

/**
 * `POST /internal/sessions/{id}/analyze` on the **AI service** — the other
 * direction, and the only request the Control API makes of it.
 *
 * Sent when both participants are in the room (the `CALL_STARTED` moment T28
 * also records on), because that is when there is a room with a customer in it
 * to subscribe to. The AI service holds no database and no Redis (§5), so
 * everything it needs to do its job is in this payload.
 *
 * The token is minted by the Control API and is subscribe-only. The AI service
 * therefore holds no LiveKit signing credentials: a compromised analyzer can
 * read the one room it was given and cannot mint itself another.
 *
 * The session id travels in the path, not the body. Carrying it in both would
 * be two statements of one fact that a caller could make disagree.
 */
export const analyzeRequestSchema = z.strictObject({
  /** Deterministically `vcip_{session_id}` (R2), but sent rather than derived. */
  room_name: z.string().min(1).max(128),
  /** A subscribe-only LiveKit join credential for `room_name`. */
  token: z.string().min(1),
  /** Where the analyzer publishes its results. */
  livekit_url: z.string().min(1),
});

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

/**
 * What `ai.updated` carries, and what the Redis HUD holds (T31).
 *
 * The same five facts the AI service reported, plus the instant they were
 * reported. `updated_at` is the field the agent's panel reads to decide the
 * HUD has gone stale — an AI service that is killed sends nothing at all
 * rather than sending `UNAVAILABLE`, so freshness is the only thing that can
 * tell the difference between "the model says LIVE" and "the model said LIVE
 * two minutes ago and has not been heard from since".
 *
 * Deliberately identical in shape to what T35 snapshots into
 * `session_ai_summaries`, because it is: `06-database-schema.md` §"Snapshot
 * Redis HUD -> session_ai_summaries" makes the HUD the source of that row, so
 * anything the column needs — `model_versions` included — has to survive here.
 */
export interface AiHudPayload {
  readonly session_id: string;
  readonly liveness_score: number | null;
  readonly liveness_status: LivenessStatus;
  readonly face_match_score: number | null;
  readonly ocr_status: OcrStatus;
  readonly model_versions: Readonly<Record<string, string>>;
  /** ISO 8601, server time. When the Control API took delivery of the result. */
  readonly updated_at: string;
}

/**
 * How long an agent's panel trusts a HUD before calling it unavailable.
 *
 * Ten seconds — five missed cycles at T30's two-second cadence, so an ordinary
 * late result never trips it and a dead analyzer trips it quickly. This is the
 * mechanism behind T32's gate: killing the AI mid-call produces no traffic at
 * all, and a HUD with no freshness rule would go on showing the last confident
 * score for the rest of the call.
 */
export const AI_HUD_STALE_AFTER_MS = 10_000;
