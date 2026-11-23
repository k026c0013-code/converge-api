import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: env('DATABASE_URL'),
    // Fixed shadow DB: the app user has no global CREATE privilege (least privilege).
    shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
  },
});
