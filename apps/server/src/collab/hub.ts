import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
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
}

export const DEFAULT_HUB_LIMITS: HubLimits = {
  heartbeatMs: 30_000,
  maxLifetimeMs: 12 * 60 * 60 * 1000,
  maxMessagesPerWindow: 200,
  rateWindowMs: 10_000,
  maxViolations: 10,
  maxBufferedBytes: 16 * 1024 * 1024,
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
 * Realtime hub (ADR-0009, ADR-0010): presence, Yjs sync, persisted updates with ACK, awareness.
 */
export class CollabHub {
  private readonly docs = new Map<string, Map<string, Session>>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(
    events: AccessEvents,
    private readonly live: LiveDocuments,
    private readonly limits: HubLimits = DEFAULT_HUB_LIMITS,
    private readonly onError: (err: unknown, context: string) => void = () => {},
  ) {
    this.heartbeat = setInterval(() => this.checkHeartbeats(), limits.heartbeatMs);
    this.heartbeat.unref();

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
    // Server-made edits (restore) go to everyone connected, like any other update.
    const offServerUpdate = live.onServerUpdate((u) => {
      const out: ServerMessage = {
        type: 'update:broadcast',
        updateId: u.updateId,
        payload: b64(u.update),
        from: { sessionId: 'server', userId: u.userId },
      };
      for (const s of this.sessionsOf(u.documentId)) this.send(s, out);
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

    this.send(session, {
      type: 'session:ready',
      sessionId: session.id,
      userId: session.userId,
      role: session.role,
      participants: [...sessions.values()].map(participantOf),
    });
    for (const o of others) {
      this.send(o, { type: 'document:user_joined', participant: participantOf(session) });
      if (o.lastAwareness) this.send(session, { type: 'awareness:update', payload: o.lastAwareness });
    }
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
    this.unsubscribe();
    for (const sessions of this.docs.values()) {
      for (const s of sessions.values()) s.socket.close(CloseCode.goingAway, 'server shutting down');
    }
  }

  private detach(session: Session): void {
    clearTimeout(session.lifetimeTimer);
    const sessions = this.docs.get(session.documentId);
    if (!sessions?.delete(session.id)) return;
    if (sessions.size === 0) this.docs.delete(session.documentId);
    this.live.release(session.documentId);

    const gone =
      session.awarenessClientId === null
        ? null
        : b64(encodeAwareness([{ clientId: session.awarenessClientId, clock: session.awarenessClock + 1, state: null }]));
    for (const o of sessions.values()) {
      this.send(o, { type: 'document:user_left', participant: participantOf(session) });
      if (gone) this.send(o, { type: 'awareness:update', payload: gone });
    }
  }

  private sessionsOf(documentId: string): Session[] {
    return [...(this.docs.get(documentId)?.values() ?? [])];
  }

  private onMessage(session: Session, data: unknown, isBinary: boolean): void {
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
        const { update, stateVector } = result;
        this.send(session, { type: 'sync:response', update: b64(update), stateVector: b64(stateVector) });
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

  /** ADR-0003 / ADR-0010 §3: validate → persist → apply → ACK → broadcast. */
  private async submit(session: Session, updateId: string, payload: string): Promise<void> {
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
    let outcome: 'applied' | 'duplicate';
    try {
      outcome = await this.live.submit(session.documentId, {
        updateId,
        sessionId: session.id,
        userId: session.userId,
        update,
      });
    } catch (err) {
      this.onError(err, 'persisting update');
      this.send(session, { type: 'error', code: 'PERSIST_FAILED', message: 'The update was not saved; it will be resent on resync', ref: updateId });
      return;
    }
    this.send(session, { type: 'update:ack', updateId });
    if (outcome === 'duplicate') return; // already delivered the first time (CT-05)
    const out: ServerMessage = { type: 'update:broadcast', updateId, payload, from: { sessionId: session.id, userId: session.userId } };
    for (const o of this.sessionsOf(session.documentId)) if (o.id !== session.id) this.send(o, out);
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
    for (const o of this.sessionsOf(session.documentId)) if (o.id !== session.id) this.send(o, { type: 'awareness:update', payload: out });
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
