import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthConfig } from '../config.js';

const encoder = new TextEncoder();

export async function signAccessToken(config: AuthConfig, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(encoder.encode(config.jwtSecret));
}

/** Returns the user id, or null for any invalid, expired or tampered token. */
export async function verifyAccessToken(config: AuthConfig, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(config.jwtSecret), {
      algorithms: ['HS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Opaque refresh token: 32 random bytes, base64url. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
