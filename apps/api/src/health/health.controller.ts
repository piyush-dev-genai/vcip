import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptime_s: number;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  /**
   * Liveness probe.
   *
   * Deliberately has no datastore dependencies: this reports that the process
   * is up, not that PostgreSQL, Redis or LiveKit are reachable. Dependency
   * readiness is added alongside those integrations in later tasks.
   */
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      version: process.env.npm_package_version ?? '0.0.0',
      uptime_s: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
