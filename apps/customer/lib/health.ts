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
 * Reports that the process is up. It deliberately performs no dependency
 * checks: the Control API is the authority on business state, and this app
 * holds no datastore connections.
 */
export function healthPayload(): HealthResponse {
  return {
    status: 'ok',
    service: 'customer',
    version: process.env.npm_package_version ?? '0.0.0',
    uptime_s: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
