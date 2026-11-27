import { ConvergeConnection, REMOTE, YjsSync, type Role, type StopReason } from '@converge/client';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { addReplyParagraph, humanBlocks, newHumanText, startReply, readBlocks, renderDocument, typingPlan } from './text.js';

/**
 * A Converge participant driven by an AI agent (ADR-0015).
 * It signs in like any user, joins a document over the normal WebSocket protocol, waits for people to
 * write, and types its replies into the document with a visible caret.
 */

export interface AgentOptions {
  /** Origin of the web app or API, e.g. "http://localhost:8080". */
  apiBase: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => WebSocket;
  /** Typing animation: delay between chunks and the maximum number of chunks per reply. */
  typing?: { intervalMs?: number; maxSteps?: number };
  /** How long people must stop editing before their text counts as a finished message. */
  idleMs?: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  myRole: Role;
}

export class AgentError extends Error {}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Session {
  documentId: string;
  title: string;
  doc: Y.Doc;
  awareness: Awareness;
  conn: ConvergeConnection;
  sync: YjsSync;
  /** People's blocks already reported to the agent. */
  baseline: string[];
  lastRemoteChangeAt: number;
  stopped: StopReason | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConvergeAgent {
  private tokens: Tokens | null = null;
  private session: Session | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly maxSteps: number;
  private readonly idleMs: number;

  constructor(private readonly opts: AgentOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.intervalMs = opts.typing?.intervalMs ?? 150;
    this.maxSteps = opts.typing?.maxSteps ?? 80;
    this.idleMs = opts.idleMs ?? 2_500;
  }

  get joined(): { documentId: string; title: string } | null {
    return this.session ? { documentId: this.session.documentId, title: this.session.title } : null;
  }

  // ---- REST -----------------------------------------------------------------

  private async post<T>(path: string, body: unknown, token?: string): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`${this.opts.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  }

  private setTokens(t: { accessToken: string; refreshToken: string; expiresIn: number }): void {
    this.tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 };
  }

  async login(): Promise<void> {
    type R = { tokens: { accessToken: string; refreshToken: string; expiresIn: number } };
    const res = await this.post<R>('/api/v1/auth/login', { email: this.opts.email, password: this.opts.password });
    if (res.status !== 200) throw new AgentError(`ログインに失敗しました（HTTP ${res.status}）。CONVERGE_EMAIL / CONVERGE_PASSWORD を確認してください`);
    this.setTokens(res.body.tokens);
  }

  /** A valid access token: refreshed shortly before expiry, or a fresh login if the refresh fails. */
  async accessToken(): Promise<string> {
    if (!this.tokens) await this.login();
    if (this.tokens!.expiresAt - Date.now() < 60_000) {
      type R = { accessToken: string; refreshToken: string; expiresIn: number };
      const res = await this.post<R>('/api/v1/auth/refresh', { refreshToken: this.tokens!.refreshToken });
      if (res.status === 200) this.setTokens(res.body);
      else await this.login();
    }
    return this.tokens!.accessToken;
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const res = await this.fetchImpl(`${this.opts.apiBase}/api/v1/documents?limit=100`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok) throw new AgentError(`文書一覧を取得できませんでした（HTTP ${res.status}）`);
    const body = (await res.json()) as { items: DocumentSummary[] };
    return body.items.map(({ id, title, myRole }) => ({ id, title, myRole }));
  }

  // ---- realtime ---------------------------------------------------------------

  /** Joins a document by id or exact title and waits for the first full sync. */
  async join(idOrTitle: string, timeoutMs = 10_000): Promise<{ title: string; role: Role; text: string }> {
    const docs = await this.listDocuments();
    const target = docs.find((d) => d.id === idOrTitle) ?? docs.find((d) => d.title === idOrTitle);
    if (!target) {
      const names = docs.map((d) => `「${d.title}」`).join('、') || '（なし）';
      throw new AgentError(`文書「${idOrTitle}」が見つかりません。参加できる文書: ${names}`);
    }
    this.leave();

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const conn = new ConvergeConnection({
      documentId: target.id,
      apiBase: this.opts.apiBase,
      getAccessToken: () => this.accessToken(),
      fetch: this.fetchImpl,
      ...(this.opts.WebSocket ? { WebSocket: this.opts.WebSocket } : {}),
    });
    const sync = new YjsSync(conn, doc, awareness);
    const session: Session = {
      documentId: target.id,
      title: target.title,
      doc,
      awareness,
      conn,
      sync,
      baseline: [],
      lastRemoteChangeAt: 0,
      stopped: null,
    };
    doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) session.lastRemoteChangeAt = Date.now();
    });
    conn.on('stopped', (reason) => (session.stopped = reason));
    this.session = session;
    conn.connect();

    const end = Date.now() + timeoutMs;
    while (sync.state !== 'synced') {
      if (session.stopped) throw new AgentError(`接続が切れました: ${session.stopped}`);
      if (Date.now() > end) {
        this.leave();
        throw new AgentError('文書に接続できませんでした（同期がタイムアウトしました）');
      }
      await sleep(50);
    }
    const blocks = readBlocks(doc);
    session.baseline = humanBlocks(blocks);
    return { title: target.title, role: conn.role ?? target.myRole, text: renderDocument(blocks) };
  }

  private requireSession(): Session {
    const s = this.session;
    if (!s) throw new AgentError('まだ文書に参加していません。先に join_document を呼んでください');
    if (s.stopped) throw new AgentError(`文書との接続が終了しました: ${s.stopped}`);
    return s;
  }

  read(): string {
    return renderDocument(readBlocks(this.requireSession().doc));
  }

  /**
   * Resolves with what people wrote since the last call, once they have stopped editing for `idleMs`.
   * Returns null if nothing new arrived within `timeoutMs`.
   */
  async waitForMessage(timeoutMs: number, idleMs = this.idleMs): Promise<string | null> {
    const s = this.requireSession();
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (s.stopped) throw new AgentError(`文書との接続が終了しました: ${s.stopped}`);
      const current = humanBlocks(readBlocks(s.doc));
      const text = newHumanText(s.baseline, current);
      if (text !== '' && Date.now() - s.lastRemoteChangeAt >= idleMs) {
        s.baseline = current;
        this.placeCaretAtEnd(s); // show "Claude is here and reading" while it thinks
        return text;
      }
      if (Date.now() > end) return null;
      await sleep(100);
    }
  }

  /** Types a reply into the document as a quote block, with the caret following the text. */
  async write(reply: string): Promise<void> {
    const s = this.requireSession();
    if (s.conn.role === 'viewer') throw new AgentError('この文書では閲覧者なので書き込めません');
    const plan = typingPlan(reply, this.maxSteps);
    if (plan.length === 0) throw new AgentError('空の返事は書き込めません');

    let quote: Y.XmlElement | null = null;
    for (const chunks of plan) {
      let text: Y.XmlText | null = null;
      for (const chunk of chunks) {
        if (s.stopped) throw new AgentError(`書き込み中に接続が終了しました: ${s.stopped}`);
        if (!quote) ({ quote, text } = startReply(s.doc, chunk));
        else if (!text) text = addReplyParagraph(s.doc, quote, chunk);
        else s.doc.transact(() => text!.insert(text!.length, chunk));
        this.setCaret(s, text!, text!.length);
        await sleep(this.intervalMs);
      }
    }
    // Wait (briefly) until the server has stored everything, so a quick leave() loses nothing.
    const end = Date.now() + 5_000;
    while (s.sync.state !== 'synced' && Date.now() < end && !s.stopped) await sleep(50);
  }

  leave(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.sync.destroy();
    s.conn.close();
    s.awareness.destroy();
    s.doc.destroy();
  }

  // ---- caret (y-prosemirror cursor format: relative positions as JSON) ----------

  private setCaret(s: Session, type: Y.XmlText | Y.XmlElement, index: number): void {
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(type, index));
    s.awareness.setLocalStateField('cursor', { anchor: pos, head: pos });
  }

  private placeCaretAtEnd(s: Session): void {
    const fragment = s.doc.getXmlFragment('content');
    const last = fragment.length > 0 ? fragment.get(fragment.length - 1) : null;
    if (last instanceof Y.XmlElement && last.length > 0) {
      const inner = last.get(last.length - 1);
      if (inner instanceof Y.XmlText) return this.setCaret(s, inner, inner.length);
    }
    if (last instanceof Y.XmlElement) return this.setCaret(s, last, last.length);
  }
}
