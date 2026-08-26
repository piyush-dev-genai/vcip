import { describe, expect, it } from 'vitest';
import { healthPayload } from './health';

describe('healthPayload', () => {
  it('reports ok for the agent service', () => {
    const result = healthPayload();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('agent');
    expect(typeof result.uptime_s).toBe('number');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });
});
