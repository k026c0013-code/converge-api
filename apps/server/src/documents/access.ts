import { forbidden, notFound } from '../errors.js';
import type { Document, PrismaClient } from '../generated/prisma/client.js';

export type Role = 'owner' | 'editor' | 'viewer';

export interface DocumentAccess {
  document: Document;
  role: Role;
}

/**
 * Resolves the caller's role on a live (not deleted) document.
 * Non-members get 404 so that document ids cannot be probed (ADR-0008 §2).
 */
export async function loadAccess(prisma: PrismaClient, documentId: string, userId: string): Promise<DocumentAccess> {
  const document = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    include: { members: { where: { userId }, select: { role: true } } },
  });
  if (!document) throw notFound('Document');
  const { members, ...doc } = document;
  if (doc.ownerId === userId) return { document: doc, role: 'owner' };
  const role = members[0]?.role;
  if (role === 'editor' || role === 'viewer') return { document: doc, role };
  throw notFound('Document');
}

export function requireRole(access: DocumentAccess, ...allowed: Role[]): void {
  if (!allowed.includes(access.role)) throw forbidden();
}

export function toDocumentView(doc: Document, myRole: Role) {
  return {
    id: doc.id,
    title: doc.title,
    ownerId: doc.ownerId,
    engine: doc.engine,
    formatVersion: doc.formatVersion,
    myRole,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
