import { DEV_ALLOWED_ORIGINS, buildApp } from './app.js';
import { loadAuthConfig, loadRateLimits } from './config.js';
import { RedisCluster } from './cluster/redis.js';
import { createPrismaClient } from './db/client.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see apps/server/.env.example)`);
  return value;
}

const auth = loadAuthConfig(process.env);
const prisma = createPrismaClient(requireEnv('DATABASE_URL'));
// Multi-node mode when REDIS_URL is set (ADR-0013); otherwise a single local node.
const cluster = process.env.REDIS_URL ? await RedisCluster.connect(process.env.REDIS_URL) : undefined;
const app = buildApp({
  logger: true,
  prisma,
  auth,
  rateLimits: loadRateLimits(process.env),
  realtime: {
    cluster,
    allowedOrigins: process.env.WS_ALLOWED_ORIGINS
      ? process.env.WS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : DEV_ALLOWED_ORIGINS,
  },
  dbCheck: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
});

app.addHook('onClose', async () => {
  await prisma.$disconnect();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
});
