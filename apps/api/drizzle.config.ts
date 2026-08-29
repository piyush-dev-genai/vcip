import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * The connection string comes from the environment. It is never written into a
 * committed file — infra/.env holds the local credentials and is gitignored.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
