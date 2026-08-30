import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors/api-error.filter.js';
import { corsPolicyFromEnv } from './common/http/cors.config.js';
import { logger } from './common/logging/logger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Browser origin policy (T14). Applied as middleware, so a preflight OPTIONS
  // is answered before any guard runs — a guard rejecting the preflight would
  // make the real request unreachable. It grants no authority: every route
  // still requires its own credential.
  const cors = corsPolicyFromEnv();
  app.enableCors({
    origin: [...cors.origin],
    methods: [...cors.methods],
    allowedHeaders: [...cors.allowedHeaders],
    credentials: cors.credentials,
    maxAge: cors.maxAge,
  });

  // Global, so no route can return an unshaped error. Every failure leaves as
  // the documented envelope with a request id.
  app.useGlobalFilters(new ApiErrorFilter(logger));

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  // The allow-list is logged; it is configuration, not a credential, and a
  // browser failing silently on a missing origin is otherwise hard to diagnose.
  logger.info(
    { event: 'api.started', port, cors_origins: cors.origin.length },
    'control api listening',
  );
}

void bootstrap();
