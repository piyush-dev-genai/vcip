import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors/api-error.filter.js';
import { corsPolicyFromEnv } from './common/http/cors.config.js';
import { WsAdapter } from '@nestjs/platform-ws';
import { logger } from './common/logging/logger.js';

async function bootstrap(): Promise<void> {
  // `rawBody` keeps the exact bytes of each request body alongside the parsed
  // one. T26's LiveKit webhook is signed over those bytes, and a re-serialised
  // object hashes differently even when it carries the same fields. Nothing
  // else reads it.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // LiveKit posts its webhooks as `application/webhook+json` (T26). The default
  // JSON parser only matches `application/json`, so without this the body is
  // neither parsed nor captured, `rawBody` is empty, and every genuine delivery
  // fails signature verification with a 401 — which is exactly what it did.
  app.useBodyParser('json', { type: ['application/json', 'application/webhook+json'] });

  // Native WebSocket, not Socket.IO (T27). The contract names a plain URL
  // with a query parameter, which Socket.IO's own handshake protocol does not
  // speak.
  app.useWebSocketAdapter(new WsAdapter(app));

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
