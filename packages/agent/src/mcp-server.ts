import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentError, type ConvergeAgent } from './agent.js';

/** MCP tools that let an AI assistant take part in a Converge document (ADR-0015 §3). */

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AgentError) return failure(err.message);
    return failure(`予期しないエラー: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function buildMcpServer(agent: ConvergeAgent): McpServer {
  const server = new McpServer({ name: 'converge', version: '0.1.0' });

  server.registerTool(
    'list_documents',
    {
      title: '文書の一覧',
      description: 'Converge で参加できる文書（タイトル・ID・自分の権限）を一覧します。',
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const docs = await agent.listDocuments();
        if (docs.length === 0) return text('参加できる文書はありません。人間に、このアカウントを文書のメンバーに追加してもらってください。');
        return text(docs.map((d) => `- ${d.title}（id: ${d.id}、権限: ${d.myRole}）`).join('\n'));
      }),
  );

  server.registerTool(
    'join_document',
    {
      title: '文書に参加',
      description:
        'Converge の文書にリアルタイム参加者として入ります。参加者一覧に表示され、ほかの人と同じ文書を同時に見ます。' +
        '参加後は wait_for_message で人間の書き込みを待ち、write_reply で返事を書く、を繰り返してください。',
      inputSchema: { document: z.string().min(1).describe('文書のタイトル（完全一致）または ID') },
    },
    ({ document }) =>
      guarded(async () => {
        const r = await agent.join(document);
        return text(`「${r.title}」に参加しました（権限: ${r.role}）。\n\n現在の本文:\n${r.text || '（空）'}`);
      }),
  );

  server.registerTool(
    'read_document',
    {
      title: '本文を読む',
      description: '参加中の文書の本文をテキストで返します。あなた（Claude）が書いた返事の行には「Claude> 」が付きます。',
      inputSchema: {},
    },
    () => guarded(async () => text(agent.read() || '（空）')),
  );

  server.registerTool(
    'wait_for_message',
    {
      title: '書き込みを待つ',
      description:
        '人間が文書に新しく書いた内容を待ちます。相手が書き終えて手を止めたら、新しく書かれたテキストを返します。' +
        '時間内に何もなければ「まだありません」と返すので、会話を続ける間は再び呼んでください。',
      inputSchema: {
        timeout_seconds: z.number().int().min(5).max(600).default(120).describe('待つ最大秒数'),
      },
    },
    ({ timeout_seconds }) =>
      guarded(async () => {
        const msg = await agent.waitForMessage(timeout_seconds * 1000);
        return text(msg === null ? 'まだ新しい書き込みはありません。会話を続けるなら、もう一度 wait_for_message を呼んでください。' : `新しい書き込み:\n${msg}`);
      }),
  );

  server.registerTool(
    'write_reply',
    {
      title: '返事を書く',
      description:
        '文書の末尾に返事を書き込みます。返事は引用ブロックとして、カーソルが動きながら少しずつ表示されます。' +
        'Markdown は使わず、普通の文章で書いてください（改行で段落が分かれます）。書き終えたら wait_for_message に戻ってください。',
      inputSchema: { text: z.string().min(1).max(4000).describe('返事の本文') },
    },
    ({ text: reply }) =>
      guarded(async () => {
        await agent.write(reply);
        return text('書き込みました。');
      }),
  );

  server.registerTool(
    'leave_document',
    {
      title: '退出',
      description: '参加中の文書から退出します。',
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        agent.leave();
        return text('退出しました。');
      }),
  );

  return server;
}
