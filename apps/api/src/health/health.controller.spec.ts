import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('resolves through the Nest DI container and reports ok', async () => {
    // Instantiating via the testing module proves that decorator metadata is
    // emitted correctly under Vitest + SWC, not just that the class works.
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    const controller = moduleRef.get(HealthController);
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('api');
    expect(typeof result.uptime_s).toBe('number');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });
});
