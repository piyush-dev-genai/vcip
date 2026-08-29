import { describe, expect, it } from 'vitest';
import type { BadRequestException } from '@nestjs/common';
import { ErrorCode, consentSchema, createSessionSchema, preflightSchema } from '@vcip/shared';
import { ZodValidationPipe, describeIssues } from './zod-validation.pipe.js';

const meta = { type: 'body' } as const;

const failureOf = (
  pipe: ZodValidationPipe<unknown>,
  value: unknown,
): { code: string; message: string } => {
  try {
    pipe.transform(value, meta);
  } catch (error) {
    const response = (error as BadRequestException).getResponse();
    return response as { code: string; message: string };
  }
  throw new Error('expected the pipe to reject');
};

describe('valid input', () => {
  it('returns the parsed value', () => {
    const pipe = new ZodValidationPipe(createSessionSchema);
    expect(pipe.transform({ external_ref: 'loan-1', language: 'en' }, meta)).toEqual({
      external_ref: 'loan-1',
      language: 'en',
    });
  });
});

describe('invalid input', () => {
  it('raises a 400 with the documented error code', () => {
    const pipe = new ZodValidationPipe(consentSchema);
    let status = 0;
    try {
      pipe.transform({ accepted: 'yes', consent_version: 'v1' }, meta);
    } catch (error) {
      status = (error as BadRequestException).getStatus();
    }
    expect(status).toBe(400);
    expect(failureOf(pipe, { accepted: 'yes', consent_version: 'v1' }).code).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('names the offending field, which comes from our own schema', () => {
    const pipe = new ZodValidationPipe(preflightSchema);
    const failure = failureOf(pipe, { camera_width: 0 });
    expect(failure.message).toContain('camera_width');
  });

  it('treats a missing body as a validation failure, not a crash', () => {
    const pipe = new ZodValidationPipe(consentSchema);
    expect(failureOf(pipe, undefined).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(failureOf(pipe, null).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(failureOf(pipe, 'not an object').code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe('the message never echoes submitted values', () => {
  it('does not quote a rejected value', () => {
    const pipe = new ZodValidationPipe(consentSchema);
    const failure = failureOf(pipe, {
      accepted: 'FAKE-SENSITIVE-VALUE',
      consent_version: 'FAKE-CONSENT-SENTINEL',
    });
    expect(failure.message).not.toContain('FAKE-SENSITIVE-VALUE');
    expect(failure.message).not.toContain('FAKE-CONSENT-SENTINEL');
  });

  it('counts unrecognised keys instead of naming them', () => {
    // Those key names are chosen by the caller. Reflecting attacker-supplied
    // text into a response body buys nothing diagnostically.
    const pipe = new ZodValidationPipe(createSessionSchema);
    const failure = failureOf(pipe, {
      external_ref: 'r',
      language: 'en',
      '<script>alert(1)</script>': 1,
      FAKE_UNKNOWN_KEY: 2,
    });
    expect(failure.message).not.toContain('<script>');
    expect(failure.message).not.toContain('FAKE_UNKNOWN_KEY');
    expect(failure.message).toContain('2 unrecognized field(s)');
  });

  it('does not leak a coordinate through a nested path', () => {
    const pipe = new ZodValidationPipe(preflightSchema);
    const failure = failureOf(pipe, {
      camera_width: 1280,
      camera_height: 720,
      microphone_level: 62.5,
      network_rtt_ms: 48,
      downlink_kbps: 4200,
      lighting_score: 71,
      stability_score: 88,
      latitude: 28.6139,
    });
    expect(failure.message).not.toContain('28.6139');
  });
});

describe('describeIssues', () => {
  it('bounds the message length by naming at most eight fields', () => {
    const issues = Array.from({ length: 20 }, (_, index) => ({
      code: 'invalid_type' as const,
      path: [`field_${index}`],
      message: 'x',
    }));
    const described = describeIssues(issues as never);
    expect(described).toContain('field_0');
    expect(described).toContain('and 12 more');
    expect(described.length).toBeLessThan(300);
  });

  it('deduplicates a field that produced several issues', () => {
    const issues = [
      { code: 'too_small' as const, path: ['downlink_kbps'], message: 'x' },
      { code: 'invalid_type' as const, path: ['downlink_kbps'], message: 'y' },
    ];
    const described = describeIssues(issues as never);
    expect(described.match(/downlink_kbps/g)).toHaveLength(1);
  });

  it('falls back to a generic sentence when no field can be named', () => {
    expect(describeIssues([])).toBe('The request is invalid.');
  });

  it('joins a nested path with dots', () => {
    const issues = [{ code: 'invalid_type' as const, path: ['outer', 'inner'], message: 'x' }];
    expect(describeIssues(issues as never)).toContain('outer.inner');
  });
});
