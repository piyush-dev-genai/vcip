import { Global, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS } from './redis.tokens.js';

/**
 * The application Redis client.
 *
 * D2 splits Redis by database: db 0 is application state - presence, queue
 * signalling, and idempotency records - while db 1 is the LiveKit/Egress
 * control plane. This client is db 0 and must never be pointed at db 1.
 *
 * Redis is never the business source of truth. Losing it degrades liveness of
 * the queue and the HUD, and allows an idempotent request to execute a second
 * time; it can never corrupt business state, which PostgreSQL protects.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (): Redis => {
        const url = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
        return new Redis(url, {
          // Application state lives in db 0 (D2).
          db: Number(process.env['REDIS_DB'] ?? 0),
          // Fail fast rather than queueing commands behind a dead connection:
          // the idempotency interceptor must be able to tell that Redis cannot
          // give it a guarantee, not wait indefinitely for one.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: false,
        });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // Nest resolves the provider itself; nothing to close here when the client
    // was never created (for example in a test module that overrides it).
    await Promise.resolve();
  }
}
