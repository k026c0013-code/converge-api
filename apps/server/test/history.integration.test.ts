import { ConvergeConnection, YjsSync } from '@converge/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../src/app.js';
import { buildReplacementUpdate } from '../src/collab/documents.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';

async function until(predicate: () => boolean, ms = 6_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`${what} not met in time`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const content = (d: Y.Doc) => d.getXmlFragment('content').toString();
const para = (text: string) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
};

describe('buildReplacementUpdate', () => {
  it('turns one content into another as a single update, or returns null when equal', () => {
    const current = new Y.Doc();
    current.getXmlFragment('content').insert(0, [para('now'), para('more')]);
    const target = new Y.Doc();
    target.getXmlFragment('content').insert(0, [para('then')]);
    const update = buildReplacementUpdate(current, target)!;
    Y.applyUpdate(current, update);
    expect(content(current)).toBe('<paragraph>then</paragraph>');
    expect(buildReplacementUpdate(current, target)).toBeNull();
  });
});

describe.skipIf(!testDbUrl)('Phase 5: history, versions and restore (ADR-0012)', () => {
  let prisma: TestPrisma;
  let app: FastifyInstance;
  let base: string;
  const conns: ConvergeConnection[] = [];

  async function start(snapshotEvery = 500) {
    const a = buildApp({ dbCheck: async () => {}, prisma, auth: testAuth, rateLimits: relaxedLimits, realtime: { allowedOrigins: [], snapshotEvery } });
    await a.listen({ host: '127.0.0.1', port: 0 });
    const addr = a.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    return { app: a, base: `http://127.0.0.1:${addr.port}` };
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    ({ app, base } = await start());
  });
  afterAll(async () => {
    for (const c of conns) c.close();
    await app.close();
    await prisma.$disconnect();
  });

  const api = (u: TestUser, method: 'GET' | 'POST', url: string, payload?: object, a = app) =>
    a.inject({ method, url: `/api/v1/documents${url}`, headers: bearer(u), ...(payload && { payload }) });

  function client(u: TestUser, docId: string, at = base) {
    const doc = new Y.Doc();
    const conn = new ConvergeConnection({ documentId: docId, apiBase: at, getAccessToken: async () => u.accessToken, backoff: { initialMs: 20, maxMs: 80 } });
    const sync = new YjsSync(conn, doc);
    conn.connect();
    conns.push(conn);
    return { doc, conn, sync };
  }
  const settled = (c: { sync: YjsSync }) => c.sync.state === 'synced' && c.sync.pendingCount === 0;

  async function team() {
    const owner = await registerUser(app, 'Owner');
    const editor = await registerUser(app, 'Editor');
    const viewer = await registerUser(app, 'Viewer');
    const doc = (await api(owner, 'POST', '', { title: 'history' })).json() as { id: string };
    await api(owner, 'POST', `/${doc.id}/members`, { email: editor.email, role: 'editor' });
    await api(owner, 'POST', `/${doc.id}/members`, { email: viewer.email, role: 'viewer' });
    return { owner, editor, viewer, docId: doc.id };
  }

  it('CT-10: restores a chosen version as a new edit that everyone receives', async () => {
    const t = await team();
    const ed = client(t.editor, t.docId);
    const watcher = client(t.viewer, t.docId);
    await until(() => settled(ed) && settled(watcher));

    ed.doc.getXmlFragment('content').insert(0, [para('version one')]);
    await until(() => settled(ed));
    const v1 = await api(t.editor, 'POST', `/${t.docId}/versions`, { name: 'v1', note: 'first draft' });
    expect(v1.statusCode).toBe(201);
    expect(v1.json()).toMatchObject({ name: 'v1', note: 'first draft', kind: 'manual', createdBy: t.editor.id });

    ed.doc.getXmlFragment('content').delete(0, 1);
    ed.doc.getXmlFragment('content').insert(0, [para('rewritten'), para('and extended')]);
    await until(() => settled(ed) && content(watcher.doc) === content(ed.doc));
    const updatesBefore = await prisma.documentUpdate.count({ where: { documentId: t.docId } });

    const res = await api(t.owner, 'POST', `/${t.docId}/restore`, { versionId: v1.json().id });
    expect(res.statusCode).toBe(200);
    const { preRestoreVersionId } = res.json();

    await until(() => content(ed.doc) === '<paragraph>version one</paragraph>' && content(watcher.doc) === content(ed.doc), 6_000, 'restore broadcast');
    // A new update was appended; nothing was overwritten (§4.6).
    expect(await prisma.documentUpdate.count({ where: { documentId: t.docId } })).toBe(updatesBefore + 1);
    const restoreRow = await prisma.documentUpdate.findFirst({ where: { documentId: t.docId }, orderBy: { id: 'desc' } });
    expect(restoreRow).toMatchObject({ clientId: 'server:restore', userId: t.owner.id });

    // The pre-restore version holds the state just before restoring, so the restore can be undone.
    const pre = (await api(t.viewer, 'GET', `/${t.docId}/versions/${preRestoreVersionId}`)).json();
    expect(pre.version.kind).toBe('pre_restore');
    expect(pre.content).toBe('<paragraph>rewritten</paragraph><paragraph>and extended</paragraph>');
    const undo = await api(t.owner, 'POST', `/${t.docId}/restore`, { versionId: preRestoreVersionId });
    expect(undo.statusCode).toBe(200);
    await until(() => content(watcher.doc) === pre.content, 6_000, 'undo restore');

    const audit = await prisma.auditLog.findMany({ where: { documentId: t.docId, action: { in: ['version.create', 'document.restore'] } } });
    expect(audit.filter((a) => a.action === 'document.restore')).toHaveLength(2);
    expect(audit.some((a) => a.action === 'version.create')).toBe(true);
  });

  it('restores also work while nobody is connected, and survive a restart', async () => {
    const t = await team();
    const ed = client(t.editor, t.docId);
    await until(() => settled(ed));
    ed.doc.getXmlFragment('content').insert(0, [para('keep me')]);
    await until(() => settled(ed));
    const v = (await api(t.editor, 'POST', `/${t.docId}/versions`, { name: 'keep' })).json();
    ed.doc.getXmlFragment('content').insert(1, [para('discard me')]);
    await until(() => settled(ed));
    ed.conn.close();

    expect((await api(t.owner, 'POST', `/${t.docId}/restore`, { versionId: v.id })).statusCode).toBe(200);
    const second = await start();
    try {
      const fresh = client(t.owner, t.docId, second.base);
      await until(() => fresh.sync.state === 'synced');
      expect(content(fresh.doc)).toBe('<paragraph>keep me</paragraph>');
      fresh.conn.close();
    } finally {
      await second.app.close();
    }
  });

  it('permissions: viewers read history and versions; only owner/editor create, only owner restores', async () => {
    const t = await team();
    const v = await api(t.owner, 'POST', `/${t.docId}/versions`, { name: 'empty' });
    expect(v.statusCode).toBe(201);
    expect((await api(t.viewer, 'POST', `/${t.docId}/versions`, { name: 'nope' })).statusCode).toBe(403);
    expect((await api(t.viewer, 'GET', `/${t.docId}/versions`)).json().items).toHaveLength(1);
    expect((await api(t.viewer, 'GET', `/${t.docId}/history`)).statusCode).toBe(200);
    expect((await api(t.editor, 'POST', `/${t.docId}/restore`, { versionId: v.json().id })).statusCode).toBe(403);
    expect((await api(t.viewer, 'POST', `/${t.docId}/restore`, { versionId: v.json().id })).statusCode).toBe(403);

    const outsider = await registerUser(app, 'Out');
    expect((await api(outsider, 'GET', `/${t.docId}/versions`)).statusCode).toBe(404);
    expect((await api(outsider, 'GET', `/${t.docId}/versions/${v.json().id}`)).statusCode).toBe(404);
  });

  it('a version id from another document is not found', async () => {
    const a = await team();
    const b = await team();
    const v = (await api(a.owner, 'POST', `/${a.docId}/versions`, { name: 'a' })).json();
    expect((await api(b.owner, 'GET', `/${b.docId}/versions/${v.id}`)).statusCode).toBe(404);
    expect((await api(b.owner, 'POST', `/${b.docId}/restore`, { versionId: v.id })).statusCode).toBe(404);
  });

  it('history lists updates newest first with authors and pages with `before`', async () => {
    const t = await team();
    const ed = client(t.editor, t.docId);
    await until(() => settled(ed));
    for (const word of ['one', 'two', 'three']) {
      ed.doc.getXmlFragment('content').push([para(word)]);
      await until(() => settled(ed));
    }
    const page1 = (await api(t.viewer, 'GET', `/${t.docId}/history?limit=2`)).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]).toMatchObject({ userId: t.editor.id, displayName: 'Editor' });
    expect(BigInt(page1.items[0].id)).toBeGreaterThan(BigInt(page1.items[1].id));
    const page2 = (await api(t.viewer, 'GET', `/${t.docId}/history?limit=2&before=${page1.nextBefore}`)).json();
    expect(page2.items).toHaveLength(1);
    expect(page2.nextBefore).toBeNull();
    expect(page1.items[0]).not.toHaveProperty('payload');
  });

  it('snapshots every N updates and loads from snapshot + tail (R-15)', async () => {
    const small = await start(3);
    try {
      const owner = await registerUser(small.app, 'Snap');
      const doc = (await small.app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner), payload: { title: 's' } })).json();
      const c = client(owner, doc.id, small.base);
      await until(() => settled(c));
      for (let i = 0; i < 7; i++) {
        c.doc.getXmlFragment('content').push([para(`p${i}`)]);
        await until(() => settled(c));
      }
      const snaps = await prisma.documentSnapshot.findMany({ where: { documentId: doc.id }, orderBy: { lastUpdateId: 'asc' } });
      expect(snaps).toHaveLength(2); // after updates 3 and 6
      const expected = content(c.doc);
      c.conn.close();

      const again = await start(3);
      try {
        const fresh = client(owner, doc.id, again.base);
        await until(() => fresh.sync.state === 'synced');
        expect(content(fresh.doc)).toBe(expected);
        fresh.conn.close();
      } finally {
        await again.app.close();
      }
    } finally {
      await small.app.close();
    }
  });
});
