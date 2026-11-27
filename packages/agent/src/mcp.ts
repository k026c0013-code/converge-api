/**
 * Entry point: `tsx packages/agent/src/mcp.ts` — an MCP server over stdio (ADR-0015).
 *
 * Settings come from the environment, or from packages/agent/.env (written by `pnpm setup-demo`):
 *   CONVERGE_URL       web app / API origin (default http://localhost:8080)
 *   CONVERGE_EMAIL     the agent's account
 *   CONVERGE_PASSWORD
 * stdout carries the MCP protocol, so all logging goes to stderr.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConvergeAgent } from './agent.js';
import { buildMcpServer } from './mcp-server.js';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const email = process.env.CONVERGE_EMAIL;
const password = process.env.CONVERGE_PASSWORD;
if (!email || !password) {
  console.error('[converge-agent] CONVERGE_EMAIL と CONVERGE_PASSWORD を設定してください（pnpm --filter @converge/agent setup-demo で作れます）');
  process.exit(1);
}

const agent = new ConvergeAgent({ apiBase: process.env.CONVERGE_URL ?? 'http://localhost:8080', email, password });
const server = buildMcpServer(agent);

const shutdown = () => {
  agent.leave();
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error('[converge-agent] ready');
