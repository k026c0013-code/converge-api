import { AgentError, ConvergeAgent, CONTENT_FIELD, buildMcpServer, readBlocks } from '@converge/agent';
import { ConvergeConnection, YjsSync, type Participant } from '@converge/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { buildApp } from '../src/app.js';
import { bearer, createTestPrisma, registerUser, relaxedLimits, testAuth, testDbUrl, type TestPrisma, type TestUser } from './helpers.js';

/** ADR-0015: an AI agent takes part in a document through the normal REST + WebSocket API. */

async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!testDbUrl)('AI agent participant (ADR-0015)', () => {
  let prisma: TestPrisma;
  let app: FastifyInstance;
  let base: string;
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    prisma = createTestPrisma();
    app = buildApp({ dbCheck: async () => {}, prisma, auth: testAuth, rateLimits: relaxedLimits, realtime: { allowedOrigins: [] } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function setup(agentRole: 'editor' | 'viewer' = 'editor') {
    const human = await registerUser(app, 'Human');
    const bot = await registerUser(app, 'Claude');
    const title = `agent-${crypto.randomUUID()}`;
    const doc = (await app.inject({ method: 'POST', url: '/api/v1/documents', headers: bearer(human), payload: { title } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/documents/${doc.id}/members`, headers: bearer(human), payload: { email: bot.email, role: agentRole } });
    const agent = new ConvergeAgent({ apiBase: base, email: bot.email, password: bot.password, typing: { intervalMs: 2 }, idleMs: 150 });
    cleanups.push(() => agent.leave());
    return { human, bot, doc: doc as { id: string }, title, agent };
  }

  /** A "browser": Y.Doc + Awareness bound to the server, like apps/web does. */
  function connectHuman(user: TestUser, documentId: string) {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const conn = new ConvergeConnection({ documentId, apiBase: base, getAccessToken: async () => user.accessToken });
    const sync = new YjsSync(conn, ydoc, awareness);
    const state = { participants: [] as Participant[] };
    conn.on('participants', (p) => (state.participants = p));
    conn.connect();
    cleanups.push(() => {
      sync.destroy();
      conn.close();
      awareness.destroy();
    });
    return { ydoc, awareness, sync, state };
  }

  /** Adds one paragraph per line in a single edit (like pasting). */
  function type(ydoc: Y.Doc, ...lines: string[]) {
    ydoc.transact(() => {
      for (const line of lines) {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText(line)]);
        ydoc.getXmlFragment(CONTENT_FIELD).push([p]);
      }
    });
  }

  it('joins by title, hears what the human wrote, and replies with a visible caret', async () => {
    const { human, bot, title, agent } = await setup();
    const browser = connectHuman(human, (await setupDocId(title, human)));
    await until(() => browser.sync.state === 'synced');
    type(browser.ydoc, '最初のメモ');
    await until(() => browser.sync.state === 'synced');

    const joined = await agent.join(title);
    expect(joined).toMatchObject({ title, role: 'editor', text: '最初のメモ' });
    await until(() => browser.state.participants.some((p) => p.userId === bot.id));

    // Text that existed before joining is context, not a message.
    expect(await agent.waitForMessage(400)).toBeNull();

    type(browser.ydoc, 'こんにちは、Claude', '要件を一緒に考えて');
    expect(await agent.waitForMessage(5_000)).toBe('こんにちは、Claude\n要件を一緒に考えて');

    await agent.write('はい、喜んで。\nまず目的を教えてください。');
    await until(() => readBlocks(browser.ydoc).some((b) => b.fromAgent));
    const reply = readBlocks(browser.ydoc).find((b) => b.fromAgent)!;
    expect(reply.text).toBe('はい、喜んで。\nまず目的を教えてください。');

    // The caret: an awareness state with a y-prosemirror cursor, labelled by the server with the bot's name.
    await until(() => [...browser.awareness.getStates().values()].some((s) => s.cursor && s.user?.userId === bot.id));
    const caret = [...browser.awareness.getStates().values()].find((s) => s.user?.userId === bot.id)!;
    expect(caret.user.name).toBe('Claude');
    const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(caret.cursor.anchor), browser.ydoc);
    expect(anchor?.type).toBeInstanceOf(Y.XmlText);

    // The reply is not reported back as a human message; the next human line is.
    type(browser.ydoc, '目的は社内の議事録共有です');
    expect(await agent.waitForMessage(5_000)).toBe('目的は社内の議事録共有です');

    // Everything the agent wrote is stored on the server like any edit.
    const stored = await prisma.documentUpdate.count({ where: { userId: bot.id } });
    expect(stored).toBeGreaterThan(0);
  });

  it('waits until the human stops typing before answering', async () => {
    const { human, title, agent } = await setup();
    const browser = connectHuman(human, await setupDocId(title, human));
    await until(() => browser.sync.state === 'synced');
    await agent.join(title);

    const waiting = agent.waitForMessage(5_000, 400);
    type(browser.ydoc, '書きかけ');
    await new Promise((r) => setTimeout(r, 200));
    type(browser.ydoc, '続き');
    const started = Date.now();
    expect(await waiting).toBe('書きかけ\n続き');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('a viewer agent can read but not write; unknown documents are reported with the choices', async () => {
    const { title, agent } = await setup('viewer');
    await agent.join(title);
    await expect(agent.write('こんにちは')).rejects.toThrow(AgentError);
    await expect(agent.join('存在しない文書')).rejects.toThrow(/見つかりません/);
  });

  it('wrong credentials give a clear error', async () => {
    const agent = new ConvergeAgent({ apiBase: base, email: 'nobody@example.test', password: 'wrong password!' });
    await expect(agent.listDocuments()).rejects.toThrow(/ログインに失敗/);
  });

  it('exposes the conversation loop as MCP tools', async () => {
    const { human, title, agent } = await setup();
    const browser = connectHuman(human, await setupDocId(title, human));
    await until(() => browser.sync.state === 'synced');

    const server = buildMcpServer(agent);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    cleanups.push(() => void client.close());

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['join_document', 'leave_document', 'list_documents', 'read_document', 'wait_for_message', 'write_reply']);

    const textOf = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>)[0]!.text;
    expect(textOf(await client.callTool({ name: 'list_documents', arguments: {} }))).toContain(title);
    expect(textOf(await client.callTool({ name: 'join_document', arguments: { document: title } }))).toContain('参加しました');

    type(browser.ydoc, 'MCP 経由でも届く？');
    const waited = await client.callTool({ name: 'wait_for_message', arguments: { timeout_seconds: 5 } });
    expect(textOf(waited)).toContain('MCP 経由でも届く？');

    await client.callTool({ name: 'write_reply', arguments: { text: '届いています' } });
    await until(() => readBlocks(browser.ydoc).some((b) => b.fromAgent && b.text === '届いています'));
    expect(textOf(await client.callTool({ name: 'read_document', arguments: {} }))).toContain('Claude> 届いています');

    const bad = await client.callTool({ name: 'join_document', arguments: { document: 'ないよ' } });
    expect(bad.isError).toBe(true);
  });

  async function setupDocId(title: string, owner: TestUser): Promise<string> {
    const list = (await app.inject({ method: 'GET', url: '/api/v1/documents?limit=100', headers: bearer(owner) })).json();
    return (list.items as Array<{ id: string; title: string }>).find((d) => d.title === title)!.id;
  }
});
