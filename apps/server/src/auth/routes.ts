import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthConfig, RateLimitConfig } from '../config.js';
import type { AccessEvents } from '../events.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DisplayName, Email, Password, TokenPair, UserView, errors, strict } from '../schemas.js';
import { AuthService } from './service.js';

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  auth: AuthConfig;
  rateLimits: RateLimitConfig;
  events: AccessEvents;
}

const AuthResult = Type.Object({ user: UserView, tokens: TokenPair });
const RefreshBody = Type.Object({ refreshToken: Type.String({ minLength: 1, maxLength: 512 }) }, strict);

export const authRoutes: FastifyPluginAsyncTypebox<AuthRoutesOptions> = async (app, opts) => {
  const service = new AuthService(opts.prisma, opts.auth, opts.events);
  const authLimit = { rateLimit: { max: opts.rateLimits.authPerMinute, timeWindow: '1 minute' } };

  app.post(
    '/register',
    {
      config: authLimit,
      schema: {
        tags: ['auth'],
        summary: 'Create an account and sign in',
        body: Type.Object({ email: Email, password: Password, displayName: DisplayName }, strict),
        response: { 201: AuthResult, ...errors(400, 409, 429) },
      },
    },
    async (request, reply) => {
      const result = await service.register(request.body, request.ip);
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/login',
    {
      config: authLimit,
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        // Length checks only: do not reveal password rules to someone guessing.
        body: Type.Object(
          { email: Type.String({ minLength: 1, maxLength: 254 }), password: Type.String({ minLength: 1, maxLength: 128 }) },
          strict,
        ),
        response: { 200: AuthResult, ...errors(400, 401, 429) },
      },
    },
    async (request) => service.login(request.body, request.ip),
  );

  app.post(
    '/refresh',
    {
      config: authLimit,
      schema: {
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new token pair (rotation)',
        body: RefreshBody,
        response: { 200: TokenPair, ...errors(400, 401, 429) },
      },
    },
    async (request) => service.refresh(request.body.refreshToken, request.ip),
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke a refresh token and every token rotated from it',
        body: RefreshBody,
        response: { 204: Type.Null(), ...errors(400, 429) },
      },
    },
    async (request, reply) => {
      await service.logout(request.body.refreshToken, request.ip);
      return reply.code(204).send(null);
    },
  );
};
