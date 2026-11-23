/**
 * @converge/client — browser/Node client for the Converge realtime endpoint (ADR-0007, ADR-0009).
 * Phase 2: tickets, presence, opaque update relay and automatic reconnection.
 * Phase 3 layers Yjs sync on top of this.
 */

export type Role = 'owner' | 'editor' | 'viewer';

export interface Participant {
  sessionId: string;
  userId: string;
  displayName: string;
  role: Role;
}

export interface RemoteUpdate {
  updateId: string;
  payload: Uint8Array;
  from: { sessionId: string; userId: string };
}

export type Status = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ServerError {
  code: string;
  message: string;
  ref?: string;
}

/** Why the connection stopped for good (no more reconnection attempts). */
export type StopReason =
  | 'closed_by_client'
  | 'signed_out' // 4001
  | 'access_revoked' // 4003, or 404 on ticket
  | 'document_deleted' // 4004
  | 'unauthorized' // 401 on ticket
  | 'policy_violation'; // 1008 / 1009

export interface ConvergeEvents {
  status: (status: Status) => void;
  ready: (info: { sessionId: string; userId: string; role: Role }) => void;
  participants: (participants: Participant[]) => void;
  update: (update: RemoteUpdate) => void;
  roleChanged: (role: Role) => void;
  serverError: (error: ServerError) => void;
  stopped: (reason: StopReason) => void;
}

type WebSocketCtor = new (url: string) => WebSocket;

export interface ConnectionOptions {
  documentId: string;
  /** Returns a valid access token (the caller handles refresh). */
  getAccessToken: () => Promise<string>;
  /** Origin of the REST API, e.g. "http://127.0.0.1:3000". Empty string = same origin. */
  apiBase?: string;
  /** Origin for WebSockets, e.g. "ws://127.0.0.1:3000". Derived from apiBase / location when omitted. */
  wsBase?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  backoff?: { initialMs?: number; maxMs?: number };
  random?: () => number;
}

const TERMINAL_CLOSE: Record<number, StopReason> = {
  4001: 'signed_out',
  4003: 'access_revoked',
  4004: 'document_deleted',
  1008: 'policy_violation',
  1009: 'policy_violation',
};
const RECONNECT_NOW = 4008; // max lifetime reached

