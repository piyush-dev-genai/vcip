import { Global, Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { LOGGER } from './logging.tokens.js';
import { logger } from './logger.js';
import { RequestContextMiddleware } from './request-context.middleware.js';

/**
 * Request correlation and the redacting logger.
 *
 * The middleware is applied to every route so no path can escape correlation.
 */
@Global()
@Module({
  providers: [{ provide: LOGGER, useValue: logger }],
  exports: [LOGGER],
})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
