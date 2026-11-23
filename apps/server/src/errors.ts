import type { FastifyError, FastifyInstance } from 'fastify';

/** An error whose code and message are safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission for this operation');
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

interface ErrorBody {
  error: { code: string; message: string; details?: unknown[] };
}

function body(code: string, message: string, details?: unknown[]): ErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

/** Uniform error format for every route (requirements §9, ADR-0008 §4). */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send(body(err.code, err.message, err.details));
    }
    if ('validation' in err && err.validation) {
      const details = err.validation.map((v) => ({
        location: err.validationContext ?? 'body',
        path: v.instancePath || '/',
        message: v.message ?? 'invalid',
      }));
      return reply.code(400).send(body('VALIDATION_ERROR', 'Request validation failed', details));
    }
    switch (err.code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return reply.code(413).send(body('PAYLOAD_TOO_LARGE', 'Request body is too large'));
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        return reply.code(400).send(body('INVALID_JSON', 'Request body is not valid JSON'));
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return reply.code(415).send(body('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    }
    if (err.statusCode === 429) {
      return reply.code(429).send(body('RATE_LIMITED', 'Too many requests, try again later'));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send(body('BAD_REQUEST', 'The request could not be processed'));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(body('INTERNAL_ERROR', 'An unexpected error occurred'));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(body('NOT_FOUND', 'Route not found'));
  });
}
