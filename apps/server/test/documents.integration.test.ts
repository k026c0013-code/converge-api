import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, createTestPrisma, registerUser, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';

describe.skipIf(!testDbUrl)('documents & members API (MySQL)', () => {
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

  const req = (u: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/documents${url}`, headers: u ? bearer(u) : {}, ...(payload && { payload }) });

  async function createDoc(owner: TestUser, title = 'Doc') {
    const res = await req(owner, 'POST', '', { title });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; title: string };
  }

  /** A document with an owner, an editor, a viewer and an outsider. */
  async function team() {
    const [owner, editor, viewer, outsider] = await Promise.all(
      ['owner', 'editor', 'viewer', 'outsider'].map((t) => registerUser(app, t)),
    );
    const doc = await createDoc(owner!);
    for (const [u, role] of [[editor!, 'editor'], [viewer!, 'viewer']] as const) {
      const res = await req(owner!, 'POST', `/${doc.id}/members`, { email: u.email, role });
      expect(res.statusCode, res.body).toBe(201);
    }
    return { owner: owner!, editor: editor!, viewer: viewer!, outsider: outsider!, doc };
  }

  it('requires authentication on every documents route', async () => {
    const id = randomUUID();
    for (const [m, url] of [['GET', ''], ['POST', ''], ['GET', `/${id}`], ['PATCH', `/${id}`], ['DELETE', `/${id}`], ['GET', `/${id}/members`]] as const) {
      const res = await req(null, m, url, m === 'POST' || m === 'PATCH' ? { title: 't' } : undefined);
      expect(res.statusCode, `${m} ${url}`).toBe(401);
    }
  });

  describe('create / get', () => {
    it('creates a document owned by the caller with engine defaults (ADR-0006)', async () => {
      const owner = await registerUser(app, 'creator');
      const doc = await createDoc(owner, '  My doc  ');
      expect(doc).toMatchObject({ title: 'My doc', ownerId: owner.id, engine: 'yjs', formatVersion: 1, myRole: 'owner' });
      const got = await req(owner, 'GET', `/${doc.id}`);
      expect(got.statusCode).toBe(200);
      expect(got.json()).toEqual(doc);
      const audit = await prisma.auditLog.findFirst({ where: { documentId: doc.id, action: 'document.create' } });
      expect(audit?.actorUserId).toBe(owner.id);
    });

    it('rejects client-chosen engine/owner and bad titles', async () => {
      const owner = await registerUser(app);
      for (const payload of [{ title: 'x', engine: 'custom' }, { title: 'x', ownerId: randomUUID() }, { title: '' }, { title: 'a'.repeat(201) }, {}]) {
        const res = await req(owner, 'POST', '', payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it('returns 400 for a malformed id and 404 for an unknown one', async () => {
      const u = await registerUser(app);
      expect((await req(u, 'GET', '/not-a-uuid')).statusCode).toBe(400);
      expect((await req(u, 'GET', `/${randomUUID()}`)).statusCode).toBe(404);
    });
  });

  describe('permission matrix (requirements §3, ADR-0008 §2)', () => {
    it('GET: every member sees the doc with their own role; outsiders get 404', async () => {
      const t = await team();
      expect((await req(t.owner, 'GET', `/${t.doc.id}`)).json().myRole).toBe('owner');
      expect((await req(t.editor, 'GET', `/${t.doc.id}`)).json().myRole).toBe('editor');
      expect((await req(t.viewer, 'GET', `/${t.doc.id}`)).json().myRole).toBe('viewer');
      const out = await req(t.outsider, 'GET', `/${t.doc.id}`);
      expect(out.statusCode).toBe(404);
      expect(out.json().error.code).toBe('NOT_FOUND');
    });

    it('PATCH title: owner and editor yes, viewer 403, outsider 404', async () => {
      const t = await team();
      expect((await req(t.owner, 'PATCH', `/${t.doc.id}`, { title: 'by owner' })).json().title).toBe('by owner');
      expect((await req(t.editor, 'PATCH', `/${t.doc.id}`, { title: 'by editor' })).json().title).toBe('by editor');
      const v = await req(t.viewer, 'PATCH', `/${t.doc.id}`, { title: 'by viewer' });
      expect(v.statusCode).toBe(403);
      expect(v.json().error.code).toBe('FORBIDDEN');
      expect((await req(t.outsider, 'PATCH', `/${t.doc.id}`, { title: 'x' })).statusCode).toBe(404);
      expect((await req(t.owner, 'GET', `/${t.doc.id}`)).json().title).toBe('by editor');
    });

    it('DELETE: only the owner', async () => {
      const t = await team();
      expect((await req(t.editor, 'DELETE', `/${t.doc.id}`)).statusCode).toBe(403);
      expect((await req(t.viewer, 'DELETE', `/${t.doc.id}`)).statusCode).toBe(403);
      expect((await req(t.outsider, 'DELETE', `/${t.doc.id}`)).statusCode).toBe(404);
      expect((await req(t.owner, 'DELETE', `/${t.doc.id}`)).statusCode).toBe(204);
    });

    it('member management: only the owner', async () => {
      const t = await team();
      const extra = await registerUser(app, 'extra');
      for (const u of [t.editor, t.viewer]) {
        expect((await req(u, 'POST', `/${t.doc.id}/members`, { email: extra.email, role: 'viewer' })).statusCode).toBe(403);
        expect((await req(u, 'PATCH', `/${t.doc.id}/members/${t.viewer.id}`, { role: 'editor' })).statusCode).toBe(403);
        expect((await req(u, 'DELETE', `/${t.doc.id}/members/${t.viewer.id}`)).statusCode).toBe(403);
      }
      expect((await req(t.outsider, 'POST', `/${t.doc.id}/members`, { email: extra.email, role: 'viewer' })).statusCode).toBe(404);
    });
  });

  describe('soft delete', () => {
    it('hides the document everywhere but keeps the row', async () => {
      const t = await team();
      expect((await req(t.owner, 'DELETE', `/${t.doc.id}`)).statusCode).toBe(204);
      for (const u of [t.owner, t.editor, t.viewer]) {
        expect((await req(u, 'GET', `/${t.doc.id}`)).statusCode).toBe(404);
        expect((await req(u, 'GET', `/${t.doc.id}/members`)).statusCode).toBe(404);
        const list = (await req(u, 'GET', '?limit=100')).json();
        expect(list.items.map((d: { id: string }) => d.id)).not.toContain(t.doc.id);
      }
      expect((await req(t.owner, 'DELETE', `/${t.doc.id}`)).statusCode).toBe(404);
      const row = await prisma.document.findUniqueOrThrow({ where: { id: t.doc.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(await prisma.auditLog.count({ where: { documentId: t.doc.id, action: 'document.delete' } })).toBe(1);
    });
  });

  describe('list', () => {
    it('lists owned and shared documents newest first with cursor paging', async () => {
      const me = await registerUser(app, 'lister');
      const other = await registerUser(app, 'other');
      const own = [];
      for (let i = 0; i < 3; i++) own.push(await createDoc(me, `own ${i}`));
      const shared = await createDoc(other, 'shared');
      await req(other, 'POST', `/${shared.id}/members`, { email: me.email, role: 'viewer' });
      await createDoc(other, 'not shared');

      const page1 = (await req(me, 'GET', '?limit=3')).json();
      expect(page1.items).toHaveLength(3);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = (await req(me, 'GET', `?limit=3&cursor=${page1.nextCursor}`)).json();
      expect(page2.nextCursor).toBeNull();

      const all = [...page1.items, ...page2.items];
      expect(all.map((d: { title: string }) => d.title)).toEqual(['shared', 'own 2', 'own 1', 'own 0']);
      expect(all[0].myRole).toBe('viewer');
      expect(all[1].myRole).toBe('owner');
    });

    it('rejects a bad cursor and out-of-range limit', async () => {
      const me = await registerUser(app);
      expect((await req(me, 'GET', '?cursor=@@@')).statusCode).toBe(400);
      expect((await req(me, 'GET', '?limit=0')).statusCode).toBe(400);
      expect((await req(me, 'GET', '?limit=101')).statusCode).toBe(400);
    });
  });

  describe('members', () => {
    it('lists owner first; emails only for the owner', async () => {
      const t = await team();
      const asOwner = (await req(t.owner, 'GET', `/${t.doc.id}/members`)).json().items;
      expect(asOwner.map((m: { role: string }) => m.role)).toEqual(['owner', 'editor', 'viewer']);
      expect(asOwner[1].email).toBe(t.editor.email);
      const asViewer = (await req(t.viewer, 'GET', `/${t.doc.id}/members`)).json().items;
      expect(asViewer).toHaveLength(3);
      expect(asViewer.every((m: object) => !('email' in m))).toBe(true);
    });

    it('add: unknown email 404, duplicate 409, owner 409, role "owner" rejected', async () => {
      const t = await team();
      const unknown = await req(t.owner, 'POST', `/${t.doc.id}/members`, { email: 'nobody-' + randomUUID() + '@example.test', role: 'viewer' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('USER_NOT_FOUND');
      expect((await req(t.owner, 'POST', `/${t.doc.id}/members`, { email: t.editor.email.toUpperCase(), role: 'viewer' })).json().error.code).toBe('ALREADY_MEMBER');
      expect((await req(t.owner, 'POST', `/${t.doc.id}/members`, { email: t.owner.email, role: 'editor' })).statusCode).toBe(409);
      expect((await req(t.owner, 'POST', `/${t.doc.id}/members`, { email: t.outsider.email, role: 'owner' })).statusCode).toBe(400);
    });

    it('change role takes effect immediately and is audited', async () => {
      const t = await team();
      const res = await req(t.owner, 'PATCH', `/${t.doc.id}/members/${t.viewer.id}`, { role: 'editor' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ userId: t.viewer.id, role: 'editor' });
      expect((await req(t.viewer, 'PATCH', `/${t.doc.id}`, { title: 'promoted' })).statusCode).toBe(200);

      await req(t.owner, 'PATCH', `/${t.doc.id}/members/${t.editor.id}`, { role: 'viewer' });
      expect((await req(t.editor, 'PATCH', `/${t.doc.id}`, { title: 'demoted' })).statusCode).toBe(403);

      const audit = await prisma.auditLog.findMany({ where: { documentId: t.doc.id, action: 'member.update' } });
      expect(audit).toHaveLength(2);
    });

    it('remove revokes access; the owner cannot be changed or removed', async () => {
      const t = await team();
      expect((await req(t.owner, 'DELETE', `/${t.doc.id}/members/${t.editor.id}`)).statusCode).toBe(204);
      expect((await req(t.editor, 'GET', `/${t.doc.id}`)).statusCode).toBe(404);
      expect((await req(t.owner, 'DELETE', `/${t.doc.id}/members/${t.editor.id}`)).statusCode).toBe(404);
      expect((await req(t.owner, 'DELETE', `/${t.doc.id}/members/${t.owner.id}`)).json().error.code).toBe('OWNER_NOT_MODIFIABLE');
      expect((await req(t.owner, 'PATCH', `/${t.doc.id}/members/${t.owner.id}`, { role: 'viewer' })).statusCode).toBe(400);
      expect((await req(t.owner, 'PATCH', `/${t.doc.id}/members/${t.outsider.id}`, { role: 'viewer' })).statusCode).toBe(404);
    });
  });
});

describe.skipIf(!testDbUrl)('member-add rate limit (MySQL)', () => {
  it('limits member additions per user', async () => {
    const prisma = createTestPrisma();
    const app = createTestApp(prisma, { globalPerMinute: 1000, authPerMinute: 1000, memberAddPerMinute: 2 });
    const owner = await registerUser(app, 'probe');
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner), payload: { title: 't' } })).json();
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc.id}/members`,
        headers: bearer(owner),
        payload: { email: `probe-${randomUUID()}@example.test`, role: 'viewer' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([404, 404, 429]);
    await app.close();
    await prisma.$disconnect();
  });
});
