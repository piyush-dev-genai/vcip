import { describe, expect, it } from 'vitest';
import { createHealthServer, healthPayload } from './health.js';
import type { AddressInfo } from 'node:net';

describe('healthPayload', () => {
  it('reports ok for the egress service', () => {
    const result = healthPayload();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('egress');
    expect(typeof result.uptime_s).toBe('number');
  });
});

describe('createHealthServer', () => {
  it('serves GET /health and 404s everything else', async () => {
    const server = createHealthServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const ok = await fetch(`http://127.0.0.1:${port}/health`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { service: string };
      expect(body.service).toBe('egress');

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
