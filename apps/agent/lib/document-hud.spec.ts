/**
 * How a document check reads on the agent's panel (§19).
 *
 * The rule worth holding down is the one that differs from every other HUD
 * accessor: **a document check survives staleness.** The three continuous
 * checks are hidden once the analyzer goes quiet, because a dead model's last
 * confident score in front of an agent is worse than nothing. A document check
 * is not a live signal — it is a one-off answer about a card the customer held
 * up — and blanking it when sampling stops would hide the answer at exactly the
 * moment the agent has nothing else to go on.
 */

import type { AiHudPayload } from '@vcip/shared';
import {
  AI_HUD_STALE_AFTER_MS,
  DOCUMENT_CHECK_STATUSES,
  DocumentCheckStatus,
  DocumentType,
  LivenessStatus,
  OcrStatus,
} from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPE_LABELS,
  documentSummary,
  hudFor,
  isUnavailable,
  livenessText,
} from './ai-hud';

const SESSION = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-09-02T12:00:00.000Z');

const hud = (overrides: Partial<AiHudPayload> = {}): AiHudPayload => ({
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1' },
  updated_at: new Date(NOW).toISOString(),
  document_type: null,
  document_status: null,
  document_checked_at: null,
  ...overrides,
});

const checked = (
  status: DocumentCheckStatus = DocumentCheckStatus.VERIFIED,
  over: Partial<AiHudPayload> = {},
) =>
  hud({
    document_type: DocumentType.PAN,
    document_status: status,
    document_checked_at: new Date(NOW).toISOString(),
    ...over,
  });

const summaryOf = (payload: AiHudPayload, now = NOW) =>
  documentSummary(hudFor({ [SESSION]: payload }, SESSION, now));

describe('no check has run', () => {
  it('says so rather than inventing a status', () => {
    expect(summaryOf(hud()).status).toBeNull();
    expect(summaryOf(hud()).label).toBeNull();
  });

  it('says so when no HUD has arrived at all', () => {
    expect(documentSummary(hudFor({}, SESSION, NOW)).status).toBeNull();
  });

  it.each([
    ['no type', { document_status: DocumentCheckStatus.VERIFIED }],
    ['no status', { document_type: DocumentType.PAN }],
    [
      'no timestamp',
      { document_type: DocumentType.PAN, document_status: DocumentCheckStatus.VERIFIED },
    ],
  ])('treats a partial check (%s) as none at all', (_label, over) => {
    // A hash with two writers can be read mid-write. Three nulls is the only
    // safe reading of a partial set: a status with no type cannot be labelled.
    expect(summaryOf(hud(over)).status).toBeNull();
  });
});

describe('a check that has run', () => {
  it.each(DOCUMENT_CHECK_STATUSES)('reports %s with a label', (status) => {
    const summary = summaryOf(checked(status));

    expect(summary.status).toBe(status);
    expect(summary.label).not.toBeNull();
    expect(summary.label).not.toBe(status);
  });

  it.each(DOCUMENT_CHECK_STATUSES)('tells the agent what to do about %s', (status) => {
    // The reason there are four statuses and not two. Each asks something
    // different: reposition the card, question the document, or disregard the
    // panel. A red mark with no instruction would leave them guessing.
    expect(summaryOf(checked(status)).advice).not.toBeNull();
  });

  it('gives every outcome different advice', () => {
    const advice = DOCUMENT_CHECK_STATUSES.map((status) => summaryOf(checked(status)).advice);

    expect(new Set(advice).size).toBe(DOCUMENT_CHECK_STATUSES.length);
  });

  it('never tells the agent what verdict to submit (I7)', () => {
    for (const status of DOCUMENT_CHECK_STATUSES) {
      const advice = (summaryOf(checked(status)).advice ?? '').toLowerCase();
      expect(advice).not.toMatch(/\bapprove\b|\breject\b/);
    }
  });

  it('carries the document type so the panel can name it', () => {
    const summary = summaryOf(checked());

    expect(summary.type).toBe(DocumentType.PAN);
    expect(DOCUMENT_TYPE_LABELS[summary.type ?? '']).toBe('PAN');
  });

  it('labels Aadhaar too', () => {
    const summary = summaryOf(
      checked(DocumentCheckStatus.VERIFIED, { document_type: DocumentType.AADHAAR }),
    );

    expect(DOCUMENT_TYPE_LABELS[summary.type ?? '']).toBe('Aadhaar');
  });
});

describe('a document check outlives the sampling loop', () => {
  const stale = () =>
    checked(DocumentCheckStatus.VERIFIED, {
      updated_at: new Date(NOW - AI_HUD_STALE_AFTER_MS - 1).toISOString(),
    });

  it('is still reported when the continuous HUD has gone stale', () => {
    const payload = stale();

    // The continuous panel has given up...
    expect(isUnavailable(hudFor({ [SESSION]: payload }, SESSION, NOW))).toBe(true);
    expect(livenessText(hudFor({ [SESSION]: payload }, SESSION, NOW))).toBeNull();
    // ...and the document answer is still there, which is the whole point.
    expect(summaryOf(payload).status).toBe(DocumentCheckStatus.VERIFIED);
  });

  it('is still reported an hour after the analyzer stopped', () => {
    const payload = stale();

    expect(summaryOf(payload, NOW + 3_600_000).status).toBe(DocumentCheckStatus.VERIFIED);
  });

  it('keeps its own timestamp, not the sampled one', () => {
    // Two clocks, because the two age differently. Sharing `updated_at` would
    // mean a document check expired on the continuous ten-second window.
    const payload = checked(DocumentCheckStatus.VERIFIED, {
      updated_at: new Date(NOW - 60_000).toISOString(),
      document_checked_at: new Date(NOW).toISOString(),
    });

    expect(summaryOf(payload).checkedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('nothing about a document reaches this layer', () => {
  it('has no field that could hold document contents', () => {
    const summary = summaryOf(checked());

    // The panel's whole vocabulary. Adding a field here would mean the server
    // had started sending one, which its schema refuses.
    expect(Object.keys(summary).sort()).toEqual(['advice', 'checkedAt', 'label', 'status', 'type']);
  });
});
