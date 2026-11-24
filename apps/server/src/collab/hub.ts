import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { LocalCluster, type Cluster, type DocMessage } from '../cluster/cluster.js';
import { NO_TIMING, type StageTimer } from './timing.js';
import { MAX_AWARENESS_BYTES, decodeAwareness, encodeAwareness, sanitizeAwareness } from '../crdt/awareness.js';
import { engineFor } from '../crdt/engine.js';
import type { AccessEvents } from '../events.js';
import type { LiveDocuments } from './documents.js';
import { CloseCode, parseClientMessage, type ClientMessage, type Participant, type ServerMessage, type SessionRole } from './protocol.js';

export interface HubLimits {
  heartbeatMs: number;
  maxLifetimeMs: number;
  /** Messages allowed per rate window before the socket is closed with 1008. */
  maxMessagesPerWindow: number;
  rateWindowMs: number;
  /** Invalid messages tolerated before the socket is closed with 1008. */
  maxViolations: number;
  /** A peer that stops reading is dropped once this much is queued for it. */
  maxBufferedBytes: number;
  /** Multi-node only: how often to catch up from the DB and prune dead nodes' presence (ADR-0013 §3). */
  sweepMs: number;
}

export const DEFAULT_HUB_LIMITS: HubLimits = {
  heartbeatMs: 30_000,
  maxLifetimeMs: 12 * 60 * 60 * 1000,
  maxMessagesPerWindow: 200,
  rateWindowMs: 10_000,
  maxViolations: 10,
  maxBufferedBytes: 16 * 1024 * 1024,
  sweepMs: 5_000,
};

export interface SessionInit {
  documentId: string;
  engine: string;
  userId: string;
  displayName: string;
  role: SessionRole;
  familyId: string;
}

interface Session extends SessionInit {
  id: string;
  socket: WebSocket;
  alive: boolean;
  violations: number;
  windowStart: number;
  windowCount: number;
  lifetimeTimer: NodeJS.Timeout;
  /** The single awareness clientID this session may speak for (ADR-0010 §5). */
  awarenessClientId: number | null;
  awarenessClock: number;
  /** Last forwarded awareness update, replayed to sessions that join later. */
  lastAwareness: string | null;
}

