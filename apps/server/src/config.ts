export interface AuthConfig {
  /** HS256 secret for access tokens. At least 32 characters. */
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
}

export interface RateLimitConfig {
  /** Requests per minute per IP across all routes. */
  globalPerMinute: number;
  /** Requests per minute per IP for register/login/refresh. */
  authPerMinute: number;
  /** Member additions per minute per user (limits email probing, ADR-0008 §3). */
  memberAddPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  globalPerMinute: 300,
  authPerMinute: 10,
  memberAddPerMinute: 20,
};

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.includes('CHANGE_ME')) {
    throw new Error('JWT_SECRET must be set and at least 32 characters (see apps/server/.env.example)');
  }
  return {
    jwtSecret,
    jwtIssuer: 'converge-api',
    jwtAudience: 'converge-api',
    accessTokenTtlSec: 15 * 60,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
  };
}