class StopError extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function deriveWsBase(apiBase: string): string {
  if (apiBase) return apiBase.replace(/^http/, 'ws');
  const loc = (globalThis as { location?: Location }).location;
  if (!loc) throw new Error('wsBase is required outside the browser');
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}`;
}

export class ConvergeConnection {
  private readonly listeners: { [K in keyof ConvergeEvents]: Set<ConvergeEvents[K]> } = {
    status: new Set(),
    ready: new Set(),
    participants: new Set(),
    update: new Set(),
    roleChanged: new Set(),
    serverError: new Set(),
    stopped: new Set(),
  };
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private _status: Status = 'idle';
  private _participants = new Map<string, Participant>();
  private _sessionId: string | null = null;
  private _role: Role | null = null;

  private readonly apiBase: string;
  private readonly wsBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: WebSocketCtor;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;

  constructor(private readonly opts: ConnectionOptions) {
    this.apiBase = opts.apiBase ?? '';
    this.wsBase = opts.wsBase ?? deriveWsBase(this.apiBase);
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.WS = opts.WebSocket ?? (globalThis.WebSocket as WebSocketCtor);
    this.initialMs = opts.backoff?.initialMs ?? 500;
    this.maxMs = opts.backoff?.maxMs ?? 10_000;
    this.random = opts.random ?? Math.random;
  }

  get status(): Status {
    return this._status;
  }
  get participants(): Participant[] {
    return [...this._participants.values()];
  }
  get sessionId(): string | null {
    return this._sessionId;
  }
  get role(): Role | null {
    return this._role;
  }

  on<K extends keyof ConvergeEvents>(event: K, fn: ConvergeEvents[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  connect(): void {
    if (this.stopped || this._status === 'connecting' || this._status === 'open') return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    void this.open();
  }

  /** Sends an opaque update. Returns its updateId, or null when not connected. */
  sendUpdate(payload: Uint8Array): string | null {
    if (this._status !== 'open' || !this.socket) return null;
    const updateId = crypto.randomUUID();
    this.socket.send(JSON.stringify({ type: 'update:submit', updateId, payload: toBase64(payload) }));
    return updateId;
  }

  close(): void {
    this.stop('closed_by_client');
  }

  private async open(): Promise<void> {
    let ticket: string;
    try {
      ticket = await this.fetchTicket();
    } catch (err) {
      if (err instanceof StopError) this.stop(err.reason);
      else this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const url = `${this.wsBase}/ws/documents/${encodeURIComponent(this.opts.documentId)}?ticket=${encodeURIComponent(ticket)}`;
    const ws = new this.WS(url);
    this.socket = ws;
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this._participants.clear();
      this.emit('participants', []);
      if (this.stopped) return;
      const terminal = TERMINAL_CLOSE[ev.code];
      if (terminal) this.stop(terminal);
      else this.scheduleReconnect(ev.code === RECONNECT_NOW ? 0 : undefined);
    };
  }

  private async fetchTicket(): Promise<string> {
    const token = await this.opts.getAccessToken();
    const res = await this.fetchImpl(
      `${this.apiBase}/api/v1/documents/${encodeURIComponent(this.opts.documentId)}/ws-ticket`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (res.status === 401) throw new StopError('unauthorized');
    if (res.status === 404 || res.status === 403) throw new StopError('access_revoked');
    if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
    const body = (await res.json()) as { ticket: string };
    return body.ticket;
  }

  private onMessage(raw: string): void {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'session:ready': {
        this.attempt = 0;
        this._sessionId = msg.sessionId as string;
        this._role = msg.role as Role;
        this._participants = new Map((msg.participants as Participant[]).map((p) => [p.sessionId, p]));
        this.setStatus('open');
        this.emit('ready', { sessionId: this._sessionId, userId: msg.userId as string, role: this._role });
        this.emit('participants', this.participants);
        break;
      }
      case 'document:user_joined': {
        const p = msg.participant as Participant;
        this._participants.set(p.sessionId, p);
        this.emit('participants', this.participants);
        break;
      }
      case 'document:user_left': {
        this._participants.delete((msg.participant as Participant).sessionId);
        this.emit('participants', this.participants);
        break;
      }
      case 'update:broadcast':
        this.emit('update', {
          updateId: msg.updateId as string,
          payload: fromBase64(msg.payload as string),
          from: msg.from as RemoteUpdate['from'],
        });
        break;
      case 'session:role_changed': {
        this._role = msg.role as Role;
        const mine = this._sessionId ? this._participants.get(this._sessionId) : undefined;
        if (mine) mine.role = this._role;
        this.emit('roleChanged', this._role);
        this.emit('participants', this.participants);
        break;
      }
      case 'error':
        this.emit('serverError', { code: msg.code as string, message: msg.message as string, ref: msg.ref as string | undefined });
        break;
    }
  }

  /** Exponential backoff with full jitter. */
  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    const cap = Math.min(this.maxMs, this.initialMs * 2 ** this.attempt);
    const delay = delayMs ?? Math.floor(this.random() * cap);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, delay);
  }

  private stop(reason: StopReason): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.socket;
    this.socket = null;
    ws?.close(1000);
    this._participants.clear();
    this.setStatus('closed');
    this.emit('stopped', reason);
  }

  private setStatus(s: Status): void {
    if (this._status === s) return;
    this._status = s;
    this.emit('status', s);
  }

  private emit<K extends keyof ConvergeEvents>(event: K, ...args: Parameters<ConvergeEvents[K]>): void {
    for (const fn of this.listeners[event]) (fn as (...a: Parameters<ConvergeEvents[K]>) => void)(...args);
  }
}
