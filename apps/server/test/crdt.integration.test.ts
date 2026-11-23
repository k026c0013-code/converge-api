import { randomUUID } from 'node:crypto';
import { ConvergeConnection, YjsSync } from '@converge/client';
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { buildApp } from '../src/app.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';
import { join } from './ws-helpers.js';

async function until(predicate: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`${what} not met in time`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const text = (doc: Y.Doc) => doc.getXmlFragment('content').toString();
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/** A paragraph whose text we can edit, created once by the owner and synced to everyone. */
function textNode(doc: Y.Doc): Y.XmlText {
  return (doc.getXmlFragment('content').get(0) as Y.XmlElement).get(0) as Y.XmlText;
}

async function startApp(prisma: TestPrisma): Promise<{ app: FastifyInstance; base: string }> {
  const app = buildApp({ dbCheck: async () => {}, prisma, auth: testAuth, rateLimits: relaxedLimits, realtime: { allowedOrigins: [], limits: { maxMessagesPerWindow: 10_000 } } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

describe.skipIf(!testDbUrl)('Phase 3: Yjs sync through the server (requirements §15)', () => {
  let prisma: TestPrisma;
  let app: FastifyInstance;
  let base: string;
  const open: Array<{ conn: ConvergeConnection; sync: YjsSync }> = [];

  beforeAll(async () => {
    prisma = createTestPrisma();
    ({ app, base } = await startApp(prisma));
  });
  afterAll(async () => {
    for (const c of open) c.conn.close();
    await app.close();
    await prisma.$disconnect();
  });

  function client(user: TestUser, documentId: string, opts: { doc?: Y.Doc; awareness?: boolean; at?: string } = {}) {
    const doc = opts.doc ?? new Y.Doc();
    const awareness = opts.awareness ? new awarenessProtocol.Awareness(doc) : undefined;
    const conn = new ConvergeConnection({ documentId, apiBase: opts.at ?? base, getAccessToken: async () => user.accessToken, backoff: { initialMs: 20, maxMs: 100 } });
    const sync = new YjsSync(conn, doc, awareness);
    conn.connect();
    const c = { conn, sync, doc, awareness };
    open.push(c);
    return c;
  }
  const synced = (c: { sync: YjsSync }) => c.sync.state === 'synced';
  const settled = (cs: Array<{ sync: YjsSync }>) => cs.every((c) => c.sync.state === 'synced' && c.sync.pendingCount === 0);

  async function team(roles: Array<'editor' | 'viewer'> = ['editor', 'editor']) {
    const owner = await registerUser(app, 'Owner');
    const others: TestUser[] = [];
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner), payload: { title: 'crdt' } })).json() as { id: string };
    for (const [i, role] of roles.entries()) {
      const u = await registerUser(app, `${role}${i}`);
      await app.inject({ method: 'POST', url: `/api/v1/documents/${doc.id}/members`, headers: bearer(owner), payload: { email: u.email, role } });
      others.push(u);
    }
    return { owner, others, docId: doc.id };
  }

  /** Owner writes one paragraph; returns once everyone has it. */
  async function seed(clients: Array<{ doc: Y.Doc; sync: YjsSync }>, initial = 'hello') {
    await until(() => clients.every(synced), 5_000, 'initial sync');
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText(initial)]);
    clients[0]!.doc.getXmlFragment('content').insert(0, [p]);
    await until(() => clients.every((c) => text(c.doc) === `<paragraph>${initial}</paragraph>`) && settled(clients), 5_000, 'seed');
  }

  it('CT-01: concurrent edits by two users are both kept', async () => {
    const t = await team();
    const cs = [client(t.owner, t.docId), client(t.others[0]!, t.docId), client(t.others[1]!, t.docId)];
    await seed(cs, 'middle');
    textNode(cs[1]!.doc).insert(0, 'A-');
    textNode(cs[2]!.doc).insert(6, '-B');
    await until(() => settled(cs) && cs.every((c) => text(c.doc) === text(cs[0]!.doc)) && text(cs[0]!.doc).includes('A-') && text(cs[0]!.doc).includes('-B'));
    expect(text(cs[0]!.doc)).toBe('<paragraph>A-middle-B</paragraph>');
  });

  it('CT-02/03: same-position inserts and overlapping deletes converge', async () => {
    const t = await team();
    const cs = [client(t.owner, t.docId), client(t.others[0]!, t.docId), client(t.others[1]!, t.docId)];
    await seed(cs, 'abcdef');
    textNode(cs[1]!.doc).insert(3, 'XX');
    textNode(cs[2]!.doc).insert(3, 'YY');
    textNode(cs[0]!.doc).delete(1, 4); // overlaps the insert point
    textNode(cs[1]!.doc).delete(0, 2); // concurrent with the owner's delete: overlapping "b"
    await until(() => settled(cs) && cs.every((c) => text(c.doc) === text(cs[0]!.doc)), 5_000, 'convergence');
    const final = text(cs[0]!.doc);
    expect(final).toContain('XX');
    expect(final).toContain('YY');
    const inner = textNode(cs[0]!.doc).toString();
    expect(inner).not.toMatch(/[abcde]/); // both deletes applied, nothing resurrected
    expect(inner.endsWith('f')).toBe(true);
    // Everyone has the same state vector too.
    expect(new Set(cs.map((c) => Y.encodeStateVector(c.doc).toString())).size).toBe(1);
  });

  it('CT-04: updates arriving in reverse dependency order still converge', async () => {
    const t = await team(['editor']);
    const author = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('first')]);
    author.getXmlFragment('content').insert(0, [p]);
    const u1 = Y.encodeStateAsUpdate(author);
    const sv1 = Y.encodeStateVector(author);
    textNode(author).insert(5, ' second');
    const u2 = Y.encodeStateAsUpdate(author, sv1); // depends on u1

    const raw = await join(app, t.others[0]!, t.docId);
    raw.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64(u2) });
    await raw.client.next('update:ack');
    raw.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64(u1) });
    await raw.client.next('update:ack');

    const late = client(t.owner, t.docId);
    await until(() => synced(late) && text(late.doc) === '<paragraph>first second</paragraph>', 5_000, 'late joiner');
    raw.client.close();
  });

  it('CT-05: a resent updateId is stored once and broadcast once', async () => {
    const t = await team(['editor']);
    const sender = await join(app, t.others[0]!, t.docId);
    const watcher = await join(app, t.owner, t.docId);
    const d = new Y.Doc();
    d.getXmlFragment('content').insert(0, [new Y.XmlText('once')]);
    const msg = { type: 'update:submit', updateId: randomUUID(), payload: b64(Y.encodeStateAsUpdate(d)) };
    sender.client.send(msg);
    await sender.client.next('update:ack');
    sender.client.send(msg);
    await sender.client.next('update:ack'); // still acknowledged, so the client stops retrying
    await watcher.client.next('update:broadcast');
    expect(await watcher.client.none('update:broadcast', 200)).toBe(true);
    expect(await prisma.documentUpdate.count({ where: { documentId: t.docId, updateId: msg.updateId } })).toBe(1);
    sender.client.close();
    watcher.client.close();
  });

  it('CT-07: state survives a server restart (rebuilt from document_updates)', async () => {
    const t = await team(['editor']);
    const cs = [client(t.owner, t.docId), client(t.others[0]!, t.docId)];
    await seed(cs, 'persist me');
    textNode(cs[1]!.doc).insert(0, '>> ');
    await until(() => settled(cs) && text(cs[0]!.doc).includes('>> '));
    const expected = text(cs[0]!.doc);

    const second = await startApp(prisma); // fresh process state: no live documents in memory
    try {
      const fresh = client(t.owner, t.docId, { at: second.base });
      await until(() => synced(fresh), 5_000, 'sync after restart');
      expect(text(fresh.doc)).toBe(expected);
      fresh.conn.close();
    } finally {
      await second.app.close();
    }
  });

  it('CT-08: viewer updates and writes outside `content` are neither stored nor broadcast', async () => {
    const t = await team(['viewer', 'editor']);
    const viewer = await join(app, t.others[0]!, t.docId);
    const editor = await join(app, t.others[1]!, t.docId);
    const watcher = await join(app, t.owner, t.docId);

    const d = new Y.Doc();
    d.getXmlFragment('content').insert(0, [new Y.XmlText('viewer edit')]);
    viewer.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64(Y.encodeStateAsUpdate(d)) });
    expect(await viewer.client.next('error')).toMatchObject({ code: 'FORBIDDEN' });

    const meta = new Y.Doc();
    meta.getMap('meta').set('title', 'hijacked');
    editor.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64(Y.encodeStateAsUpdate(meta)) });
    expect(await editor.client.next('error')).toMatchObject({ code: 'FORBIDDEN_ROOT' });

    expect(await watcher.client.none('update:broadcast', 200)).toBe(true);
    expect(await prisma.documentUpdate.count({ where: { documentId: t.docId } })).toBe(0);
    for (const c of [viewer, editor, watcher]) c.client.close();
  });

  it('a viewer client still receives edits but never sends any', async () => {
    const t = await team(['viewer']);
    const cs = [client(t.owner, t.docId), client(t.others[0]!, t.docId)];
    await seed(cs, 'read only');
    textNode(cs[1]!.doc).insert(0, 'ignored ');
    await new Promise((r) => setTimeout(r, 200));
    expect(cs[1]!.sync.pendingCount).toBe(0);
    expect(text(cs[0]!.doc)).toBe('<paragraph>read only</paragraph>');
  });

  it('R-10: edits made before connecting are sent on the first sync', async () => {
    const t = await team(['editor']);
    const first = client(t.owner, t.docId);
    await seed([first], 'server side');

    const offline = new Y.Doc();
    offline.getXmlFragment('content').insert(0, [new Y.XmlText('made offline ')]);
    const late = client(t.others[0]!, t.docId, { doc: offline });
    await until(() => settled([first, late]) && text(first.doc) === text(late.doc) && text(first.doc).includes('made offline'), 5_000, 'offline merge');
    expect(text(first.doc)).toContain('server side');
  });

  it('awareness: names are server-assigned, other clientIDs cannot be spoofed, and leaving clears the cursor', async () => {
    const t = await team(['editor']);
    const a = client(t.owner, t.docId, { awareness: true });
    const b = client(t.others[0]!, t.docId, { awareness: true });
    await until(() => synced(a) && synced(b));

    a.awareness!.setLocalState({ user: { name: 'Admin (fake)', color: '#000' }, cursor: { anchor: 1 } });
    await until(() => b.awareness!.getStates().has(a.doc.clientID), 3_000, 'awareness delivery');
    const seen = b.awareness!.getStates().get(a.doc.clientID) as { user: { name: string; userId: string }; cursor: unknown };
    expect(seen.user.name).toBe('Owner');
    expect(seen.user.userId).toBe(t.owner.id);
    expect(seen.cursor).toEqual({ anchor: 1 });

    // A forged entry for someone else's clientID is dropped by the server.
    const forger = await join(app, t.owner, t.docId);
    const fakeDoc = new Y.Doc();
    const fake = new awarenessProtocol.Awareness(fakeDoc);
    fake.setLocalState({ user: { name: 'me' } });
    forger.client.send({ type: 'awareness:update', payload: b64(awarenessProtocol.encodeAwarenessUpdate(fake, [fakeDoc.clientID])) });
    const forged = new awarenessProtocol.Awareness(new Y.Doc());
    (forged as unknown as { clientID: number }).clientID = b.doc.clientID;
    forged.setLocalState({ user: { name: 'impersonated' } });
    forger.client.send({ type: 'awareness:update', payload: b64(awarenessProtocol.encodeAwarenessUpdate(forged, [b.doc.clientID])) });
    await new Promise((r) => setTimeout(r, 200));
    expect((a.awareness!.getStates().get(b.doc.clientID) as { user?: { name: string } } | undefined)?.user?.name).not.toBe('impersonated');
    forger.client.close();

    a.conn.close();
    await until(() => !b.awareness!.getStates().has(a.doc.clientID), 3_000, 'cursor removal');
  });

  it('property: random concurrent edits from 3 clients always converge (fast-check)', async () => {
    const t = await team(['editor', 'editor']);
    const cs = [client(t.owner, t.docId), client(t.others[0]!, t.docId), client(t.others[1]!, t.docId)];
    await seed(cs, 'seed');

    const op = fc.record({
      who: fc.integer({ min: 0, max: 2 }),
      kind: fc.constantFrom('insert', 'delete'),
      pos: fc.nat(),
      len: fc.integer({ min: 1, max: 3 }),
      str: fc.string({ minLength: 1, maxLength: 3 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        for (const o of ops) {
          const node = textNode(cs[o.who]!.doc);
          const length = node.length;
          if (o.kind === 'insert') node.insert(o.pos % (length + 1), o.str);
          else if (length > 0) node.delete(o.pos % length, Math.min(o.len, length - (o.pos % length)));
        }
        await until(() => settled(cs) && cs.every((c) => text(c.doc) === text(cs[0]!.doc)), 8_000, 'property convergence');
      }),
      { numRuns: 15 },
    );
    // And a fresh client rebuilt from the database agrees with everyone.
    const fresh = client(t.owner, t.docId);
    await until(() => synced(fresh));
    expect(text(fresh.doc)).toBe(text(cs[0]!.doc));
  }, 120_000);
});
