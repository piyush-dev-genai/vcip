import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DATABASE } from './db.tokens.js';

/**
 * The single PostgreSQL connection for the Control API.
 *
 * PostgreSQL is authoritative for business state (D1), and this module is the
 * only place a connection is created. `apps/ai` and `apps/egress` hold no
 * database credentials at all (D10) and reach state through `/internal/*`.
 *
 * The connection string comes from the environment; it is never committed.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (url === undefined || url.trim().length === 0) {
          throw new Error('DATABASE_URL is not set');
        }
        return drizzle(postgres(url));
      },
    },
  ],
  exports: [DATABASE],
})
export class DbModule {}
