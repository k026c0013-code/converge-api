import type { PrismaClient } from './generated/prisma/client.js';

export type AuditAction =
  | 'user.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.refresh_reuse_detected'
  | 'document.create'
  | 'document.update'
  | 'document.delete'
  | 'member.add'
  | 'member.update'
  | 'member.remove'
  | 'version.create'
  | 'document.restore';

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  documentId?: string | null;
  targetUserId?: string | null;
  ip?: string | null;
  /** Never put passwords, tokens or email addresses here (ADR-0008 §5). */
  metadata?: Record<string, string | number | boolean | null>;
}

type AuditDb = Pick<PrismaClient, 'auditLog'>;

export async function writeAudit(db: AuditDb, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      documentId: entry.documentId ?? null,
      targetUserId: entry.targetUserId ?? null,
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? undefined,
    },
  });
}
