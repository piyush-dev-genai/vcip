/**
 * The document check contract.
 *
 * Two things this suite exists to hold down, both of which are promises made in
 * prose elsewhere and would otherwise rot quietly:
 *
 *   - the literal tuples the schemas are built from stay equal to their enums,
 *     so a status added to one and not the other fails here rather than
 *     narrowing what the API accepts,
 *   - and **no schema on this path has a field for a document's contents**.
 *     That is the whole point of the design, and a strict schema is what makes
 *     it a guarantee rather than a rule somebody remembers.
 */

import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CHECK_STATUSES,
  DOCUMENT_TYPES,
  DocumentCheckStatus,
  DocumentType,
} from '../enums.js';
import {
  DOCUMENT_CHECK_STATUS_VALUES,
  DOCUMENT_TYPE_VALUES,
  documentCheckRequestSchema,
  documentReadRequestSchema,
  documentResultSchema,
} from './document.js';

const validResult = {
  session_id: '11111111-1111-4111-8111-111111111111',
  document_type: DocumentType.PAN,
  status: DocumentCheckStatus.VERIFIED,
  model_versions: { document_ocr: 'demo-v1', document_verifier: 'mock-v1' },
};

describe('the status tuples match their enums', () => {
  it('covers every document type', () => {
    expect([...DOCUMENT_TYPE_VALUES].sort()).toEqual([...DOCUMENT_TYPES].sort());
  });

  it('covers every check status', () => {
    expect([...DOCUMENT_CHECK_STATUS_VALUES].sort()).toEqual([...DOCUMENT_CHECK_STATUSES].sort());
  });
});

describe('nothing on this path can carry a document', () => {
  // The assertion the whole design rests on. Each of these is a plausible name
  // for the thing that must never be sent, and a strict schema rejects all of
  // them -- including any a future edit might add without thinking.
  const contents = {
    document_number: '1234 5678 9012',
    number: 'ABCDE1234F',
    name: 'A Customer',
    date_of_birth: '1990-01-01',
    raw_text: 'INCOME TAX DEPARTMENT',
    text: 'anything',
    fields: { number: 'ABCDE1234F' },
    image: 'data:image/jpeg;base64,...',
  };

  it.each(Object.entries(contents))('the result schema refuses %s', (key, value) => {
    const result = documentResultSchema.safeParse({ ...validResult, [key]: value });
    expect(result.success).toBe(false);
  });

  it.each(Object.entries(contents))('the agent request refuses %s', (key, value) => {
    const result = documentCheckRequestSchema.safeParse({
      document_type: DocumentType.PAN,
      [key]: value,
    });
    expect(result.success).toBe(false);
  });

  it('has no field whose name suggests document contents', () => {
    // Belt and braces against a field added later that the list above does not
    // happen to name. The permitted keys are few and all of them are metadata.
    expect(Object.keys(documentResultSchema.shape).sort()).toEqual([
      'document_type',
      'model_versions',
      'reason',
      'session_id',
      'status',
    ]);
  });
});

describe('the result schema', () => {
  it('accepts a verified result', () => {
    expect(documentResultSchema.safeParse(validResult).success).toBe(true);
  });

  it.each(DOCUMENT_CHECK_STATUS_VALUES)('accepts %s', (status) => {
    expect(documentResultSchema.safeParse({ ...validResult, status }).success).toBe(true);
  });

  it('accepts a machine-readable reason', () => {
    const parsed = documentResultSchema.safeParse({
      ...validResult,
      status: DocumentCheckStatus.UNREADABLE,
      reason: 'no_document_in_frame',
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['a sentence with spaces', 'could not read the card'],
    ['an upper-case token', 'NO_DOCUMENT'],
    ['a leading digit', '1_bad'],
    ['a verifier error body', 'HTTP 500: {"pan":"ABCDE1234F"}'],
  ])('refuses %s as a reason', (_label, reason) => {
    // The reason field is the obvious place for a number to leak back in under
    // another name. Constrained to a short lower-case token so a raw error body
    // -- which may quote the request -- cannot be passed through.
    expect(documentResultSchema.safeParse({ ...validResult, reason }).success).toBe(false);
  });

  it('refuses an unknown status', () => {
    expect(documentResultSchema.safeParse({ ...validResult, status: 'MAYBE' }).success).toBe(false);
  });

  it('refuses an unknown document type', () => {
    const parsed = documentResultSchema.safeParse({ ...validResult, document_type: 'VOTER_ID' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a session id that is not a uuid', () => {
    expect(documentResultSchema.safeParse({ ...validResult, session_id: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('the agent request', () => {
  it.each(DOCUMENT_TYPE_VALUES)('accepts %s', (documentType) => {
    expect(documentCheckRequestSchema.safeParse({ document_type: documentType }).success).toBe(
      true,
    );
  });

  it('requires a document type: the reader never guesses', () => {
    expect(documentCheckRequestSchema.safeParse({}).success).toBe(false);
  });

  it('is the same shape the Control API asks the AI service for', () => {
    // Two schemas rather than one shared name, because they are two hops that
    // could diverge -- but today they carry the same single field, and a test
    // saying so is what would notice if one gained a field the other did not.
    expect(Object.keys(documentReadRequestSchema.shape)).toEqual(
      Object.keys(documentCheckRequestSchema.shape),
    );
  });
});
