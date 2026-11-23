import { ConvergeConnection, YjsSync } from '@converge/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../src/app.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma } from './helpers.js';

async function until(predicate: () => boolean, ms = 6_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`${what} not met in time`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A WebSocket whose "network" the test can cut: drops the live socket and makes new ones fail. */
function flakyNetwork() {
  const net = { online: true, sockets: new Set<WebSocket>() };
  class FlakyWebSocket extends WebSocket {
    constructor(url: string) {
      // Port 9 (discard) on loopback refuses immediately: a failed connection attempt.
      super(net.online ? url : 'ws://127.0.0.1:9/offline');
      net.sockets.add(this);
      this.addEventListener('close', () => net.sockets.delete(this));
    }
  }
  return {
    WebSocket: FlakyWebSocket,
    goOffline() {
      net.online = false;
      for (const s of net.sockets) s.close(); // client-side close → code 1005/1006: reconnect path
    },
    goOnline() {
      net.online = true;
    },
  };
}

const text = (d: Y.Doc) => d.getXmlFragment('content').toString();

describe.skipIf(!testDbUrl)('CT-06: offline edits merge after reconnecting (ADR-0011)', () => {
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

  it('merges edits made by an offline client with concurrent online edits', async () => {
    const owner = await registerUser(app, 'Online');
    const roamer = await registerUser(app, 'Offline');
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(owner), payload: { title: 'ct06' } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/documents/${doc.id}/members`, headers: bearer(owner), payload: { email: roamer.email, role: 'editor' } });

    const net = flakyNetwork();
    const dirtyLog: boolean[] = [];
    const mk = (token: string, WS?: new (url: string) => WebSocket) => {
      const ydoc = new Y.Doc();
      const conn = new ConvergeConnection({
        documentId: doc.id,
        apiBase: base,
        getAccessToken: async () => token,
        backoff: { initialMs: 20, maxMs: 80 },
        ...(WS && { WebSocket: WS }),
      });
      const sync = new YjsSync(conn, ydoc, undefined, WS ? { dirtyStore: { get: () => false, set: (d) => dirtyLog.push(d) } } : {});
      conn.connect();
      return { ydoc, conn, sync };
    };
    const online = mk(owner.accessToken);
    const offline = mk(roamer.accessToken, net.WebSocket);
    await until(() => online.sync.state === 'synced' && offline.sync.state === 'synced', 6_000, 'initial sync');

    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('base')]);
    online.ydoc.getXmlFragment('content').insert(0, [p]);
    await until(() => text(offline.ydoc) === '<paragraph>base</paragraph>', 6_000, 'seed');
    const node = (d: Y.Doc) => (d.getXmlFragment('content').get(0) as Y.XmlElement).get(0) as Y.XmlText;

    net.goOffline();
    await until(() => offline.sync.state === 'offline', 3_000, 'offline');

    node(offline.ydoc).insert(0, '[offline] ');
    const extra = new Y.XmlElement('paragraph');
    extra.insert(0, [new Y.XmlText('written on the train')]);
    offline.ydoc.getXmlFragment('content').push([extra]);
    node(online.ydoc).insert(4, ' [online]');
    expect(offline.sync.dirty).toBe(true);

    await new Promise((r) => setTimeout(r, 300)); // several failed reconnect attempts
    expect(offline.sync.state).toBe('offline');
    expect(text(online.ydoc)).not.toContain('offline');

    net.goOnline();
    await until(
      () => offline.sync.state === 'synced' && online.sync.state === 'synced' && text(online.ydoc) === text(offline.ydoc) && text(online.ydoc).includes('train'),
      8_000,
      'merge after reconnect',
    );
    const merged = text(online.ydoc);
    expect(merged).toContain('[offline] base [online]');
    expect(merged).toContain('<paragraph>written on the train</paragraph>');
    expect(offline.sync.dirty).toBe(false);
    expect(offline.sync.pendingCount).toBe(0);
    expect(dirtyLog).toEqual([true, false]);

    online.conn.close();
    offline.conn.close();
  }, 30_000);
});
