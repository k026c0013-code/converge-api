import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { bearer, type TestUser } from './helpers.js';

export interface Msg {
  type: string;
  [k: string]: unknown;
}

/** A test WebSocket client that buffers incoming JSON messages. */
export class Client {
  readonly messages: Msg[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Msg);
      for (const w of this.waiters.splice(0)) w();
    });
    this.opened = new Promise((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  }

  /** Waits for the next message of `type` that has not been taken yet, and removes it from the buffer. */
  async next(type: string, timeoutMs = 2_000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.messages.findIndex((m) => m.type === type);
      if (i >= 0) return this.messages.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}; have ${JSON.stringify(this.messages.map((m) => m.type))}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Asserts that no message of `type` arrives within `ms`. */
  async none(type: string, ms = 150): Promise<boolean> {
    await new Promise((r) => setTimeout(r, ms));
    return !this.messages.some((m) => m.type === type);
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

export function wsBase(app: FastifyInstance): string {
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('server is not listening');
  return `ws://127.0.0.1:${addr.port}`;
}

export async function issueTicket(app: FastifyInstance, user: TestUser, documentId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/v1/documents/${documentId}/ws-ticket`, headers: bearer(user) });
  if (res.statusCode !== 201) throw new Error(`ticket: ${res.statusCode} ${res.body}`);
  return res.json().ticket as string;
}

export function rawConnect(app: FastifyInstance, path: string, opts: { origin?: string; autoPong?: boolean } = {}): Client {
  return new Client(
    new WebSocket(`${wsBase(app)}${path}`, {
      headers: opts.origin ? { origin: opts.origin } : {},
      autoPong: opts.autoPong ?? true,
    }),
  );
}

/** Issues a ticket, connects, and waits for session:ready. */
export async function join(
  app: FastifyInstance,
  user: TestUser,
  documentId: string,
  opts: { origin?: string; autoPong?: boolean } = {},
): Promise<{ client: Client; ready: Msg }> {
  const ticket = await issueTicket(app, user, documentId);
  const client = rawConnect(app, `/ws/documents/${documentId}?ticket=${encodeURIComponent(ticket)}`, opts);
  await client.opened;
  const ready = await client.next('session:ready');
  return { client, ready };
}

/** Resolves with the HTTP status the handshake was rejected with. */
export function expectRejected(client: Client): Promise<number> {
  return client.opened.then(
    () => {
      throw new Error('handshake unexpectedly succeeded');
    },
    (err: Error) => Number(/HTTP (\d+)/.exec(err.message)?.[1] ?? 0),
  );
}

export const b64 = (s: string) => Buffer.from(s).toString('base64');
