import Fastify, { type FastifyInstance } from 'fastify';

/** Returns normally when the database answers, throws otherwise. */
export type DbCheck = () => Promise<void>;

export interface AppOptions {
  dbCheck: DbCheck;
  /** Upper bound for the DB health check, in ms. */
  dbCheckTimeoutMs?: number;
  logger?: boolean;
}

function withTimeout(task: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Liveness: the process is up. Does not touch the database.
  app.get('/api/v1/health', async () => ({ status: 'ok' }));

  // Readiness of the persistence layer.
  app.get('/api/v1/health/db', async (request, reply) => {
    try {
      await withTimeout(options.dbCheck(), options.dbCheckTimeoutMs ?? 3_000);
      return { status: 'ok', db: 'up' };
    } catch (err) {
      request.log.warn({ err }, 'database health check failed');
      // Do not leak driver error details (hosts, users) to clients.
      return reply.code(503).send({
        error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable' },
      });
    }
  });

  return app;
}
