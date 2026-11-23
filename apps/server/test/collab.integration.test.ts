import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { HubLimits } from '../src/collab/hub.js';
import { MemoryTicketStore } from '../src/collab/tickets.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';
import { b64, expectRejected, issueTicket, join, rawConnect } from './ws-helpers.js';

const ORIGIN = 'http://app.example.test';

async function startApp(prisma: TestPrisma, extra: { limits?: Partial<HubLimits>; maxPayloadBytes?: number; tickets?: MemoryTicketStore } = {}) {
  const app = buildApp({
    dbCheck: async () => {},
    prisma,
    auth: testAuth,
    rateLimits: relaxedLimits,
    realtime: { allowedOrigins: [ORIGIN], ...extra },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

describe.skipIf(!testDbUrl)('realtime /ws/documents/{id} (MySQL)', () => {
  let prisma: TestPrisma;
  let app: FastifyInstance;

  beforeAll(async () => {
    prisma = createTestPrisma();
    app = await startApp(prisma);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = (u: TestUser, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: bearer(u), ...(payload && { payload }) });

  async function team() {
    const [owner, editor, viewer, outsider] = await Promise.all(['Owner', 'Editor', 'Viewer', 'Outsider'].map((t) => registerUser(app, t)));
    const doc = (await api(owner!, 'POST', '/documents', { title: 'rt' })).json() as { id: string };
    await api(owner!, 'POST', `/documents/${doc.id}/members`, { email: editor!.email, role: 'editor' });
    await api(owner!, 'POST', `/documents/${doc.id}/members`, { email: viewer!.email, role: 'viewer' });
    return { owner: owner!, editor: editor!, viewer: viewer!, outsider: outsider!, docId: doc.id };
  }

  describe('ticket endpoint', () => {
    it('gives members a 30 s ticket and hides the document from outsiders', async () => {
      const t = await team();
      const res = await api(t.viewer, 'POST', `/documents/${t.docId}/ws-ticket`);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ ticket: expect.any(String), expiresIn: 30 });
      expect((await api(t.outsider, 'POST', `/documents/${t.docId}/ws-ticket`)).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/v1/documents/${t.docId}/ws-ticket` })).statusCode).toBe(401);
    });
  });

  describe('handshake', () => {
    it('rejects missing, unknown and reused tickets with 401', async () => {
      const t = await team();
      expect(await expectRejected(rawConnect(app, `/ws/documents/${t.docId}`))).toBe(401);
      expect(await expectRejected(rawConnect(app, `/ws/documents/${t.docId}?ticket=forged`))).toBe(401);
      const ticket = await issueTicket(app, t.editor, t.docId);
      const first = rawConnect(app, `/ws/documents/${t.docId}?ticket=${ticket}`);
      await first.opened;
      expect(await expectRejected(rawConnect(app, `/ws/documents/${t.docId}?ticket=${ticket}`))).toBe(401);
      first.close();
    });

    it('rejects a ticket used for another document', async () => {
      const t = await team();
      const other = (await api(t.editor, 'POST', '/documents', { title: 'other' })).json() as { id: string };
      const ticket = await issueTicket(app, t.editor, other.id);
      expect(await expectRejected(rawConnect(app, `/ws/documents/${t.docId}?ticket=${ticket}`))).toBe(401);
    });

    it('rejects a foreign Origin with 403 but allows the listed one', async () => {
      const t = await team();
      const ticket = await issueTicket(app, t.editor, t.docId);
      expect(await expectRejected(rawConnect(app, `/ws/documents/${t.docId}?ticket=${ticket}`, { origin: 'https://evil.example' }))).toBe(403);
      const { client } = await join(app, t.editor, t.docId, { origin: ORIGIN });
      client.close();
    });

    it('rejects unknown paths and malformed ids with 404', async () => {
      expect(await expectRejected(rawConnect(app, '/ws/other'))).toBe(404);
      expect(await expectRejected(rawConnect(app, '/ws/documents/not-a-uuid?ticket=x'))).toBe(404);
    });

    it('re-checks membership: a ticket issued before removal no longer works', async () => {
      const t = await team();
      const ticket = await issueTicket(app, t.editor, t.docId);
      await api(t.owner, 'DELETE', `/documents/${t.docId}/members/${t.editor.id}`);
      expect(await expectRejected(rawConnect(app, `/ws/documents/${t.docId}?ticket=${ticket}`))).toBe(404);
    });
  });

  describe('presence', () => {
    it('announces joins and leaves with server-assigned names and roles', async () => {
      const t = await team();
      const a = await join(app, t.owner, t.docId);
      expect(a.ready).toMatchObject({ userId: t.owner.id, role: 'owner' });
      expect(a.ready.participants).toHaveLength(1);

      const b = await join(app, t.viewer, t.docId);
      expect((b.ready.participants as unknown[]).length).toBe(2);
      const joined = await a.client.next('document:user_joined');
      expect(joined.participant).toEqual({ sessionId: b.ready.sessionId, userId: t.viewer.id, displayName: 'Viewer', role: 'viewer' });

      // Same user in a second tab = a second participant.
      const b2 = await join(app, t.viewer, t.docId);
      expect((b2.ready.participants as unknown[]).length).toBe(3);

      b.client.close();
      const left = await a.client.next('document:user_left');
      expect((left.participant as { sessionId: string }).sessionId).toBe(b.ready.sessionId);
      a.client.close();
      b2.client.close();
    });
  });

  describe('relay', () => {
    it('relays opaque payloads to the other sessions of the same document only', async () => {
      const t = await team();
      const other = (await api(t.owner, 'POST', '/documents', { title: 'elsewhere' })).json() as { id: string };
      const sender = await join(app, t.editor, t.docId);
      const peer = await join(app, t.owner, t.docId);
      const viewer = await join(app, t.viewer, t.docId);
      const elsewhere = await join(app, t.owner, other.id);

      const updateId = randomUUID();
      sender.client.send({ type: 'update:submit', updateId, payload: b64('hello') });

      for (const c of [peer.client, viewer.client]) {
        const msg = await c.next('update:broadcast');
        expect(msg).toEqual({ type: 'update:broadcast', updateId, payload: b64('hello'), from: { sessionId: sender.ready.sessionId, userId: t.editor.id } });
      }
      expect(await sender.client.none('update:broadcast')).toBe(true);
      expect(await elsewhere.client.none('update:broadcast')).toBe(true);
      expect(await sender.client.none('update:ack')).toBe(true); // Phase 2 does not persist, so no ACK (ADR-0009 §2)
      for (const c of [sender, peer, viewer, elsewhere]) c.client.close();
    });

    it('refuses edits from viewers (CT-08 precursor) and does not relay them', async () => {
      const t = await team();
      const viewer = await join(app, t.viewer, t.docId);
      const owner = await join(app, t.owner, t.docId);
      const updateId = randomUUID();
      viewer.client.send({ type: 'update:submit', updateId, payload: b64('nope') });
      expect(await viewer.client.next('error')).toMatchObject({ code: 'FORBIDDEN', ref: updateId });
      expect(await owner.client.none('update:broadcast')).toBe(true);
      viewer.client.close();
      owner.client.close();
    });

    it('answers invalid and not-yet-supported messages with error', async () => {
      const t = await team();
      const c = await join(app, t.editor, t.docId);
      c.client.send('not json');
      expect(await c.client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
      c.client.send({ type: 'awareness:update', state: {} });
      expect(await c.client.next('error')).toMatchObject({ code: 'UNSUPPORTED_TYPE' });
      c.client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
      expect(await c.client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
      c.client.close();
    });
  });

  describe('access changes while connected (R-13)', () => {
    it('promotes and demotes live sessions', async () => {
      const t = await team();
      const viewer = await join(app, t.viewer, t.docId);
      const owner = await join(app, t.owner, t.docId);

      await api(t.owner, 'PATCH', `/documents/${t.docId}/members/${t.viewer.id}`, { role: 'editor' });
      expect(await viewer.client.next('session:role_changed')).toMatchObject({ role: 'editor' });
      viewer.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64('now allowed') });
      await owner.client.next('update:broadcast');

      await api(t.owner, 'PATCH', `/documents/${t.docId}/members/${t.viewer.id}`, { role: 'viewer' });
      expect(await viewer.client.next('session:role_changed')).toMatchObject({ role: 'viewer' });
      viewer.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64('blocked again') });
      expect(await viewer.client.next('error')).toMatchObject({ code: 'FORBIDDEN' });
      viewer.client.close();
      owner.client.close();
    });

    it('closes removed members with 4003 and tells the others they left', async () => {
      const t = await team();
      const editor = await join(app, t.editor, t.docId);
      const owner = await join(app, t.owner, t.docId);
      await api(t.owner, 'DELETE', `/documents/${t.docId}/members/${t.editor.id}`);
      expect((await editor.client.closed).code).toBe(4003);
      await owner.client.next('document:user_left');
      owner.client.close();
    });

    it('closes everyone with 4004 when the document is deleted', async () => {
      const t = await team();
      const a = await join(app, t.editor, t.docId);
      const b = await join(app, t.owner, t.docId);
      await api(t.owner, 'DELETE', `/documents/${t.docId}`);
      expect((await a.client.closed).code).toBe(4004);
      expect((await b.client.closed).code).toBe(4004);
    });

    it('logout closes only the sessions opened from that login (4001)', async () => {
      const t = await team();
      const other = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: t.editor.email, password: t.editor.password } })
      ).json().tokens as { accessToken: string; refreshToken: string };
      const secondLogin = { ...t.editor, ...other };

      const s1 = await join(app, t.editor, t.docId);
      const s2 = await join(app, secondLogin, t.docId);
      await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken: t.editor.refreshToken } });
      expect((await s1.client.closed).code).toBe(4001);
      expect(await s2.client.none('never', 200)).toBe(true);
      expect(s2.client.ws.readyState).toBe(s2.client.ws.OPEN);
      s2.client.close();
    });
  });
});

describe.skipIf(!testDbUrl)('realtime limits (MySQL)', () => {
  let prisma: TestPrisma;
  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup(extra: Parameters<typeof startApp>[1]) {
    const app = await startApp(prisma, extra);
    const owner = await registerUser(app, 'lim');
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner), payload: { title: 'l' } })).json() as { id: string };
    return { app, owner, docId: doc.id };
  }

  it('drops peers that stop answering pings', async () => {
    const { app, owner, docId } = await setup({ limits: { heartbeatMs: 100 } });
    const silent = await join(app, owner, docId, { autoPong: false });
    expect((await silent.client.closed).code).toBe(1006); // terminated without a close frame
    await app.close();
  });

  it('closes sessions at the maximum lifetime with 4008', async () => {
    const { app, owner, docId } = await setup({ limits: { maxLifetimeMs: 200 } });
    const c = await join(app, owner, docId);
    expect((await c.client.closed).code).toBe(4008);
    await app.close();
  });

  it('closes on oversized frames (1009), floods and repeated violations (1008)', async () => {
    const { app, owner, docId } = await setup({ maxPayloadBytes: 1024, limits: { maxMessagesPerWindow: 5, maxViolations: 3 } });
    const big = await join(app, owner, docId);
    big.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64('x'.repeat(2048)) });
    expect((await big.client.closed).code).toBe(1009);

    const flood = await join(app, owner, docId);
    for (let i = 0; i < 6; i++) flood.client.send({ type: 'update:submit', updateId: randomUUID(), payload: b64('x') });
    expect((await flood.client.closed).code).toBe(1008);

    const bad = await join(app, owner, docId);
    for (let i = 0; i < 4; i++) bad.client.send('garbage');
    expect((await bad.client.closed).code).toBe(1008);
    await app.close();
  });

  it('rejects an expired ticket', async () => {
    const tickets = new MemoryTicketStore(1);
    const { app, owner, docId } = await setup({ tickets });
    const ticket = await issueTicket(app, owner, docId);
    await new Promise((r) => setTimeout(r, 10));
    expect(await expectRejected(rawConnect(app, `/ws/documents/${docId}?ticket=${ticket}`))).toBe(401);
    await app.close();
  });

  it('closes open sockets with 1001 on shutdown', async () => {
    const { app, owner, docId } = await setup({});
    const c = await join(app, owner, docId);
    await app.close();
    expect((await c.client.closed).code).toBe(1001);
  });
});
