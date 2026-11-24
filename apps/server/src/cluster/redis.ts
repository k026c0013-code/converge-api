import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { generateRefreshToken, hashToken } from '../auth/tokens.js';
import type { TicketClaims, TicketStore } from '../collab/tickets.js';
import type { Participant } from '../collab/protocol.js';
import type { AccessMessage, Cluster, DocMessage } from './cluster.js';

const DOC_CHANNEL = 'converge:docs';
const ACCESS_CHANNEL = 'converge:access';
const nodeKey = (id: string) => `converge:node:${id}`;
const presenceKey = (documentId: string) => `converge:presence:${documentId}`;
const ticketKey = (hash: string) => `converge:ticket:${hash}`;

export interface RedisClusterOptions {
  /** How often this node refreshes its liveness key. */
  heartbeatMs?: number;
  /** A node is considered dead when its key is older than this. */
  nodeTtlMs?: number;
}

interface Envelope<T> {
  node: string;
  documentId?: string;
  msg: T;
}

/**
 * Redis-backed cluster (ADR-0013): Pub/Sub for documents and access changes,
 * hashes for presence, TTL keys for node liveness.
 */
export class RedisCluster implements Cluster {
  readonly nodeId = randomUUID();
  readonly distributed = true;
  private readonly cmd: Redis;
  private readonly sub: Redis;
  private readonly docHandlers: Array<(documentId: string, msg: DocMessage) => void> = [];
  private readonly accessHandlers: Array<(msg: AccessMessage) => void> = [];
  private readonly reconnectHandlers: Array<() => void> = [];
  private readonly heartbeat: NodeJS.Timeout;
  private readonly nodeTtlMs: number;
  private subscribedOnce = false;

  private constructor(url: string, opts: RedisClusterOptions) {
    this.nodeTtlMs = opts.nodeTtlMs ?? 15_000;
    this.cmd = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.sub = new Redis(url, { lazyConnect: true });
    this.sub.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
    // ioredis resubscribes automatically after a reconnect; messages sent meanwhile are lost → catch up.
    this.sub.on('ready', () => {
      if (this.subscribedOnce) for (const fn of this.reconnectHandlers) fn();
      this.subscribedOnce = true;
    });
    // Connection errors are retried by ioredis; swallowing the event keeps them from crashing the process.
    this.cmd.on('error', () => {});
    this.sub.on('error', () => {});
    this.heartbeat = setInterval(() => void this.beat(), opts.heartbeatMs ?? 5_000);
    this.heartbeat.unref();
  }

  static async connect(url: string, opts: RedisClusterOptions = {}): Promise<RedisCluster> {
    const c = new RedisCluster(url, opts);
    await Promise.all([c.cmd.connect(), c.sub.connect()]);
    await c.sub.subscribe(DOC_CHANNEL, ACCESS_CHANNEL);
    await c.beat();
    return c;
  }

  /** The command connection, for stores that share it (tickets). */
  get redis(): Redis {
    return this.cmd;
  }

  publishDoc(documentId: string, msg: DocMessage): void {
    void this.cmd.publish(DOC_CHANNEL, JSON.stringify({ node: this.nodeId, documentId, msg } satisfies Envelope<DocMessage>)).catch(() => {});
  }

  onDoc(fn: (documentId: string, msg: DocMessage) => void): void {
    this.docHandlers.push(fn);
  }

  publishAccess(msg: AccessMessage): void {
    void this.cmd.publish(ACCESS_CHANNEL, JSON.stringify({ node: this.nodeId, msg } satisfies Envelope<AccessMessage>)).catch(() => {});
  }

  onAccess(fn: (msg: AccessMessage) => void): void {
    this.accessHandlers.push(fn);
  }

  onReconnect(fn: () => void): void {
    this.reconnectHandlers.push(fn);
  }

  async presenceAdd(documentId: string, participant: Participant): Promise<void> {
    await this.cmd.hset(presenceKey(documentId), participant.sessionId, JSON.stringify({ node: this.nodeId, participant }));
  }

  async presenceRemove(documentId: string, sessionId: string): Promise<void> {
    await this.cmd.hdel(presenceKey(documentId), sessionId);
  }

  async presenceRemote(documentId: string): Promise<{ alive: Participant[]; dead: Participant[] }> {
    const all = await this.cmd.hgetall(presenceKey(documentId));
    const entries = Object.values(all).map((v) => JSON.parse(v) as { node: string; participant: Participant });
    const others = entries.filter((e) => e.node !== this.nodeId);
    const nodes = [...new Set(others.map((e) => e.node))];
    const liveness = nodes.length ? await this.cmd.mget(nodes.map(nodeKey)) : [];
    const aliveNodes = new Set(nodes.filter((_, i) => liveness[i] !== null));
    const alive: Participant[] = [];
    const dead: Participant[] = [];
    for (const e of others) (aliveNodes.has(e.node) ? alive : dead).push(e.participant);
    if (dead.length) await this.cmd.hdel(presenceKey(documentId), ...dead.map((p) => p.sessionId));
    return { alive, dead };
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.cmd.del(nodeKey(this.nodeId)).catch(() => {});
    this.sub.disconnect();
    this.cmd.disconnect();
  }

  /** Simulates a crash in tests: stop heartbeating and drop connections without cleanup. */
  crash(): void {
    clearInterval(this.heartbeat);
    this.sub.disconnect();
    this.cmd.disconnect();
  }

  private async beat(): Promise<void> {
    await this.cmd.set(nodeKey(this.nodeId), '1', 'PX', this.nodeTtlMs).catch(() => {});
  }

  private dispatch(channel: string, raw: string): void {
    let env: Envelope<unknown>;
    try {
      env = JSON.parse(raw) as Envelope<unknown>;
    } catch {
      return;
    }
    if (env.node === this.nodeId) return; // our own message: already handled locally
    if (channel === DOC_CHANNEL && env.documentId) {
      for (const fn of this.docHandlers) fn(env.documentId, env.msg as DocMessage);
    } else if (channel === ACCESS_CHANNEL) {
      for (const fn of this.accessHandlers) fn(env.msg as AccessMessage);
    }
  }
}

/** Tickets shared by every node: SET … PX on issue, GETDEL on consume (ADR-0005, ADR-0013). */
export class RedisTicketStore implements TicketStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs = 30_000,
  ) {}

  async issue(claims: TicketClaims) {
    const ticket = generateRefreshToken();
    await this.redis.set(ticketKey(hashToken(ticket)), JSON.stringify(claims), 'PX', this.ttlMs);
    return { ticket, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  async consume(ticket: string) {
    const raw = await this.redis.getdel(ticketKey(hashToken(ticket)));
    return raw ? (JSON.parse(raw) as TicketClaims) : null;
  }
}
