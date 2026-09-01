import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { recordingConfigFromEnv, redactableRecordingConfig } from './recording.config.js';

const SECRET = 'FAKE-storage-secret-for-tests-0123456789';

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ap-south-1',
  S3_BUCKET_TEMP: 'vcip-temp',
  S3_FORCE_PATH_STYLE: 'true',
  AWS_ACCESS_KEY_ID: 'minioadmin',
  AWS_SECRET_ACCESS_KEY: SECRET,
  ...overrides,
});

describe('recordingConfigFromEnv', () => {
  it('reads the temporary bucket recordings land in', () => {
    const config = recordingConfigFromEnv(env());
    expect(config.bucket).toBe('vcip-temp');
    expect(config.region).toBe('ap-south-1');
    expect(config.forcePathStyle).toBe(true);
  });

  it.each([
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET_TEMP',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ])('refuses to start without %s', (name) => {
    expect(() => recordingConfigFromEnv(env({ [name]: undefined }))).toThrow(`${name} is not set`);
  });

  it('treats a blank value as missing', () => {
    expect(() => recordingConfigFromEnv(env({ S3_BUCKET_TEMP: '   ' }))).toThrow('is not set');
  });

  it('never names the value in the error it throws', () => {
    try {
      recordingConfigFromEnv(env({ AWS_SECRET_ACCESS_KEY: undefined }));
      expect.unreachable('expected a throw');
    } catch (error) {
      expect((error as Error).message).toBe('AWS_SECRET_ACCESS_KEY is not set');
    }
  });
});

describe('the endpoint the egress container uploads through', () => {
  /**
   * The API reaches MinIO on the host and the egress container reaches it on
   * the compose network. A recording configured with the host's address would
   * fail to upload from a container that cannot resolve it.
   */
  it('can differ from the API’s own endpoint', () => {
    const config = recordingConfigFromEnv(env({ S3_EGRESS_ENDPOINT: 'http://minio:9000' }));
    expect(config.egressEndpoint).toBe('http://minio:9000');
  });

  /**
   * In production both are the same S3 endpoint, so the override is unset and
   * there is one value rather than two that could drift. D24: the difference
   * is environment, not code.
   */
  it('falls back to the API’s endpoint when unset', () => {
    expect(recordingConfigFromEnv(env()).egressEndpoint).toBe('http://localhost:9000');
  });

  it('falls back when it is blank rather than using an empty address', () => {
    expect(recordingConfigFromEnv(env({ S3_EGRESS_ENDPOINT: '  ' })).egressEndpoint).toBe(
      'http://localhost:9000',
    );
  });
});

describe('path-style addressing', () => {
  it('is off unless asked for', () => {
    expect(recordingConfigFromEnv(env({ S3_FORCE_PATH_STYLE: undefined })).forcePathStyle).toBe(
      false,
    );
  });

  it('accepts any casing of true', () => {
    expect(recordingConfigFromEnv(env({ S3_FORCE_PATH_STYLE: 'TRUE' })).forcePathStyle).toBe(true);
  });
});

describe('redaction', () => {
  const config = recordingConfigFromEnv(env());

  it('does not carry the secret key into JSON', () => {
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(JSON.stringify({ config })).not.toContain(SECRET);
  });

  it('does not carry it into an interpolated string', () => {
    expect(`${String(config)}`).not.toContain(SECRET);
  });

  it('does not carry it into util.inspect, which is how pino logs objects', () => {
    expect(inspect(config)).not.toContain(SECRET);
  });

  it('still exposes it to the client that hands it to LiveKit', () => {
    expect(config.secretAccessKey).toBe(SECRET);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('redacts a config built by hand too', () => {
    const wrapped = redactableRecordingConfig({
      bucket: 'b',
      region: 'r',
      egressEndpoint: 'http://minio:9000',
      accessKeyId: 'k',
      secretAccessKey: SECRET,
      forcePathStyle: true,
    });
    expect(JSON.stringify(wrapped)).not.toContain(SECRET);
  });
});