const participantOf = (s: Session): Participant => ({
  sessionId: s.id,
  userId: s.userId,
  displayName: s.displayName,
  role: s.role,
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/**
 * Realtime hub (ADR-0009, ADR-0010, ADR-0013): presence, Yjs sync, persisted updates with ACK,
 * awareness — and, through a Cluster, the same for sessions on other nodes.
 */
export class CollabHub {
  private readonly docs = new Map<string, Map<string, Session>>();
  /** Awareness of sessions on other nodes, replayed to local joiners. documentId → sessionId → payload. */
  private readonly remoteAwareness = new Map<string, Map<string, string>>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout | null;
  private readonly unsubscribe: () => void;

  constructor(
    events: AccessEvents,
    private readonly live: LiveDocuments,
    private readonly limits: HubLimits = DEFAULT_HUB_LIMITS,
    private readonly onError: (err: unknown, context: string) => void = () => {},
    private readonly cluster: Cluster = new LocalCluster(),
    private readonly timing: StageTimer = NO_TIMING,
  ) {
    this.heartbeat = setInterval(() => this.checkHeartbeats(), limits.heartbeatMs);
    this.heartbeat.unref();
    if (timing.enabled) {
      const tick = setInterval(() => {
        const now = performance.now();
        this.lag = Math.max(0, now - this.lastTick - 50);
        this.timing.record('loop_tick_lag', this.lag);
        this.lastTick = now;
      }, 50);
      tick.unref();
    }
    if (cluster.distributed) {
      this.sweeper = setInterval(() => void this.sweepAll(), limits.sweepMs);
      this.sweeper.unref();
      cluster.onDoc((documentId, msg) => this.onRemote(documentId, msg));
      cluster.onReconnect(() => void this.sweepAll());
    } else {
      this.sweeper = null;
    }

    const onRole = (e: { documentId: string; userId: string; role: SessionRole }) => {
      for (const s of this.sessionsOf(e.documentId)) {
        if (s.userId !== e.userId || s.role === e.role) continue;
        s.role = e.role;
        this.send(s, { type: 'session:role_changed', role: e.role });
      }
    };
    const onRemoved = (e: { documentId: string; userId: string }) => {
      for (const s of this.sessionsOf(e.documentId)) {
        if (s.userId === e.userId) s.socket.close(CloseCode.accessRevoked, 'access revoked');
      }
    };
    const onDeleted = (e: { documentId: string }) => {
      for (const s of this.sessionsOf(e.documentId)) s.socket.close(CloseCode.documentDeleted, 'document deleted');
    };
    const onFamily = (e: { familyId: string }) => {
      for (const sessions of this.docs.values()) {
        for (const s of sessions.values()) {
          if (s.familyId === e.familyId) s.socket.close(CloseCode.tokenRevoked, 'signed out');
        }
      }
    };
    // Server-made edits (restore) go to everyone connected, here and on other nodes.
    const offServerUpdate = live.onServerUpdate((u) => {
      const payload = b64(u.update);
      const from = { sessionId: 'server', userId: u.userId };
      this.deliver(u.documentId, { type: 'update:broadcast', updateId: u.updateId, payload, from });
      cluster.publishDoc(u.documentId, { kind: 'update', updateId: u.updateId, payload, from, dbId: u.dbId.toString() });
    });
    events.on('memberRoleChanged', onRole);
    events.on('memberRemoved', onRemoved);
    events.on('documentDeleted', onDeleted);
    events.on('tokenFamilyRevoked', onFamily);
    this.unsubscribe = () => {
      offServerUpdate();
      events.off('memberRoleChanged', onRole);
      events.off('memberRemoved', onRemoved);
      events.off('documentDeleted', onDeleted);
      events.off('tokenFamilyRevoked', onFamily);
    };
  }

  /**
   * Registers an upgraded socket. The caller must already hold a LiveDocuments reference
   * for init.documentId; the hub releases it when the socket closes.
   */
  attach(socket: WebSocket, init: SessionInit): void {
    const session: Session = {
      ...init,
      id: randomUUID(),
      socket,
      alive: true,
      violations: 0,
      windowStart: Date.now(),
      windowCount: 0,
      lifetimeTimer: setTimeout(() => socket.close(CloseCode.sessionExpired, 'session expired'), this.limits.maxLifetimeMs),
      awarenessClientId: null,
      awarenessClock: 0,
      lastAwareness: null,
    };
    session.lifetimeTimer.unref();

    let sessions = this.docs.get(init.documentId);
    if (!sessions) {
      sessions = new Map();
      this.docs.set(init.documentId, sessions);
    }
    const others = [...sessions.values()];
    sessions.set(session.id, session);

    socket.on('pong', () => {
      session.alive = true;
    });
    socket.on('message', (data, isBinary) => this.onMessage(session, data, isBinary));
    socket.on('close', () => this.detach(session));
    socket.on('error', () => socket.terminate());

    void this.announce(session, others);
  }

  /** Sends session:ready (local + remote participants) and tells everyone else about the newcomer. */
  private async announce(session: Session, others: Session[]): Promise<void> {
    const me = participantOf(session);
    let remote: Participant[] = [];
    try {
      await this.cluster.presenceAdd(session.documentId, me);
      const r = await this.cluster.presenceRemote(session.documentId);
      remote = r.alive;
      for (const dead of r.dead) this.deliver(session.documentId, { type: 'document:user_left', participant: dead });
    } catch (err) {
      this.onError(err, 'presence lookup failed'); // degrade to local-only presence
    }
    if (session.socket.readyState !== session.socket.OPEN) return;
    const local = this.sessionsOf(session.documentId).map(participantOf);
    this.send(session, {
      type: 'session:ready',
      sessionId: session.id,
      userId: session.userId,
      role: session.role,
      participants: [...local, ...remote.filter((p) => !local.some((l) => l.sessionId === p.sessionId))],
    });
    for (const o of others) {
      this.send(o, { type: 'document:user_joined', participant: me });
      if (o.lastAwareness) this.send(session, { type: 'awareness:update', payload: o.lastAwareness });
    }
    for (const payload of this.remoteAwareness.get(session.documentId)?.values() ?? []) {
      this.send(session, { type: 'awareness:update', payload });
    }
    this.cluster.publishDoc(session.documentId, { kind: 'joined', participant: me });
  }

  participants(documentId: string): Participant[] {
    return this.sessionsOf(documentId).map(participantOf);
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this.docs.values()) n += s.size;
    return n;
  }

  /** Closes every socket with 1001 (server going away) and stops timers. */
  close(): void {
    clearInterval(this.heartbeat);
    if (this.sweeper) clearInterval(this.sweeper);
    this.unsubscribe();
    for (const sessions of this.docs.values()) {
      for (const s of sessions.values()) s.socket.close(CloseCode.goingAway, 'server shutting down');
    }
  }

  /** Catch-up from the database for every document with local sessions (ADR-0013 §3). Public for tests. */
  async sweepAll(): Promise<void> {
    for (const documentId of [...this.docs.keys()]) {
      try {
        const diff = await this.live.sweep(documentId);
        if (diff) {
          this.deliver(documentId, {
            type: 'update:broadcast',
            updateId: randomUUID(),
            payload: b64(diff),
            from: { sessionId: 'server', userId: 'server' },
          });
        }
        const { dead } = await this.cluster.presenceRemote(documentId);
        for (const p of dead) this.remoteLeft(documentId, p, null);
      } catch (err) {
        this.onError(err, 'sweep failed');
      }
    }
  }

  private detach(session: Session): void {
    clearTimeout(session.lifetimeTimer);
    const sessions = this.docs.get(session.documentId);
    if (!sessions?.delete(session.id)) return;
    if (sessions.size === 0) {
      this.docs.delete(session.documentId);
      this.remoteAwareness.delete(session.documentId);
    }
    this.live.release(session.documentId);

    const gone =
      session.awarenessClientId === null
        ? null
        : b64(encodeAwareness([{ clientId: session.awarenessClientId, clock: session.awarenessClock + 1, state: null }]));
    const me = participantOf(session);
    for (const o of sessions.values()) {
      this.send(o, { type: 'document:user_left', participant: me });
      if (gone) this.send(o, { type: 'awareness:update', payload: gone });
    }
    this.cluster.publishDoc(session.documentId, { kind: 'left', participant: me, awarenessGone: gone });
    void this.cluster.presenceRemove(session.documentId, session.id).catch((err: unknown) => this.onError(err, 'presence remove failed'));
  }

  /** Messages from other nodes (ADR-0013 §2). */
  private onRemote(documentId: string, msg: DocMessage): void {
    if (!this.docs.has(documentId)) {
      // Nobody here: keep the live copy (if any) current, nothing to deliver.
      if (msg.kind === 'update') this.live.applyRemote(documentId, fromB64(msg.payload), BigInt(msg.dbId));
      return;
    }
    switch (msg.kind) {
      case 'update':
        this.live.applyRemote(documentId, fromB64(msg.payload), BigInt(msg.dbId));
        this.deliver(documentId, { type: 'update:broadcast', updateId: msg.updateId, payload: msg.payload, from: msg.from });
        return;
      case 'awareness': {
        let byDoc = this.remoteAwareness.get(documentId);
        if (!byDoc) {
          byDoc = new Map();
          this.remoteAwareness.set(documentId, byDoc);
        }
        byDoc.set(msg.sessionId, msg.payload);
        this.deliver(documentId, { type: 'awareness:update', payload: msg.payload });
        return;
      }
      case 'joined':
        this.deliver(documentId, { type: 'document:user_joined', participant: msg.participant });
        return;
      case 'left':
        this.remoteLeft(documentId, msg.participant, msg.awarenessGone);
        return;
    }
  }

  private remoteLeft(documentId: string, participant: Participant, awarenessGone: string | null): void {
    const byDoc = this.remoteAwareness.get(documentId);
    const last = byDoc?.get(participant.sessionId);
    byDoc?.delete(participant.sessionId);
    this.deliver(documentId, { type: 'document:user_left', participant });
    // A crashed node never sends "gone"; derive it from the last state we saw.
    const gone = awarenessGone ?? (last ? awarenessRemoval(last) : null);
    if (gone) this.deliver(documentId, { type: 'awareness:update', payload: gone });
  }

  private sessionsOf(documentId: string): Session[] {
    return [...(this.docs.get(documentId)?.values() ?? [])];
  }

  private deliver(documentId: string, msg: ServerMessage, except?: string): void {
    for (const s of this.sessionsOf(documentId)) if (s.id !== except) this.send(s, msg);
  }

  private onMessage(session: Session, data: unknown, isBinary: boolean): void {
    this.timing.record('event_loop_lag', this.lagMs());
    const now = Date.now();
    if (now - session.windowStart >= this.limits.rateWindowMs) {
      session.windowStart = now;
      session.windowCount = 0;
    }
    if (++session.windowCount > this.limits.maxMessagesPerWindow) {
      session.socket.close(CloseCode.policyViolation, 'rate limit exceeded');
      return;
    }
    if (isBinary) {
      this.violation(session, 'INVALID_MESSAGE', 'Binary frames are not supported; send JSON text');
      return;
    }
    const parsed = parseClientMessage(String(data));
    if (!parsed.ok) {
      this.violation(session, parsed.code, parsed.message, parsed.ref);
      return;
    }
    this.dispatch(session, parsed.message);
  }

  private dispatch(session: Session, msg: ClientMessage): void {
    switch (msg.type) {
      case 'sync:request': {
        let result: { update: Uint8Array; stateVector: Uint8Array };
        try {
          result = this.live.syncFor(session.documentId, fromB64(msg.stateVector));
        } catch {
          this.violation(session, 'INVALID_MESSAGE', 'stateVector could not be decoded');
          return;
        }
        this.send(session, { type: 'sync:response', update: b64(result.update), stateVector: b64(result.stateVector) });
        this.send(session, { type: 'sync:complete' });
        return;
      }
      case 'update:submit':
        void this.submit(session, msg.updateId, msg.payload);
        return;
      case 'awareness:update':
        this.awareness(session, msg.payload);
        return;
    }
  }

  /** ADR-0003 / ADR-0010 §3: validate → persist → apply → ACK → broadcast (here and on other nodes). */
  private async submit(session: Session, updateId: string, payload: string): Promise<void> {
    const received = performance.now();
    if (session.role === 'viewer') {
      this.send(session, { type: 'error', code: 'FORBIDDEN', message: 'Viewers cannot edit this document', ref: updateId });
      return;
    }
    const update = fromB64(payload);
    const check = engineFor(session.engine).validateUpdate(update);
    if (!check.ok) {
      this.violation(session, check.code, check.reason, updateId);
      return;
    }
    let result: Awaited<ReturnType<LiveDocuments['submit']>>;
    try {
      result = await this.live.submit(session.documentId, { updateId, sessionId: session.id, userId: session.userId, update });
    } catch (err) {
      this.onError(err, 'persisting update');
      this.send(session, { type: 'error', code: 'PERSIST_FAILED', message: 'The update was not saved; it will be resent on resync', ref: updateId });
      return;
    }
    this.send(session, { type: 'update:ack', updateId });
    this.timing.record('receive_to_ack', performance.now() - received);
    if (result.outcome === 'duplicate') return; // already delivered the first time (CT-05)
    const from = { sessionId: session.id, userId: session.userId };
    this.deliver(session.documentId, { type: 'update:broadcast', updateId, payload, from }, session.id);
    this.cluster.publishDoc(session.documentId, { kind: 'update', updateId, payload, from, dbId: result.dbId.toString() });
  }

  private awareness(session: Session, payload: string): void {
    const bytes = fromB64(payload);
    if (bytes.byteLength > MAX_AWARENESS_BYTES) {
      this.violation(session, 'INVALID_MESSAGE', 'awareness update is too large');
      return;
    }
    let sanitized: Uint8Array | null;
    try {
      if (session.awarenessClientId === null) {
        session.awarenessClientId = decodeAwareness(bytes)[0]?.clientId ?? null;
        if (session.awarenessClientId === null) return;
      }
      sanitized = sanitizeAwareness(bytes, session.awarenessClientId, { userId: session.userId, displayName: session.displayName });
    } catch {
      this.violation(session, 'INVALID_MESSAGE', 'awareness update could not be decoded');
      return;
    }
    if (!sanitized) return;
    const clock = decodeAwareness(sanitized)[0]?.clock ?? 0;
    session.awarenessClock = Math.max(session.awarenessClock, clock);
    const out = b64(sanitized);
    session.lastAwareness = out;
    this.deliver(session.documentId, { type: 'awareness:update', payload: out }, session.id);
    this.cluster.publishDoc(session.documentId, { kind: 'awareness', payload: out, sessionId: session.id });
  }

  private violation(session: Session, code: string, message: string, ref?: string): void {
    this.send(session, ref ? { type: 'error', code, message, ref } : { type: 'error', code, message });
    if (++session.violations > this.limits.maxViolations) {
      session.socket.close(CloseCode.policyViolation, 'too many invalid messages');
    }
  }

  private send(session: Session, msg: ServerMessage): void {
    const { socket } = session;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.limits.maxBufferedBytes) {
      socket.terminate(); // slow consumer; it will resync on reconnect
      return;
    }
    socket.send(JSON.stringify(msg));
  }

  /** Event-loop delay sampled by a 50 ms ticker (only when timing is enabled). */
  private lastTick = performance.now();
  private lag = 0;
  private lagMs(): number {
    return this.lag;
  }

  private checkHeartbeats(): void {
    for (const sessions of this.docs.values()) {
      for (const s of sessions.values()) {
        if (!s.alive) {
          s.socket.terminate();
          continue;
        }
        s.alive = false;
        s.socket.ping();
      }
    }
  }
}

/** An awareness update that removes every client in `payload` (state = null, clock + 1). */
function awarenessRemoval(payload: string): string | null {
  try {
    const entries = decodeAwareness(fromB64(payload));
    if (entries.length === 0) return null;
    return b64(encodeAwareness(entries.map((e) => ({ clientId: e.clientId, clock: e.clock + 1, state: null }))));
  } catch {
    return null;
  }
}
