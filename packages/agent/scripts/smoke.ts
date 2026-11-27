/**
 * End-to-end smoke test against a running Converge (after `setup-demo`):
 * starts the real MCP server over stdio exactly as .mcp.json does, plays the human through the same
 * client library the web app uses, and checks one conversation round trip.
 *
 *   pnpm --filter @converge/agent exec tsx scripts/smoke.ts
 */
import { ConvergeConnection, YjsSync } from '@converge/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CONTENT_FIELD, readBlocks } from '../src/text.js';

process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const base = process.env.CONVERGE_URL!;
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const step = (s: string) => console.log(`- ${s}`);
const until = async (p: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!p()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

// The human, through the web app's origin (nginx → API ×2).
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.DEMO_USER_EMAIL, password: process.env.DEMO_USER_PASSWORD }),
});
const token = ((await login.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
const docs = (await (await fetch(`${base}/api/v1/documents`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
  items: Array<{ id: string; title: string }>;
};
const target = docs.items.find((d) => d.title === process.env.DEMO_DOCUMENT)!;
const ydoc = new Y.Doc();
const awareness = new Awareness(ydoc);
const conn = new ConvergeConnection({ documentId: target.id, apiBase: base, getAccessToken: async () => token });
const sync = new YjsSync(conn, ydoc, awareness);
conn.connect();
await until(() => sync.state === 'synced');
step(`人間が「${target.title}」に接続`);

// The agent, as Claude Code would start it.
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: ['packages/agent/node_modules/tsx/dist/cli.mjs', 'packages/agent/src/mcp.ts'], cwd: repo, stderr: 'inherit' }),
);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};
step(`MCP ツール: ${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);
step((await call('join_document', { document: target.title })).split('\n')[0]!);
await until(() => conn.participants.some((p) => p.displayName === 'Claude'));
step('参加者一覧に Claude が表示された');

const question = `スモークテスト ${new Date().toISOString()}`;
const waiting = call('wait_for_message', { timeout_seconds: 30 });
ydoc.transact(() => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(question)]);
  ydoc.getXmlFragment(CONTENT_FIELD).push([p]);
});
const heard = await waiting;
if (!heard.includes(question)) throw new Error(`unexpected: ${heard}`);
step('Claude が人間の書き込みを受け取った');

const answer = `受け取りました（${question}）`;
await call('write_reply', { text: answer });
await until(() => readBlocks(ydoc).some((b) => b.fromAgent && b.text === answer));
step('人間の画面に Claude の返事（引用ブロック）が届いた');
const caret = [...awareness.getStates().values()].find((s) => s.user?.name === 'Claude');
if (!caret?.cursor) throw new Error('no caret from Claude');
step(`Claude のカーソルが見えている（色 ${caret.user.color}）`);

await call('leave_document');
await client.close();
sync.destroy();
conn.close();
console.log('OK');
process.exit(0);
