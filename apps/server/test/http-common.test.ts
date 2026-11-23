import { describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES, buildApp } from '../src/app.js';
import { testAuth } from './helpers.js';

// prisma is never touched by these requests: they fail before reaching a handler.
const app = () => buildApp({ dbCheck: async () => {}, prisma: {} as never, auth: testAuth });

describe('common HTTP behaviour (requirements §9, §13)', () => {
  it('unknown routes return the standard error shape', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('bodies over 64 KiB are rejected with 413', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(BODY_LIMIT_BYTES) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('malformed JSON is a 400 INVALID_JSON', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
  });

  it('serves an OpenAPI 3.1 document covering the Phase 1 API', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/register',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/users/me',
        '/api/v1/documents/',
        '/api/v1/documents/{id}',
        '/api/v1/documents/{id}/members',
        '/api/v1/documents/{id}/members/{userId}',
      ]),
    );
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});
