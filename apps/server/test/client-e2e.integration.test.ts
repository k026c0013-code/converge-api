import { ConvergeConnection, type Participant, type RemoteUpdate, type StopReason } from '@converge/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { yUpdate } from './ws-helpers.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';

/** Waits until `predicate` holds, polling briefly. */
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!testDbUrl)('@converge/client against the real server (Phase 2 completion criteria)', () => {
  let prisma: TestPrisma;
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    prisma = createTestPrisma();
    app = buildApp({ dbCheck: async () => {}, prisma, auth: testAuth, rateLimits: relaxedLimits, realtime: { allowedOrigins: [] } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function connect(user: TestUser, documentId: string) {
    const conn = new ConvergeConnection({
      documentId,
      apiBase: base,
      getAccessToken: async () => user.accessToken,
      backoff: { initialMs: 50, maxMs: 200 },
    });
    const state = { participants: [] as Participant[], updates: [] as RemoteUpdate[], stopped: null as StopReason | null };
    conn.on('participants', (p) => (state.participants = p));
    conn.on('update', (u) => state.updates.push(u));
    conn.on('stopped', (r) => (state.stopped = r));
    conn.connect();
    return { conn, state };
  }

  const key = (ps: Participant[]) => ps.map((p) => p.sessionId).sort().join(',');

  it('several clients join one document, agree on participants and relay updates', async () => {
    const [owner, a, b] = await Promise.all(['Owner', 'A', 'B'].map((t) => registerUser(app, t)));
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner!), payload: { title: 'e2e' } })).json();
    for (const u of [a!, b!]) {
      await app.inject({ method: 'POST', url: `/api/v1/documents/${doc.id}/members`, headers: bearer(owner!), payload: { email: u.email, role: 'editor' } });
    }

    const clients = [connect(owner!, doc.id), connect(a!, doc.id), connect(b!, doc.id)];
    await until(() => clients.every((c) => c.state.participants.length === 3));
    const keys = clients.map((c) => key(c.state.participants));
    expect(new Set(keys).size).toBe(1); // every client sees the same participant set

    const bytes = yUpdate('from A');
    const id = clients[1]!.conn.sendUpdate(bytes);
    await until(() => clients[0]!.state.updates.length === 1 && clients[2]!.state.updates.length === 1);
    expect(clients[0]!.state.updates[0]).toMatchObject({ updateId: id, payload: bytes });
    expect(clients[1]!.state.updates).toHaveLength(0);

    clients[2]!.conn.close();
    await until(() => clients[0]!.state.participants.length === 2);
    for (const c of clients) c.conn.close();
  });

  it('stops reconnecting when the user is removed from the document', async () => {
    const [owner, guest] = await Promise.all([registerUser(app, 'O'), registerUser(app, 'G')]);
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner!), payload: { title: 'kick' } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/documents/${doc.id}/members`, headers: bearer(owner!), payload: { email: guest!.email, role: 'viewer' } });

    const c = connect(guest!, doc.id);
    await until(() => c.conn.status === 'open');
    await app.inject({ method: 'DELETE', url: `/api/v1/documents/${doc.id}/members/${guest!.id}`, headers: bearer(owner!) });
    await until(() => c.state.stopped !== null);
    expect(c.state.stopped).toBe('access_revoked');
    expect(c.conn.status).toBe('closed');
  });
});
