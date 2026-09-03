/**
 * Reading the AI service's answer to a document check.
 *
 * This file exists because of the bug it is named after. The client read
 * `body.data.accepted`, expecting the Control API's own `{ data: ... }`
 * envelope — but the AI service is FastAPI and returns its dict bare. So
 * `body.data` was always `undefined`, **every** check reported `accepted:
 * false`, and an agent was told "no AI on this call" while the analyzer was
 * running fine and publishing the result to their HUD a moment later. Two
 * panels, contradicting each other, one of them reading a field that never
 * existed.
 *
 * The service tests could not catch it: they substitute the `DocumentReader`
 * port, which is the right seam for testing who may ask and what happens when
 * the answer is no — and precisely the wrong one for testing whether we can
 * read the answer at all. That needs the literal bytes the other service sends,
 * written out here rather than mirrored from a type, because `apps/ai` is
 * outside the build graph and nothing else compares the two.
 */

import { describe, expect, it } from 'vitest';
import { acceptedFrom, documentPathFor } from './ai-document.client.js';

/**
 * Exactly what `POST /internal/sessions/{id}/document` returns.
 *
 * Copied from a live response, not built from a type. If the AI service ever
 * wraps its body or renames the field, this is what notices.
 */
const ACCEPTED = {
  session_id: '41099e6e-988e-439b-8904-254951d4db99',
  document_type: 'PAN',
  accepted: true,
  status: 'UNREADABLE',
};

const NOT_ACCEPTED = {
  session_id: '41099e6e-988e-439b-8904-254951d4db99',
  document_type: 'PAN',
  accepted: false,
  status: null,
};

describe('the wire shape the AI service actually sends', () => {
  it('reads a bare accepted body', () => {
    // The regression. This was `false` for months of nothing, because the
    // client looked for a `data` envelope the AI service does not use.
    expect(acceptedFrom(ACCEPTED)).toBe(true);
  });

  it('reads a bare not-accepted body', () => {
    expect(acceptedFrom(NOT_ACCEPTED)).toBe(false);
  });

  it('does not accept a body wrapped in the Control API envelope', () => {
    // Stated so the mistake cannot be made in reverse: if somebody "fixes" the
    // AI service to wrap its responses, this fails rather than silently
    // reporting every check as refused again.
    expect(acceptedFrom({ data: { accepted: true } })).toBe(false);
  });
});

describe('anything unreadable is not an acceptance', () => {
  it.each([
    ['null', null],
    ['a string', 'accepted'],
    ['a number', 1],
    ['an array', [{ accepted: true }]],
    ['an empty object', {}],
    ['a truthy string', { accepted: 'true' }],
    ['a truthy number', { accepted: 1 }],
    ['undefined', undefined],
  ])('refuses %s', (_label, body) => {
    // Wrong in the safe direction. A false negative costs the agent a retry; a
    // false positive would claim a check ran when nothing did, and the agent
    // would wait for a result that is never coming.
    expect(acceptedFrom(body)).toBe(false);
  });
});

describe('the path', () => {
  it('puts the session id in the path, encoded', () => {
    expect(documentPathFor('41099e6e-988e-439b-8904-254951d4db99')).toBe(
      '/internal/sessions/41099e6e-988e-439b-8904-254951d4db99/document',
    );
  });

  it('encodes an id that would otherwise change the path', () => {
    expect(documentPathFor('../analyze')).toBe('/internal/sessions/..%2Fanalyze/document');
  });
});
