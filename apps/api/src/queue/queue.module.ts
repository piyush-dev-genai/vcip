import { Module } from '@nestjs/common';
import { QUEUE_REPOSITORY, RedisQueueRepository } from './queue.repository.js';
import { QueueService } from './queue.service.js';

/**
 * The queue projection module.
 *
 * Deliberately NOT `@Global()`, for the same reason `EventsModule` is not
 * (T13): a global provider resolves only because something else in the graph
 * imported it, which makes a module that depends on it look self-sufficient
 * when it is not. `SessionsModule` imports this explicitly, and
 * `sessions.module.spec.ts` resolves the real graph through the container so
 * that a wiring mistake fails in a test rather than at boot.
 *
 * The Redis client itself comes from T11's global `RedisModule` — one client
 * for the application, as D2 requires.
 *
 * `QUEUE_REPOSITORY` is exported alongside the service for T17's agent queue
 * view, which reads the head of several queues and merges them. That is a
 * port-level read with no session row to hand `QueueService`, and it is the
 * same shape as `SessionsModule` exporting `SESSION_REPOSITORY`. Exporting the
 * token does not widen what the adapter can do: there is still one ZSET
 * implementation and one Redis client.
 */
@Module({
  providers: [{ provide: QUEUE_REPOSITORY, useClass: RedisQueueRepository }, QueueService],
  exports: [QueueService, QUEUE_REPOSITORY],
})
export class QueueModule {}
