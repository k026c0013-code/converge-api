import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '../config.js';
import { writeAudit } from '../audit.js';
import { AppError } from '../errors.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { generateRefreshToken, hashToken, signAccessToken } from './tokens.js';

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
export const invalidRefreshToken = () =>
  new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(u: { id: string; email: string; displayName: string; createdAt: Date }): PublicUser {
  return { id: u.id, email: u.email, displayName: u.displayName, createdAt: u.createdAt.toISOString() };
}

type Tx = Prisma.TransactionClient;

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AuthConfig,
  ) {}

  private async issueTokens(db: Tx | PrismaClient, userId: string, familyId: string): Promise<{ pair: TokenPair; id: string }> {
    const refreshToken = generateRefreshToken();
    const id = randomUUID();
    await db.refreshToken.create({
      data: {
        id,
        userId,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.config.refreshTokenTtlSec * 1000),
      },
    });
    const accessToken = await signAccessToken(this.config, userId);
    return {
      id,
      pair: { tokenType: 'Bearer', accessToken, expiresIn: this.config.accessTokenTtlSec, refreshToken },
    };
  }

  async register(input: { email: string; password: string; displayName: string }, ip: string) {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    try {
      const user = await this.prisma.user.create({
        data: { id, email, displayName: input.displayName.trim(), passwordHash },
      });
      const { pair } = await this.issueTokens(this.prisma, user.id, randomUUID());
      await writeAudit(this.prisma, { action: 'user.register', actorUserId: user.id, ip });
      return { user: toPublicUser(user), tokens: pair };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'EMAIL_TAKEN', 'This email address is already registered');
      }
      throw err;
    }
  }

  async login(input: { email: string; password: string }, ip: string) {
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(input.email) } });
    const ok = user ? await verifyPassword(user.passwordHash, input.password) : await verifyAgainstDummy(input.password);
    if (!user || !ok) {
      await writeAudit(this.prisma, { action: 'auth.login_failed', actorUserId: null, ip });
      throw invalidCredentials();
    }
    const { pair } = await this.issueTokens(this.prisma, user.id, randomUUID());
    await writeAudit(this.prisma, { action: 'auth.login', actorUserId: user.id, ip });
    return { user: toPublicUser(user), tokens: pair };
  }

  /** Rotates the refresh token. Reuse of a revoked token revokes its whole family (ADR-0008 §1). */
  async refresh(refreshToken: string, ip: string): Promise<TokenPair> {
    const now = new Date();
    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
    if (!current) throw invalidRefreshToken();

    if (current.revokedAt) {
      await this.revokeFamily(current.familyId, now);
      await writeAudit(this.prisma, {
        action: 'auth.refresh_reuse_detected',
        actorUserId: current.userId,
        ip,
        metadata: { familyId: current.familyId },
      });
      throw invalidRefreshToken();
    }
    if (current.expiresAt <= now) throw invalidRefreshToken();

    const result = await this.prisma.$transaction(async (tx) => {
      // Conditional update: of two concurrent refreshes with the same token, only one wins.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) return null;
      const issued = await this.issueTokens(tx, current.userId, current.familyId);
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: issued.id } });
      return issued.pair;
    });

    if (!result) {
      // Lost the race: the token was used twice at the same moment. Treat as reuse.
      await this.revokeFamily(current.familyId, now);
      await writeAudit(this.prisma, {
        action: 'auth.refresh_reuse_detected',
        actorUserId: current.userId,
        ip,
        metadata: { familyId: current.familyId, concurrent: true },
      });
      throw invalidRefreshToken();
    }
    return result;
  }

  /** Idempotent: unknown or already revoked tokens are accepted silently. */
  async logout(refreshToken: string, ip: string): Promise<void> {
    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
    if (!current) return;
    await this.revokeFamily(current.familyId, new Date());
    await writeAudit(this.prisma, { action: 'auth.logout', actorUserId: current.userId, ip });
  }

  private async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: at } });
  }
}
