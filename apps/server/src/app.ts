import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './auth/routes.js';
import type { HubLimits } from './collab/hub.js';
import { attachCollab } from './collab/server.js';
import { MemoryTicketStore, type TicketStore } from './collab/tickets.js';
import { AccessEvents } from './events.js';
import { DEFAULT_RATE_LIMITS, type AuthConfig, type RateLimitConfig } from './config.js';
import { documentRoutes } from './documents/routes.js';
import { AppError, registerErrorHandling } from './errors.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { userRoutes } from './users/routes.js';

/** Returns normally when the database answers, throws otherwise. */
export type DbCheck = () => Promise<void>;

export interface AppOptions {
  dbCheck: DbCheck;
  /** Upper bound for the DB health check, in ms. */
  dbCheckTimeoutMs?: number;
  logger?: boolean;
  /** When both prisma and auth are given, the Phase 1 REST API is mounted. */
  prisma?: PrismaClient;
  auth?: AuthConfig;
  rateLimits?: RateLimitConfig;
  /** Realtime endpoint settings (ADR-0009). Mounted together with the REST API. */
  realtime?: {
    allowedOrigins: string[];
    tickets?: TicketStore;
    limits?: Partial<HubLimits>;
    maxPayloadBytes?: number;
  };
}

/** Browser origins allowed to open WebSockets during local development (Vite). */
export const DEV_ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/** Request body limit for REST (requirements §13, ADR-0008 §4). */
export const BODY_LIMIT_BYTES = 64 * 1024;

function withTimeout(task: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'] }
      : false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Reject unknown properties instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorateRequest('userId', '');
  registerErrorHandling(app);

  const limits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
  void app.register(rateLimit, {
    max: limits.globalPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Too many requests, try again later'),
  });

  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Converge API',
        version: '1.0.0-phase1',
        description: 'Real-time collaborative editing API. Errors use { "error": { "code", "message", "details"? } }.',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });

  // Registered as a plugin so that @fastify/swagger (loaded above) sees these routes.
  void app.register(async (health) => {
    // Liveness: the process is up. Does not touch the database.
    health.get('/api/v1/health', { schema: { tags: ['health'] } }, async () => ({ status: 'ok' }));

    // Readiness of the persistence layer.
    health.get('/api/v1/health/db', { schema: { tags: ['health'] } }, async (request, reply) => {
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
  });

  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  if (options.prisma && options.auth) {
    const events = new AccessEvents();
    const tickets = options.realtime?.tickets ?? new MemoryTicketStore();
    const deps = { prisma: options.prisma, auth: options.auth, rateLimits: limits, events, tickets };
    attachCollab(app, {
      prisma: options.prisma,
      tickets,
      events,
      allowedOrigins: options.realtime?.allowedOrigins ?? DEV_ALLOWED_ORIGINS,
      limits: options.realtime?.limits,
      maxPayloadBytes: options.realtime?.maxPayloadBytes,
    });
    void app.register(authRoutes, { ...deps, prefix: '/api/v1/auth' });
    void app.register(userRoutes, { ...deps, prefix: '/api/v1/users' });
    void app.register(documentRoutes, { ...deps, prefix: '/api/v1/documents' });
  }

  return app;
}
