import { config } from 'dotenv';
// The same file the service reads (`envFilePath` in src/config/configuration.ts):
// `ENV_FILE`, or `.env`. Kept inline because this runs outside the Nest build.
config({ path: process.env.ENV_FILE?.trim() || '.env', quiet: true });
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
