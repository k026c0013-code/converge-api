import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { writeAudit } from '../audit.js';
import { authenticate } from '../auth/authenticate.js';
import { normalizeEmail } from '../auth/service.js';
import type { AuthConfig, RateLimitConfig } from '../config.js';
import { AppError } from '../errors.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { DocumentView, Email, MemberRole, MemberView, Title, Uuid, errors, strict } from '../schemas.js';
import { loadAccess, requireRole, toDocumentView, type Role } from './access.js';

export interface DocumentRoutesOptions {
  prisma: PrismaClient;
  auth: AuthConfig;
  rateLimits: RateLimitConfig;
}

const IdParams = Type.Object({ id: Uuid }, strict);
const MemberParams = Type.Object({ id: Uuid, userId: Uuid }, strict);
const security = [{ bearerAuth: [] }];

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const [ts, id] = Buffer.from(raw, 'base64url').toString().split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor is malformed');
  }
  return { createdAt, id };
}

const cannotTargetOwner = () =>
  new AppError(400, 'OWNER_NOT_MODIFIABLE', 'The document owner cannot be changed or removed');
const memberNotFound = () => new AppError(404, 'NOT_FOUND', 'Member not found');

export const documentRoutes: FastifyPluginAsyncTypebox<DocumentRoutesOptions> = async (app, opts) => {
  const { prisma } = opts;
  app.addHook('onRequest', authenticate(opts.auth));

  // Per-user limit, checked after authentication (ADR-0008 §3).
  const memberAddLimit = app.createRateLimit({
    max: opts.rateLimits.memberAddPerMinute,
    timeWindow: 60_000,
    keyGenerator: (req) => `member-add:${req.userId}`,
  });

  // ---- documents ---------------------------------------------------------

  app.post(
    '/',
    {
      schema: {
        tags: ['documents'],
        summary: 'Create a document (the caller becomes its owner)',
        security,
        body: Type.Object({ title: Title }, strict),
        response: { 201: DocumentView, ...errors(400, 401, 429) },
      },
    },
    async (request, reply) => {
      const doc = await prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: { id: randomUUID(), title: request.body.title.trim(), ownerId: request.userId },
        });
        await writeAudit(tx, { action: 'document.create', actorUserId: request.userId, documentId: created.id, ip: request.ip });
        return created;
      });
      return reply.code(201).send(toDocumentView(doc, 'owner'));
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['documents'],
        summary: 'Documents the caller owns or is a member of, newest first',
        security,
        querystring: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
          },
          strict,
        ),
        response: {
          200: Type.Object({ items: Type.Array(DocumentView), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
          ...errors(400, 401, 429),
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? 20;
      const me = request.userId;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const rows = await prisma.document.findMany({
        where: {
          deletedAt: null,
          OR: [{ ownerId: me }, { members: { some: { userId: me } } }],
          ...(cursor && {
            AND: [
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }),
        },
        include: { members: { where: { userId: me }, select: { role: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ members, ...doc }) =>
          toDocumentView(doc, doc.ownerId === me ? 'owner' : ((members[0]?.role ?? 'viewer') as Role)),
        ),
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Get a document',
        security,
        params: IdParams,
        response: { 200: DocumentView, ...errors(400, 401, 404, 429) },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      return toDocumentView(access.document, access.role);
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Update document information (owner or editor)',
        security,
        params: IdParams,
        body: Type.Object({ title: Title }, strict),
        response: { 200: DocumentView, ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner', 'editor');
      const doc = await prisma.$transaction(async (tx) => {
        const updated = await tx.document.update({
          where: { id: access.document.id },
          data: { title: request.body.title.trim() },
        });
        await writeAudit(tx, { action: 'document.update', actorUserId: request.userId, documentId: updated.id, ip: request.ip });
        return updated;
      });
      return toDocumentView(doc, access.role);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Delete a document (owner only; soft delete)',
        security,
        params: IdParams,
        response: { 204: Type.Null(), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner');
      await prisma.$transaction(async (tx) => {
        const res = await tx.document.updateMany({
          where: { id: access.document.id, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        if (res.count === 1) {
          await writeAudit(tx, { action: 'document.delete', actorUserId: request.userId, documentId: access.document.id, ip: request.ip });
        }
      });
      return reply.code(204).send(null);
    },
  );

  // ---- members -----------------------------------------------------------

  app.get(
    '/:id/members',
    {
      schema: {
        tags: ['members'],
        summary: 'List members, owner first. Emails are shown to the owner only.',
        security,
        params: IdParams,
        response: { 200: Type.Object({ items: Type.Array(MemberView) }), ...errors(400, 401, 404, 429) },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      const showEmail = access.role === 'owner';
      const [owner, members] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: access.document.ownerId } }),
        prisma.documentMember.findMany({
          where: { documentId: access.document.id },
          include: { user: true },
          orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
        }),
      ]);
      const view = (u: { id: string; displayName: string; email: string }, role: Role, joinedAt: Date) => ({
        userId: u.id,
        displayName: u.displayName,
        ...(showEmail && { email: u.email }),
        role,
        joinedAt: joinedAt.toISOString(),
      });
      return {
        items: [
          view(owner, 'owner', access.document.createdAt),
          ...members.map((m) => view(m.user, m.role as Role, m.joinedAt)),
        ],
      };
    },
  );

  app.post(
    '/:id/members',
    {
      schema: {
        tags: ['members'],
        summary: 'Add a member by email (owner only)',
        security,
        params: IdParams,
        body: Type.Object({ email: Email, role: MemberRole }, strict),
        response: { 201: MemberView, ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const limit = await memberAddLimit(request);
      if (!limit.isAllowed && limit.isExceeded) throw new AppError(429, 'RATE_LIMITED', 'Too many requests, try again later');

      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner');
      const user = await prisma.user.findUnique({ where: { email: normalizeEmail(request.body.email) } });
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'No user is registered with this email address');
      if (user.id === access.document.ownerId) {
        throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member of the document');
      }
      try {
        const member = await prisma.$transaction(async (tx) => {
          const created = await tx.documentMember.create({
            data: { documentId: access.document.id, userId: user.id, role: request.body.role },
          });
          await writeAudit(tx, {
            action: 'member.add',
            actorUserId: request.userId,
            documentId: access.document.id,
            targetUserId: user.id,
            ip: request.ip,
            metadata: { role: request.body.role },
          });
          return created;
        });
        return reply.code(201).send({
          userId: user.id,
          displayName: user.displayName,
          email: user.email,
          role: member.role as Role,
          joinedAt: member.joinedAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member of the document');
        }
        throw err;
      }
    },
  );

  app.patch(
    '/:id/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: "Change a member's role (owner only)",
        security,
        params: MemberParams,
        body: Type.Object({ role: MemberRole }, strict),
        response: { 200: MemberView, ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner');
      if (request.params.userId === access.document.ownerId) throw cannotTargetOwner();
      const member = await prisma.$transaction(async (tx) => {
        const res = await tx.documentMember.updateMany({
          where: { documentId: access.document.id, userId: request.params.userId },
          data: { role: request.body.role },
        });
        if (res.count !== 1) throw memberNotFound();
        await writeAudit(tx, {
          action: 'member.update',
          actorUserId: request.userId,
          documentId: access.document.id,
          targetUserId: request.params.userId,
          ip: request.ip,
          metadata: { role: request.body.role },
        });
        return tx.documentMember.findUniqueOrThrow({
          where: { documentId_userId: { documentId: access.document.id, userId: request.params.userId } },
          include: { user: true },
        });
      });
      return {
        userId: member.userId,
        displayName: member.user.displayName,
        email: member.user.email,
        role: member.role as Role,
        joinedAt: member.joinedAt.toISOString(),
      };
    },
  );

  app.delete(
    '/:id/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: 'Remove a member (owner only)',
        security,
        params: MemberParams,
        response: { 204: Type.Null(), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner');
      if (request.params.userId === access.document.ownerId) throw cannotTargetOwner();
      await prisma.$transaction(async (tx) => {
        const res = await tx.documentMember.deleteMany({
          where: { documentId: access.document.id, userId: request.params.userId },
        });
        if (res.count !== 1) throw memberNotFound();
        await writeAudit(tx, {
          action: 'member.remove',
          actorUserId: request.userId,
          documentId: access.document.id,
          targetUserId: request.params.userId,
          ip: request.ip,
        });
      });
      return reply.code(204).send(null);
    },
  );
};
