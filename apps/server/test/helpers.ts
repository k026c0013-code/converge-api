import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthConfig, RateLimitConfig } from '../src/config.js';
import { createPrismaClient } from '../src/db/client.js';

if (!process.env.TEST_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
export const testDbUrl = process.env.TEST_DATABASE_URL;

export const testAuth: AuthConfig = {
  jwtSecret: 'test-secret-test-secret-test-secret-0123456789',
  jwtIssuer: 'converge-api',
  jwtAudience: 'converge-api',
  accessTokenTtlSec: 900,
  refreshTokenTtlSec: 3600,
};

export const relaxedLimits: RateLimitConfig = { globalPerMinute: 10_000, authPerMinute: 10_000, memberAddPerMinute: 10_000 };

export function createTestPrisma() {
  return createPrismaClient(testDbUrl ?? '');
}

export type TestPrisma = ReturnType<typeof createTestPrisma>;

export function createTestApp(prisma: TestPrisma, rateLimits: RateLimitConfig = relaxedLimits): FastifyInstance {
  return buildApp({ dbCheck: async () => {}, prisma, auth: testAuth, rateLimits });
}

/** Unique per call so test files can run in parallel against one database. */
export function uniqueEmail(tag = 'user'): string {
  return `${tag}-${randomUUID()}@example.test`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(app: FastifyInstance, tag = 'user'): Promise<TestUser> {
  const email = uniqueEmail(tag);
  const password = 'correct horse battery';
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password, displayName: tag },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return {
    id: body.user.id,
    email,
    password,
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
  };
}

export const bearer = (u: { accessToken: string }) => ({ authorization: `Bearer ${u.accessToken}` });
