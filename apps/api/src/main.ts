import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors/api-error.filter.js';
import { logger } from './common/logging/logger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Global, so no route can return an unshaped error. Every failure leaves as
  // the documented envelope with a request id.
  app.useGlobalFilters(new ApiErrorFilter(logger));

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  logger.info({ event: 'api.started', port }, 'control api listening');
}

void bootstrap();
