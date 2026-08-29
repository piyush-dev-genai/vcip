/**
 * Request-body validation against a `@vcip/shared` schema.
 *
 * The schemas live in the shared package so the browser and the server agree on
 * what a valid body is. This pipe is the server half: it parses, and on failure
 * raises the documented `400 VALIDATION_ERROR`.
 *
 * The one subtlety is the message. A validation error is the easiest place in
 * an API to reflect submitted input back to the caller, and this system carries
 * consent versions, coordinates, and enterprise references in request bodies.
 * So the message names FIELDS and never VALUES:
 *
 *   - Field paths come from our own schema, so they are safe to echo.
 *   - Unrecognised keys are counted, not named — those strings came from the
 *     client, and echoing attacker-chosen text is not worth the diagnostic.
 *   - zod's own issue messages are never used; several of them quote the
 *     received value.
 */

import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { ZodIssue, ZodType } from 'zod';

/** Enough fields to be useful, few enough to keep the message bounded. */
const MAX_FIELDS_NAMED = 8;

export function describeIssues(issues: readonly ZodIssue[]): string {
  const fields = new Set<string>();
  let unrecognised = 0;

  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      unrecognised += issue.keys.length;
      continue;
    }
    const path = issue.path.map((segment) => String(segment)).join('.');
    if (path.length > 0) fields.add(path);
  }

  const parts: string[] = [];
  if (fields.size > 0) {
    const named = [...fields].slice(0, MAX_FIELDS_NAMED);
    const suffix = fields.size > named.length ? `, and ${fields.size - named.length} more` : '';
    parts.push(`invalid or missing: ${named.join(', ')}${suffix}`);
  }
  if (unrecognised > 0) {
    parts.push(`${unrecognised} unrecognized field(s)`);
  }

  return parts.length === 0
    ? 'The request is invalid.'
    : `The request is invalid (${parts.join('; ')}).`;
}

/**
 * Validate one argument against a schema.
 *
 * Constructed with its schema rather than injected, so a route reads
 * `@Body(new ZodValidationPipe(consentSchema))` and the contract for that route
 * is visible at the route.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    // A body-parser that saw no body hands over `{}`; an explicitly null body
    // arrives as null. Both must fail against a schema with required fields,
    // and both do — but `undefined` would be reported as a whole-object issue
    // with an empty path, which produces no field names. Normalising to `{}`
    // keeps the message useful.
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;

    throw new BadRequestException({
      code: ErrorCode.VALIDATION_ERROR,
      message: describeIssues(result.error.issues),
    });
  }
}
