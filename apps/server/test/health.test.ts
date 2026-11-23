import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('health endpoints', () => {
  it('GET /api/v1/health returns ok without touching the database', async () => {
    let called = false;
    const app = buildApp({ dbCheck: async () => { called = true; } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(called).toBe(false);
    await app.close();
  });

  it('GET /api/v1/health/db returns 200 when the database answers', async () => {
    const app = buildApp({ dbCheck: async () => {} });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up' });
    await app.close();
  });

  it('GET /api/v1/health/db returns 503 and hides driver details when the database fails', async () => {
    const app = buildApp({
      dbCheck: async () => { throw new Error('connect ECONNREFUSED converge@127.0.0.1:3306'); },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable' },
    });
    expect(res.body).not.toContain('127.0.0.1');
    await app.close();
  });

  it('GET /api/v1/health/db returns 503 instead of hanging when the check never settles', async () => {
    const app = buildApp({ dbCheck: () => new Promise<void>(() => {}), dbCheckTimeoutMs: 50 });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/db' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1_000);
    await app.close();
  });
});
