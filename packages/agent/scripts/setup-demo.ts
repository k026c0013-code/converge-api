/**
 * Prepares the "talk with an AI agent in Converge" demo (ADR-0015 §5) against a running Converge.
 *
 *   pnpm --filter @converge/agent setup-demo [--url http://localhost:8080] [--name デモユーザー] [--agent-name Claude]
 *
 * Creates (or reuses) two accounts — the agent and a human demo user — and a document shared between them,
 * then writes everything to packages/agent/.env (git-ignored), which the MCP server reads.
 * Passwords are generated locally and never printed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.CONVERGE_URL ?? 'http://localhost:8080' },
    name: { type: 'string', default: 'デモユーザー' },
    'agent-name': { type: 'string', default: 'Claude' },
    title: { type: 'string', default: 'Claude と話そう' },
  },
});
const base = values.url!;
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

const existing: Record<string, string> = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) existing[m[1]!] = m[2]!;
  }
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** Logs in with saved credentials, or registers a new account. Returns the access token. */
async function account(prefix: string, emailDefault: string, displayName: string): Promise<{ email: string; password: string; token: string }> {
  const email = existing[`${prefix}_EMAIL`] ?? emailDefault;
  const saved = existing[`${prefix}_PASSWORD`];
  if (saved) {
    const r = await call('POST', '/api/v1/auth/login', { email, password: saved });
    if (r.status === 200) return { email, password: saved, token: r.body.tokens.accessToken };
  }
  const password = randomBytes(18).toString('base64url');
  const r = await call('POST', '/api/v1/auth/register', { email, password, displayName });
  if (r.status === 409) throw new Error(`${email} は登録済みですが、パスワードが ${envPath} にありません。別の --url の環境か、DB を作り直してください`);
  if (r.status !== 201) throw new Error(`アカウント作成に失敗しました（HTTP ${r.status}: ${JSON.stringify(r.body)}）`);
  return { email, password, token: r.body.tokens.accessToken };
}

const health = await fetch(`${base}/api/v1/health`).catch(() => null);
if (!health?.ok) {
  console.error(`${base} の Converge に接続できません。先に docker compose --profile full up -d を実行してください`);
  process.exit(1);
}

const agent = await account('CONVERGE', 'claude-agent@converge.test', values['agent-name']!);
const human = await account('DEMO_USER', 'demo-user@converge.test', values.name!);

// The shared document: reuse one with the same title, otherwise create it.
const list = await call('GET', '/api/v1/documents?limit=100', undefined, human.token);
let doc = (list.body.items as Array<{ id: string; title: string }>).find((d) => d.title === values.title);
if (!doc) doc = (await call('POST', '/api/v1/documents', { title: values.title }, human.token)).body;
const add = await call('POST', `/api/v1/documents/${doc!.id}/members`, { email: agent.email, role: 'editor' }, human.token);
if (add.status !== 201 && add.status !== 409) throw new Error(`メンバー追加に失敗しました（HTTP ${add.status}）`);

writeFileSync(
  envPath,
  [
    '# Written by `pnpm --filter @converge/agent setup-demo`. Local demo accounts only; do not commit.',
    `CONVERGE_URL=${base}`,
    `CONVERGE_EMAIL=${agent.email}`,
    `CONVERGE_PASSWORD=${agent.password}`,
    '# Sign in to the web app with this account:',
    `DEMO_USER_EMAIL=${human.email}`,
    `DEMO_USER_PASSWORD=${human.password}`,
    `DEMO_DOCUMENT=${values.title}`,
    '',
  ].join('\n'),
);

console.log(`準備できました（${base}）。`);
console.log(`- AI エージェント: ${agent.email}（表示名「${values['agent-name']}」）`);
console.log(`- デモ用の人間アカウント: ${human.email}（パスワードは ${envPath}）`);
console.log(`- 共有文書: 「${values.title}」`);
