/**
 * Where a recording is written (T28, R17).
 *
 * The egress container uploads the file itself — the Control API never touches
 * the bytes (I6) — so this configuration is not for a client we hold. It is
 * handed to LiveKit and used *inside the egress container*, which is the whole
 * reason for the one surprising field below.
 *
 * `egressEndpoint` exists because the API and the egress container reach the
 * same object store by different addresses. On the host, MinIO is
 * `http://localhost:9000`; from inside the compose network it is
 * `http://minio:9000`, and a recording configured with the host's address would
 * fail to upload from a container that cannot resolve it. In production both
 * are the same S3 endpoint and the variable is simply unset. That is D24's rule
 * — the difference is environment, not code — expressed as one optional
 * override rather than a conditional.
 */

import { Inject } from '@nestjs/common';

export const RECORDING_CONFIG = Symbol('RECORDING_CONFIG');

export const InjectRecordingConfig = (): ParameterDecorator => Inject(RECORDING_CONFIG);

export interface RecordingConfig {
  /**
   * Whether to record at all.
   *
   * `AI_ENABLED`'s counterpart, and the same argument. Recording exists to feed
   * the evidence pipeline — T38 onwards — and a deployment that stops at the
   * Core MVP has nothing downstream to read the file. Starting one anyway costs
   * a paid transcode on every call and writes an `EGRESS_STARTED` event
   * claiming evidence exists for a session whose evidence nobody will process.
   *
   * Off is not a degraded mode. Nothing in the call path depends on a recording
   * (`recording.service.ts` never fails a call), so this changes what happens
   * after `CALL_STARTED` and nothing else.
   */
  readonly enabled: boolean;
  /** The temporary bucket recordings land in before T38 processes them. */
  readonly bucket: string;
  readonly region: string;
  /** The endpoint the **egress container** uploads through. */
  readonly egressEndpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO needs path-style addressing; most S3 deployments do not. */
  readonly forcePathStyle: boolean;
}

const required = (name: string, value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value;
};

/**
 * Build it from the environment, failing fast.
 *
 * The error names the missing variable and never its value: these are storage
 * credentials, and a config error is one of the easiest places to spill one.
 */
export function recordingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RecordingConfig {
  // Checked before anything is required. A deployment that is not recording
  // has no object store, and demanding credentials for a bucket it will never
  // write to would make the flag unusable — which is the failure `AI_ENABLED`
  // avoids by asking the same question in the same order.
  if ((env['RECORDING_ENABLED'] ?? 'true').toLowerCase() === 'false') {
    return redactableRecordingConfig({
      enabled: false,
      bucket: '',
      region: '',
      egressEndpoint: '',
      accessKeyId: '',
      secretAccessKey: '',
      forcePathStyle: false,
    });
  }

  const endpoint = required('S3_ENDPOINT', env['S3_ENDPOINT']);

  return redactableRecordingConfig({
    enabled: true,
    bucket: required('S3_BUCKET_TEMP', env['S3_BUCKET_TEMP']),
    region: required('S3_REGION', env['S3_REGION']),
    // Falls back to the API's own endpoint, which is correct wherever the two
    // agree — production — and overridden where they cannot.
    egressEndpoint: env['S3_EGRESS_ENDPOINT']?.trim() || endpoint,
    accessKeyId: required('AWS_ACCESS_KEY_ID', env['AWS_ACCESS_KEY_ID']),
    secretAccessKey: required('AWS_SECRET_ACCESS_KEY', env['AWS_SECRET_ACCESS_KEY']),
    forcePathStyle: (env['S3_FORCE_PATH_STYLE'] ?? 'false').toLowerCase() === 'true',
  });
}

/**
 * Wrap so stringifying or inspecting cannot spill the secret access key.
 *
 * The same treatment `auth.config.ts` and `livekit.config.ts` give theirs, for
 * the same three routes into a log line.
 */
export function redactableRecordingConfig(config: RecordingConfig): RecordingConfig {
  return Object.freeze(
    Object.defineProperties(
      { ...config },
      {
        toJSON: { value: () => '[RecordingConfig redacted]', enumerable: false },
        toString: { value: () => '[RecordingConfig redacted]', enumerable: false },
        [Symbol.for('nodejs.util.inspect.custom')]: {
          value: () => '[RecordingConfig redacted]',
          enumerable: false,
        },
      },
    ) as RecordingConfig,
  );
}
