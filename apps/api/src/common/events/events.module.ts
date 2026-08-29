import { Module } from '@nestjs/common';
import { DrizzleSessionEventWriter, SESSION_EVENT_WRITER } from './session-event.writer.js';

/**
 * The append-only session event writer.
 *
 * Deliberately NOT `@Global()`. A global provider works only because something
 * else in the graph imported it, which makes a module that depends on it appear
 * self-sufficient when it is not — `sessions.module.spec.ts` exists precisely
 * because that class of wiring failure is invisible until boot. Consumers
 * import this module explicitly and can therefore be resolved on their own.
 *
 * The writer holds no connection and no state — the executor arrives per call —
 * so a single instance shared by every consumer is exactly right.
 */
@Module({
  providers: [{ provide: SESSION_EVENT_WRITER, useClass: DrizzleSessionEventWriter }],
  exports: [SESSION_EVENT_WRITER],
})
export class EventsModule {}
