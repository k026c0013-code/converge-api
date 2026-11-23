import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/auth/password.js';
import { generateRefreshToken, hashToken, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js';
import { loadAuthConfig } from '../src/config.js';
import { testAuth } from './helpers.js';

describe('password hashing', () => {
  it('uses argon2id and verifies only the right password', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(h, 's3cret-pasS')).toBe(false);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('dummy verification always fails', async () => {
    expect(await verifyAgainstDummy('dummy-password-for-timing-equalization')).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips the user id', async () => {
    const token = await signAccessToken(testAuth, 'user-1', 'fam-1');
    expect(await verifyAccessToken(testAuth, token)).toEqual({ userId: 'user-1', familyId: 'fam-1' });
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signAccessToken({ ...testAuth, jwtSecret: 'x'.repeat(40) }, 'user-1', 'fam-1');
    expect(await verifyAccessToken(testAuth, token)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken(testAuth, 'user-1', 'fam-1');
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', iss: 'converge-api', aud: 'converge-api', exp: 9e9 })).toString('base64url');
    expect(await verifyAccessToken(testAuth, `${h}.${forged}.${s}`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer(testAuth.jwtIssuer)
      .setAudience(testAuth.jwtAudience)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(testAuth.jwtSecret));
    expect(await verifyAccessToken(testAuth, token)).toBeNull();
  });

  it('rejects the wrong audience and the "none" algorithm', async () => {
    const wrongAud = await signAccessToken({ ...testAuth, jwtAudience: 'other' }, 'user-1', 'fam-1');
    expect(await verifyAccessToken(testAuth, wrongAud)).toBeNull();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', iss: 'converge-api', aud: 'converge-api' })).toString('base64url');
    expect(await verifyAccessToken(testAuth, `${header}.${payload}.`)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('are 256-bit random values stored only as SHA-256 hex', () => {
    const a = generateRefreshToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(generateRefreshToken());
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadAuthConfig', () => {
  it('refuses a missing, short or placeholder secret', () => {
    expect(() => loadAuthConfig({})).toThrow(/JWT_SECRET/);
    expect(() => loadAuthConfig({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadAuthConfig({ JWT_SECRET: 'CHANGE_ME_TO_A_LONG_RANDOM_STRING' })).toThrow(/JWT_SECRET/);
    expect(loadAuthConfig({ JWT_SECRET: 'k'.repeat(32) }).accessTokenTtlSec).toBe(900);
  });
});
