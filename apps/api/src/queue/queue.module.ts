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
 */
@Module({
  providers: [{ provide: QUEUE_REPOSITORY, useClass: RedisQueueRepository }, QueueService],
  exports: [QueueService],
})
export class QueueModule {}
