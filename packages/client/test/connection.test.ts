import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvergeConnection, fromBase64, toBase64, type StopReason } from '../src/index.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  closedWith: number | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  // test helpers
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
}

const ready = (participants = [{ sessionId: 's1', userId: 'u1', displayName: 'Me', role: 'editor' }]) => ({
  type: 'session:ready',
  sessionId: 's1',
  userId: 'u1',
  role: 'editor',
  participants,
});

function ticketFetch(statuses: number[] = []) {
  let n = 0;
  return vi.fn(async () => {
    const status = statuses[n++] ?? 201;
    return new Response(status === 201 ? JSON.stringify({ ticket: `t${n}`, expiresIn: 30 }) : '{}', { status });
  });
}

function make(fetchImpl = ticketFetch()) {
  const conn = new ConvergeConnection({
    documentId: 'doc-1',
    getAccessToken: async () => 'jwt',
    apiBase: 'http://api.test',
    fetch: fetchImpl as unknown as typeof fetch,
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
    backoff: { initialMs: 100, maxMs: 1_000 },
    random: () => 1, // deterministic: always the cap
  });
  const stops: StopReason[] = [];
  conn.on('stopped', (r) => stops.push(r));
  return { conn, fetchImpl, stops };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const last = () => FakeSocket.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => vi.useRealTimers());

describe('base64 helpers', () => {
  it('round-trip arbitrary bytes, including large buffers', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });
});

describe('ConvergeConnection', () => {
  it('fetches a ticket with the bearer token and connects to the document URL', async () => {
    const { conn, fetchImpl } = make();
    conn.connect();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/v1/documents/doc-1/ws-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer jwt' },
    });
    expect(last().url).toBe('ws://api.test/ws/documents/doc-1?ticket=t1');
    expect(conn.status).toBe('connecting');
    last().receive(ready());
    expect(conn.status).toBe('open');
    expect(conn.role).toBe('editor');
  });

  it('tracks participants from ready / joined / left', async () => {
    const { conn } = make();
    const seen: number[] = [];
    conn.on('participants', (p) => seen.push(p.length));
    conn.connect();
    await flush();
    last().receive(ready());
    last().receive({ type: 'document:user_joined', participant: { sessionId: 's2', userId: 'u2', displayName: 'B', role: 'viewer' } });
    last().receive({ type: 'document:user_left', participant: { sessionId: 's2', userId: 'u2', displayName: 'B', role: 'viewer' } });
    expect(seen).toEqual([1, 2, 1]);
  });

  it('sends updates as base64 JSON and decodes broadcasts', async () => {
    const { conn } = make();
    expect(conn.sendUpdate(new Uint8Array([1]))).toBeNull(); // not connected yet
    conn.connect();
    await flush();
    last().receive(ready());
    const id = conn.sendUpdate(new Uint8Array([1, 2, 3]));
    expect(JSON.parse(last().sent[0]!)).toEqual({ type: 'update:submit', updateId: id, payload: 'AQID' });

    const got = vi.fn();
    conn.on('update', got);
    last().receive({ type: 'update:broadcast', updateId: 'x', payload: 'AQID', from: { sessionId: 's2', userId: 'u2' } });
    expect(got).toHaveBeenCalledWith({ updateId: 'x', payload: new Uint8Array([1, 2, 3]), from: { sessionId: 's2', userId: 'u2' } });
  });

  it('updates its role on session:role_changed', async () => {
    const { conn } = make();
    conn.connect();
    await flush();
    last().receive(ready());
    last().receive({ type: 'session:role_changed', role: 'viewer' });
    expect(conn.role).toBe('viewer');
    expect(conn.participants[0]?.role).toBe('viewer');
  });

  it('reconnects with a fresh ticket and exponential backoff after an unexpected drop', async () => {
    const { conn, fetchImpl } = make();
    conn.connect();
    await flush();
    last().receive(ready());
    last().drop(1006);
    expect(conn.status).toBe('reconnecting');
    expect(conn.participants).toEqual([]);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // attempt 0: cap 100 ms
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(last().url).toContain('ticket=t2');

    last().drop(1006); // dropped before ready: backoff grows
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // attempt 1: cap 200 ms
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    last().receive(ready()); // success resets the backoff
    last().drop(1001);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('retries ticket requests that fail with 5xx', async () => {
    const { conn, fetchImpl } = make(ticketFetch([503]));
    conn.connect();
    await flush();
    expect(conn.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects immediately when the session hits its max lifetime (4008)', async () => {
    const { conn, fetchImpl } = make();
    conn.connect();
    await flush();
    last().receive(ready());
    last().drop(4008);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [4001, 'signed_out'],
    [4003, 'access_revoked'],
    [4004, 'document_deleted'],
    [1008, 'policy_violation'],
    [1009, 'policy_violation'],
  ] as const)('stops for good on close code %i (%s)', async (code, reason) => {
    const { conn, fetchImpl, stops } = make();
    conn.connect();
    await flush();
    last().receive(ready());
    last().drop(code);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stops).toEqual([reason]);
    expect(conn.status).toBe('closed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'access_revoked'],
  ] as const)('stops when the ticket request returns %i', async (status, reason) => {
    const { conn, stops } = make(ticketFetch([status]));
    conn.connect();
    await flush();
    expect(stops).toEqual([reason]);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('close() stops reconnection and closes the socket normally', async () => {
    const { conn, fetchImpl, stops } = make();
    conn.connect();
    await flush();
    const sock = last();
    sock.receive(ready());
    conn.close();
    expect(sock.closedWith).toBe(1000);
    sock.drop(1000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stops).toEqual(['closed_by_client']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces server errors', async () => {
    const { conn } = make();
    const errs = vi.fn();
    conn.on('serverError', errs);
    conn.connect();
    await flush();
    last().receive({ type: 'error', code: 'FORBIDDEN', message: 'no', ref: 'u' });
    expect(errs).toHaveBeenCalledWith({ code: 'FORBIDDEN', message: 'no', ref: 'u' });
  });
});
