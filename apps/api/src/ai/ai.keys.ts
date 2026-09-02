/**
 * How the AI HUD is addressed and stored in Redis (T31).
 *
 * Isolated from anything that touches a client for the reason `call.keys.ts`
 * and `queue.keys.ts` are: a key is where a mistake becomes a cross-session
 * leak, and serialising a hash is exactly the kind of code that should be
 * exhaustively testable without a Redis.
 *
 * The HUD is temporary and authoritative for nothing (D2). Two things read it:
 * the agent's panel, live, and T35's verdict transaction, once —
 * `06-database-schema.md` §"Snapshot Redis HUD -> session_ai_summaries" makes
 * this the source of that row. That second reader is why `model_versions` is
 * stored even though §36's example does not list it: the column exists in §19,
 * and the AI service is the only party that ever knew the answer.
 */

import type { AiHudPayload, LivenessStatus, OcrStatus } from '@vcip/shared';
import { isLivenessStatus, isOcrStatus } from '@vcip/shared';

/** One session's HUD: `session:hud:{session_id}` (`06-database-schema.md` §36). */
export function hudKey(sessionId: string): string {
  return `session:hud:${sessionId}`;
}

/**
 * Twenty-four hours (§36, and §39's retention table).
 *
 * The ceiling rather than a guess: the HUD outlives the call so a verdict
 * submitted after a pause still has something to snapshot, and expires so an
 * abandoned session cannot leave a key behind forever. Nothing reads it once
 * T35 has copied it into PostgreSQL.
 */
export const HUD_TTL_SECONDS = 24 * 60 * 60;

/**
 * The hash fields.
 *
 * A hash rather than a JSON string, per §36, which lists the HUD field by
 * field. It also means T35 can read the four business values without parsing,
 * and that a partial write can never leave behind a document that is half one
 * result and half another.
 */
export const HudField = {
  LIVENESS_SCORE: 'liveness_score',
  LIVENESS_STATUS: 'liveness_status',
  FACE_MATCH_SCORE: 'face_match_score',
  OCR_STATUS: 'ocr_status',
  MODEL_VERSIONS: 'model_versions',
  UPDATED_AT: 'updated_at',
} as const;

/** Redis has no null. A score that was not produced is stored as this. */
const ABSENT = '';

const scoreToField = (score: number | null): string => (score === null ? ABSENT : String(score));

/**
 * Read a score back.
 *
 * Anything that is not a plain integer comes back as `null`, including the
 * empty string. `null` and `0` mean opposite things on the HUD — "no answer"
 * against "a confident zero" — so a value that cannot be read is the absent
 * one, never the confident one.
 */
const scoreFromField = (value: string | undefined): number | null => {
  if (value === undefined || value === ABSENT) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
};

/** The flat field map written to Redis. */
export function toHudFields(payload: AiHudPayload): Record<string, string> {
  return {
    [HudField.LIVENESS_SCORE]: scoreToField(payload.liveness_score),
    [HudField.LIVENESS_STATUS]: payload.liveness_status,
    [HudField.FACE_MATCH_SCORE]: scoreToField(payload.face_match_score),
    [HudField.OCR_STATUS]: payload.ocr_status,
    // The one field that is not flat. Kept as JSON rather than exploded into
    // `model_versions.liveness` and friends, because the keys are the AI
    // service's to choose and a schema here would have to be changed whenever
    // it added a fourth check.
    [HudField.MODEL_VERSIONS]: JSON.stringify(payload.model_versions),
    [HudField.UPDATED_AT]: payload.updated_at,
  };
}

/**
 * Rebuild a HUD from what Redis returned, or `null` if it is not usable.
 *
 * Total and defensive. The hash is a cache that a flush can empty, a partial
 * write can truncate, and an older release could have written differently
 * (D2); every one of those has to read as "no HUD" rather than as a HUD with
 * a missing status, because the panel and T35 both take what this returns at
 * face value.
 */
export function fromHudFields(
  sessionId: string,
  fields: Record<string, string> | null,
): AiHudPayload | null {
  if (fields === null || Object.keys(fields).length === 0) return null;

  const liveness = fields[HudField.LIVENESS_STATUS];
  const ocr = fields[HudField.OCR_STATUS];
  const updatedAt = fields[HudField.UPDATED_AT];

  if (!isLivenessStatus(liveness) || !isOcrStatus(ocr)) return null;
  if (updatedAt === undefined || updatedAt.length === 0) return null;

  return {
    session_id: sessionId,
    liveness_score: scoreFromField(fields[HudField.LIVENESS_SCORE]),
    liveness_status: liveness satisfies LivenessStatus,
    face_match_score: scoreFromField(fields[HudField.FACE_MATCH_SCORE]),
    ocr_status: ocr satisfies OcrStatus,
    model_versions: parseModelVersions(fields[HudField.MODEL_VERSIONS]),
    updated_at: updatedAt,
  };
}

/**
 * Model versions, or nothing.
 *
 * Written by this API from a validated payload, so malformed JSON here means
 * the key was written by something else or corrupted. An empty map is the
 * honest answer: the rest of the HUD is still worth showing, and T35 storing
 * `{}` says "we do not know" rather than naming a model that never ran.
 */
function parseModelVersions(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const versions: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') versions[key] = value;
    }
    return versions;
  } catch {
    return {};
  }
}
