import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthConfig } from '../config.js';

const encoder = new TextEncoder();

export interface AccessClaims {
  userId: string;
  /** Refresh-token family this access token was issued from (ADR-0009 §4). */
  familyId: string;
}

export async function signAccessToken(config: AuthConfig, userId: string, familyId: string): Promise<string> {
  return new SignJWT({ fid: familyId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(encoder.encode(config.jwtSecret));
}

/** Returns the claims, or null for any invalid, expired or tampered token. */
export async function verifyAccessToken(config: AuthConfig, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(config.jwtSecret), {
      algorithms: ['HS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    if (typeof payload.fid !== 'string' || payload.fid.length === 0) return null;
    return { userId: payload.sub, familyId: payload.fid };
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
