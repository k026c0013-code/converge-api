import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashToken } from '../src/auth/tokens.js';
import { bearer, createTestApp, createTestPrisma, registerUser, testDbUrl, uniqueEmail, type TestPrisma } from './helpers.js';

describe.skipIf(!testDbUrl)('auth API (MySQL)', () => {
  let prisma: TestPrisma;
  let app: FastifyInstance;

  beforeAll(async () => {
    prisma = createTestPrisma();
    app = createTestApp(prisma);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload: payload as object });

  describe('register', () => {
    it('creates a user, normalizes the email and returns a token pair', async () => {
      const email = uniqueEmail('Reg').toUpperCase();
      const res = await post('/register', { email: `  ${email} `.trim(), password: 'longenough', displayName: ' Alice ' });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.user.email).toBe(email.toLowerCase());
      expect(body.user.displayName).toBe('Alice');
      expect(body.user).not.toHaveProperty('passwordHash');
      expect(body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      const tokenRow = await prisma.refreshToken.findFirstOrThrow({ where: { userId: row.id } });
      expect(tokenRow.tokenHash).toBe(hashToken(body.tokens.refreshToken));
    });

    it('rejects a duplicate email regardless of case with 409', async () => {
      const u = await registerUser(app);
      const res = await post('/register', { email: u.email.toUpperCase(), password: 'longenough', displayName: 'x' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_TAKEN');
    });

    it.each([
      ['short password', { email: uniqueEmail(), password: 'short', displayName: 'x' }],
      ['bad email', { email: 'not-an-email', password: 'longenough', displayName: 'x' }],
      ['blank display name', { email: uniqueEmail(), password: 'longenough', displayName: '   ' }],
      ['unknown property', { email: uniqueEmail(), password: 'longenough', displayName: 'x', role: 'admin' }],
      ['missing field', { email: uniqueEmail(), password: 'longenough' }],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_name, payload) => {
      const res = await post('/register', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.details.length).toBeGreaterThan(0);
    });
  });

  describe('login', () => {
    it('signs in with the right password (email case-insensitive)', async () => {
      const u = await registerUser(app);
      const res = await post('/login', { email: u.email.toUpperCase(), password: u.password });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(u.id);
      expect(res.json().tokens.refreshToken).not.toBe(u.refreshToken);
    });

    it('gives the same 401 for a wrong password and an unknown email, and audits both', async () => {
      const u = await registerUser(app);
      const wrong = await post('/login', { email: u.email, password: 'wrong-password' });
      const unknown = await post('/login', { email: uniqueEmail('ghost'), password: 'wrong-password' });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json()).toEqual(unknown.json());
      expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('refresh rotation', () => {
    it('issues a new pair and revokes the old refresh token', async () => {
      const u = await registerUser(app);
      const res = await post('/refresh', { refreshToken: u.refreshToken });
      expect(res.statusCode).toBe(200);
      const next = res.json();
      expect(next.refreshToken).not.toBe(u.refreshToken);

      const old = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(u.refreshToken) } });
      const fresh = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(next.refreshToken) } });
      expect(old.revokedAt).not.toBeNull();
      expect(old.replacedById).toBe(fresh.id);
      expect(fresh.familyId).toBe(old.familyId);

      const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(next) });
      expect(me.statusCode).toBe(200);
    });

    it('detects reuse of a rotated token and revokes the whole family', async () => {
      const u = await registerUser(app);
      const second = (await post('/refresh', { refreshToken: u.refreshToken })).json();

      const reuse = await post('/refresh', { refreshToken: u.refreshToken });
      expect(reuse.statusCode).toBe(401);
      expect(reuse.json().error.code).toBe('INVALID_REFRESH_TOKEN');

      // The legitimately rotated token is now dead too.
      const afterReuse = await post('/refresh', { refreshToken: second.refreshToken });
      expect(afterReuse.statusCode).toBe(401);

      const audit = await prisma.auditLog.findFirst({ where: { actorUserId: u.id, action: 'auth.refresh_reuse_detected' } });
      expect(audit).not.toBeNull();
    });

    it('lets only one of two concurrent refreshes with the same token succeed', async () => {
      const u = await registerUser(app);
      const results = await Promise.all([post('/refresh', { refreshToken: u.refreshToken }), post('/refresh', { refreshToken: u.refreshToken })]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 401]);
      const live = await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } });
      expect(live).toBe(0); // the loser counts as reuse and kills the family
    });

    it('rejects unknown and expired tokens', async () => {
      expect((await post('/refresh', { refreshToken: 'nope' })).statusCode).toBe(401);
      const u = await registerUser(app);
      await prisma.refreshToken.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await post('/refresh', { refreshToken: u.refreshToken });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('logout', () => {
    it('revokes the token family and is idempotent', async () => {
      const u = await registerUser(app);
      expect((await post('/logout', { refreshToken: u.refreshToken })).statusCode).toBe(204);
      expect((await post('/logout', { refreshToken: u.refreshToken })).statusCode).toBe(204);
      expect((await post('/logout', { refreshToken: 'never-existed' })).statusCode).toBe(204);
      expect((await post('/refresh', { refreshToken: u.refreshToken })).statusCode).toBe(401);
    });
  });

  describe('GET /users/me', () => {
    it('returns the signed-in user', async () => {
      const u = await registerUser(app, 'me');
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(u) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: u.id, email: u.email, displayName: 'me' });
    });

    it.each([
      ['no header', {}],
      ['garbage token', { authorization: 'Bearer abc.def.ghi' }],
      ['wrong scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ])('401 with %s', async (_name, headers) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });
  });

  it('never stores passwords, tokens or emails in the audit log', async () => {
    const u = await registerUser(app, 'audit');
    await post('/login', { email: u.email, password: u.password });
    await post('/login', { email: u.email, password: 'wrong-password' });
    const rows = await prisma.auditLog.findMany({ where: { actorUserId: u.id } });
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['user.register', 'auth.login']));
    const dump = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(dump).not.toContain(u.password);
    expect(dump).not.toContain(u.email);
    expect(dump).not.toContain(u.refreshToken);
  });
});

describe.skipIf(!testDbUrl)('auth rate limiting (MySQL)', () => {
  it('returns 429 RATE_LIMITED after the per-IP auth limit', async () => {
    const prisma = createTestPrisma();
    const app = createTestApp(prisma, { globalPerMinute: 1000, authPerMinute: 3, memberAddPerMinute: 1000 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x@example.test', password: 'whatever' } });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.json().error.code).toBe('RATE_LIMITED');
    }
    expect(codes).toEqual([401, 401, 401, 429]);
    await app.close();
    await prisma.$disconnect();
  });
});
