import { createServer, type Server } from 'node:http';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptime_s: number;
  timestamp: string;
}

/**
 * Liveness payload.
 *
 * The egress worker holds no PostgreSQL or Redis credentials by design: every
 * state change it causes goes through the Control API's /internal endpoints.
 * See docs/05-development-plan.md section 2.5.
 */
export function healthPayload(): HealthResponse {
  return {
    status: 'ok',
    service: 'egress',
    version: process.env.npm_package_version ?? '0.0.0',
    uptime_s: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * A worker has no HTTP surface of its own, but it still needs a liveness probe
 * for container orchestration. This serves GET /health and nothing else.
 */
export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthPayload()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });
}
