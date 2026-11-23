import type { FastifyRequest } from 'fastify';
import type { AuthConfig } from '../config.js';
import { unauthorized } from '../errors.js';
import { verifyAccessToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authenticate hook. Empty string on unauthenticated routes. */
    userId: string;
    /** Refresh-token family of the access token (ADR-0009 §4). */
    tokenFamilyId: string;
  }
}

/** onRequest hook: requires `Authorization: Bearer <JWT>` and sets request.userId. */
export function authenticate(config: AuthConfig) {
  return async function authenticateHook(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    const match = header?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/);
    if (!match?.[1]) throw unauthorized();
    const claims = await verifyAccessToken(config, match[1]);
    if (!claims) throw unauthorized();
    request.userId = claims.userId;
    request.tokenFamilyId = claims.familyId;
  };
}
