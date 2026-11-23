import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { writeAudit } from '../audit.js';
import { authenticate } from '../auth/authenticate.js';
import { LiveDocuments, VersionNotFoundError } from '../collab/documents.js';
import type { AuthConfig } from '../config.js';
import { loadAccess, requireRole } from '../documents/access.js';
import { AppError } from '../errors.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { Uuid, errors, strict } from '../schemas.js';

export interface HistoryRoutesOptions {
  prisma: PrismaClient;
  auth: AuthConfig;
  live: LiveDocuments;
}

const security = [{ bearerAuth: [] }];
const IdParams = Type.Object({ id: Uuid }, strict);

const VersionView = Type.Object({
  id: Uuid,
  name: Type.String(),
  note: Type.Union([Type.String(), Type.Null()]),
  kind: Type.String(),
  createdBy: Uuid,
  createdAt: Type.String({ format: 'date-time' }),
});

const toVersionView = (v: { id: string; name: string; note: string | null; kind: string; createdBy: string; createdAt: Date }) => ({
  id: v.id,
  name: v.name,
  note: v.note,
  kind: v.kind,
  createdBy: v.createdBy,
  createdAt: v.createdAt.toISOString(),
});

const versionNotFound = () => new AppError(404, 'NOT_FOUND', 'Version not found');

/** History, versions and restore (requirements §4.6, ADR-0012). Mounted under /api/v1/documents. */
export const historyRoutes: FastifyPluginAsyncTypebox<HistoryRoutesOptions> = async (app, opts) => {
  const { prisma, live } = opts;
  app.addHook('onRequest', authenticate(opts.auth));

  app.get(
    '/:id/history',
    {
      schema: {
        tags: ['history'],
        summary: 'CRDT update log, newest first (payloads are not returned)',
        security,
        params: IdParams,
        querystring: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
            before: Type.Optional(Type.String({ pattern: '^[0-9]{1,19}$' })),
          },
          strict,
        ),
        response: {
          200: Type.Object({
            items: Type.Array(
              Type.Object({
                id: Type.String(),
                updateId: Uuid,
                userId: Uuid,
                displayName: Type.Union([Type.String(), Type.Null()]),
                size: Type.Integer(),
                createdAt: Type.String({ format: 'date-time' }),
              }),
            ),
            nextBefore: Type.Union([Type.String(), Type.Null()]),
          }),
          ...errors(400, 401, 404, 429),
        },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      const limit = request.query.limit ?? 50;
      const rows = await prisma.documentUpdate.findMany({
        where: { documentId: access.document.id, ...(request.query.before && { id: { lt: BigInt(request.query.before) } }) },
        orderBy: { id: 'desc' },
        take: limit + 1,
        select: { id: true, updateId: true, userId: true, createdAt: true, updateData: true },
      });
      const page = rows.slice(0, limit);
      const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(page.map((r) => r.userId))] } },
        select: { id: true, displayName: true },
      });
      const names = new Map(users.map((u) => [u.id, u.displayName]));
      return {
        items: page.map((r) => ({
          id: r.id.toString(),
          updateId: r.updateId,
          userId: r.userId,
          displayName: names.get(r.userId) ?? null,
          size: r.updateData.byteLength,
          createdAt: r.createdAt.toISOString(),
        })),
        nextBefore: rows.length > limit ? page.at(-1)!.id.toString() : null,
      };
    },
  );

  app.get(
    '/:id/versions',
    {
      schema: {
        tags: ['history'],
        summary: 'Saved versions, newest first',
        security,
        params: IdParams,
        response: { 200: Type.Object({ items: Type.Array(VersionView) }), ...errors(400, 401, 404, 429) },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      const versions = await prisma.documentVersion.findMany({
        where: { documentId: access.document.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      });
      return { items: versions.map(toVersionView) };
    },
  );

  app.post(
    '/:id/versions',
    {
      schema: {
        tags: ['history'],
        summary: 'Save the current state as a named version (owner or editor)',
        security,
        params: IdParams,
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
            note: Type.Optional(Type.String({ maxLength: 500 })),
          },
          strict,
        ),
        response: { 201: VersionView, ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner', 'editor');
      const version = await live.createVersion(access.document.id, access.document.engine, {
        createdBy: request.userId,
        name: request.body.name.trim(),
        note: request.body.note?.trim() || null,
      });
      await writeAudit(prisma, {
        action: 'version.create',
        actorUserId: request.userId,
        documentId: access.document.id,
        ip: request.ip,
        metadata: { versionId: version.id },
      });
      return reply.code(201).send(toVersionView(version));
    },
  );

  app.get(
    '/:id/versions/:versionId',
    {
      schema: {
        tags: ['history'],
        summary: 'A past state: metadata, Yjs state (base64) and content as XML',
        security,
        params: Type.Object({ id: Uuid, versionId: Uuid }, strict),
        response: {
          200: Type.Object({ version: VersionView, state: Type.String(), content: Type.String() }),
          ...errors(400, 401, 404, 429),
        },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      const version = await prisma.documentVersion.findFirst({
        where: { id: request.params.versionId, documentId: access.document.id },
        include: { snapshot: { select: { stateData: true } } },
      });
      if (!version) throw versionNotFound();
      const { snapshot, ...meta } = version;
      return {
        version: toVersionView(meta),
        state: Buffer.from(snapshot.stateData).toString('base64'),
        content: LiveDocuments.contentOf(snapshot.stateData),
      };
    },
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        tags: ['history'],
        summary: 'Restore a version as a new edit (owner only). A pre-restore version is saved first.',
        security,
        params: IdParams,
        body: Type.Object({ versionId: Uuid }, strict),
        response: {
          200: Type.Object({ restoredVersionId: Uuid, preRestoreVersionId: Uuid }),
          ...errors(400, 401, 403, 404, 429),
        },
      },
    },
    async (request) => {
      const access = await loadAccess(prisma, request.params.id, request.userId);
      requireRole(access, 'owner');
      let result: { preRestoreVersionId: string };
      try {
        result = await live.restore(access.document.id, access.document.engine, {
          versionId: request.body.versionId,
          userId: request.userId,
          preRestoreName: `復元前 (${new Date().toISOString()})`,
        });
      } catch (err) {
        if (err instanceof VersionNotFoundError) throw versionNotFound();
        throw err;
      }
      await writeAudit(prisma, {
        action: 'document.restore',
        actorUserId: request.userId,
        documentId: access.document.id,
        ip: request.ip,
        metadata: { versionId: request.body.versionId, preRestoreVersionId: result.preRestoreVersionId },
      });
      return { restoredVersionId: request.body.versionId, ...result };
    },
  );
};
