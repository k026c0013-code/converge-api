import net from 'node:net';
import { ConvergeConnection, YjsSync, type Participant } from '@converge/client';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { buildApp } from '../src/app.js';
import { RedisCluster } from '../src/cluster/redis.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';
import { issueTicket, join, rawConnect } from './ws-helpers.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisReachable(): Promise<boolean> {
  const r = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on('error', () => {});
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const haveRedis = testDbUrl ? await redisReachable() : false;

async function until(predicate: () => boolean, ms = 6_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`${what} not met in time`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface Node {
  app: FastifyInstance;
  cluster: RedisCluster;
  port: number;
  base: string;
}

async function startNode(prisma: TestPrisma): Promise<Node> {
  const cluster = await RedisCluster.connect(redisUrl, { heartbeatMs: 100, nodeTtlMs: 600 });
  const app = buildApp({
    dbCheck: async () => {},
    prisma,
    auth: testAuth,
    rateLimits: relaxedLimits,
    realtime: { allowedOrigins: [], cluster, limits: { sweepMs: 200 } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { app, cluster, port: addr.port, base: `http://127.0.0.1:${addr.port}` };
}

/**
 * Failover TCP balancer (HTTP and WebSocket alike): always prefers the first backend and falls back
 * to the next one when it refuses connections — so the test knows which node a client is on.
 */
async function startBalancer(ports: number[]): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    const attempt = (tries: number) => {
      const port = ports[ports.length - tries]!;
      const upstream = net.connect(port, '127.0.0.1');
      upstream.once('connect', () => {
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        client.pipe(upstream).pipe(client);
      });
      upstream.once('error', () => {
        if (tries > 1 && !client.destroyed) attempt(tries - 1);
        else client.destroy();
      });
      client.on('error', () => upstream.destroy());
    };
    attempt(ports.length);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const content = (d: Y.Doc) => d.getXmlFragment('content').toString();
const para = (t: string) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(t)]);
  return p;
};

describe.skipIf(!haveRedis)('Phase 6: several Collaboration Servers sharing Redis (ADR-0013)', () => {
  let prisma: TestPrisma;
  let a: Node;
  let b: Node;
  const conns: ConvergeConnection[] = [];

  beforeAll(async () => {
    prisma = createTestPrisma();
    [a, b] = await Promise.all([startNode(prisma), startNode(prisma)]);
  });
  afterAll(async () => {
    for (const c of conns) c.close();
    await Promise.allSettled([a.app.close(), b.app.close()]);
    await prisma.$disconnect();
  });

  function client(u: TestUser, docId: string, base: string, withAwareness = false) {
    const doc = new Y.Doc();
    const awareness = withAwareness ? new awarenessProtocol.Awareness(doc) : undefined;
    const conn = new ConvergeConnection({ documentId: docId, apiBase: base, getAccessToken: async () => u.accessToken, backoff: { initialMs: 20, maxMs: 100 } });
    const sync = new YjsSync(conn, doc, awareness);
    const state = { participants: [] as Participant[] };
    conn.on('participants', (p) => (state.participants = p));
    conn.connect();
    conns.push(conn);
    return { doc, conn, sync, awareness, state };
  }
  const settled = (c: { sync: YjsSync }) => c.sync.state === 'synced' && c.sync.pendingCount === 0;

  async function pair() {
    const owner = await registerUser(a.app, 'OnA');
    const guest = await registerUser(a.app, 'OnB');
    const doc = (await a.app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner), payload: { title: 'cluster' } })).json() as { id: string };
    await a.app.inject({ method: 'POST', url: `/api/v1/documents/${doc.id}/members`, headers: bearer(owner), payload: { email: guest.email, role: 'editor' } });
    return { owner, guest, docId: doc.id };
  }

  it('a ticket issued by node A opens a session on node B', async () => {
    const t = await pair();
    const ticket = await issueTicket(a.app, t.guest, t.docId);
    const c = rawConnect(b.app, `/ws/documents/${t.docId}?ticket=${ticket}`);
    await c.opened;
    await c.next('session:ready');
    c.close();
    // …and it is still single-use across nodes.
    expect(await rawConnect(a.app, `/ws/documents/${t.docId}?ticket=${ticket}`).opened.then(() => 'open', () => 'rejected')).toBe('rejected');
  });

  it('completion criterion: users on different servers co-edit and see each other', async () => {
    const t = await pair();
    const onA = client(t.owner, t.docId, a.base, true);
    const onB = client(t.guest, t.docId, b.base, true);
    await until(() => settled(onA) && settled(onB));
    await until(() => onA.state.participants.length === 2 && onB.state.participants.length === 2, 6_000, 'cross-node presence');

    onA.doc.getXmlFragment('content').insert(0, [para('from A')]);
    onB.doc.getXmlFragment('content').insert(0, [para('from B')]);
    await until(() => settled(onA) && settled(onB) && content(onA.doc) === content(onB.doc) && content(onA.doc).includes('from A') && content(onA.doc).includes('from B'), 6_000, 'cross-node convergence');

    onA.awareness!.setLocalState({ cursor: { anchor: 3 } });
    await until(() => onB.awareness!.getStates().has(onA.doc.clientID), 3_000, 'cross-node awareness');
    expect((onB.awareness!.getStates().get(onA.doc.clientID) as { user: { name: string } }).user.name).toBe('OnA');

    onB.conn.close();
    await until(() => onA.state.participants.length === 1, 3_000, 'cross-node leave');
    await until(() => !onA.awareness!.getStates().has(onB.doc.clientID), 3_000, 'cross-node cursor removal');
    onA.conn.close();
  });

  it('access changes made on node A close sessions on node B', async () => {
    const t = await pair();
    const s = await join(b.app, t.guest, t.docId);
    await a.app.inject({ method: 'DELETE', url: `/api/v1/documents/${t.docId}/members/${t.guest.id}`, headers: bearer(t.owner) });
    expect((await s.client.closed).code).toBe(4003);
  });

  it('recovers updates whose Pub/Sub message was lost (DB catch-up sweep)', async () => {
    const t = await pair();
    const onA = client(t.owner, t.docId, a.base);
    const onB = client(t.guest, t.docId, b.base);
    await until(() => settled(onA) && settled(onB));

    const original = a.cluster.publishDoc.bind(a.cluster);
    a.cluster.publishDoc = () => {}; // drop every message from A
    try {
      onA.doc.getXmlFragment('content').insert(0, [para('lost in transit')]);
      await until(() => settled(onA));
      await until(() => content(onB.doc).includes('lost in transit'), 4_000, 'sweep recovery');
    } finally {
      a.cluster.publishDoc = original;
    }
  });

  it('failure recovery: when a node dies, its users leave the presence list and reconnect elsewhere', async () => {
    const c = await startNode(prisma);
    const d = await startNode(prisma);
    const lb = await startBalancer([c.port, d.port]);
    try {
      const t = await pair();
      const viaLb = client(t.owner, t.docId, lb.base); // lands on c, the balancer's primary
      const onD = client(t.guest, t.docId, d.base);
      await until(() => settled(viaLb) && settled(onD) && onD.state.participants.length === 2, 6_000, 'setup');
      viaLb.doc.getXmlFragment('content').insert(0, [para('before the crash')]);
      await until(() => settled(viaLb) && content(onD.doc).includes('before the crash'));

      const firstSession = viaLb.conn.sessionId;
      // Crash node c: no goodbye on Redis, its sockets drop, its port refuses connections.
      c.cluster.crash();
      await c.app.close();

      await until(() => settled(viaLb) && viaLb.conn.status === 'open' && viaLb.conn.sessionId !== firstSession, 8_000, 'client failover');
      viaLb.doc.getXmlFragment('content').push([para('after the crash')]);
      await until(() => settled(viaLb) && content(onD.doc).includes('after the crash'), 6_000, 'edits after failover');
      expect(content(viaLb.doc)).toBe(content(onD.doc));
      // The dead node's presence entries are pruned once its liveness key expires.
      await until(() => onD.state.participants.length === 2, 6_000, 'presence after failover');
      viaLb.conn.close();
      onD.conn.close();
    } finally {
      await lb.close();
      await Promise.allSettled([c.app.close(), d.app.close()]);
    }
  }, 30_000);
});
