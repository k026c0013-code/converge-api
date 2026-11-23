import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPrismaClient } from '../src/db/client.js';

if (!process.env.TEST_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('MySQL integration (TEST_DATABASE_URL)', () => {
  const prisma = createPrismaClient(url ?? '');
  afterAll(async () => { await prisma.$disconnect(); });

  it('connects through Prisma and runs a query on the test database', async () => {
    const rows = await prisma.$queryRaw<{ db: string; v: string }[]>`SELECT DATABASE() AS db, VERSION() AS v`;
    expect(rows[0]?.db).toBe('converge_test');
    expect(rows[0]?.v).toMatch(/^8\./);
  });

  it('GET /api/v1/health/db is 200 against the real database', async () => {
    const app = buildApp({ dbCheck: async () => { await prisma.$queryRaw`SELECT 1`; } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/db' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /api/v1/health/db is 503 when credentials are wrong', async () => {
    const bad = new URL(url ?? '');
    bad.password = 'definitely-wrong';
    const badPrisma = createPrismaClient(bad.toString());
    const app = buildApp({ dbCheck: async () => { await badPrisma.$queryRaw`SELECT 1`; } });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/db' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(4_000);
    await app.close();
    await badPrisma.$disconnect();
  }, 15_000);
});
