import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AccessEvents } from '../events.js';
import { CloseCode, parseClientMessage, type Participant, type ServerMessage, type SessionRole } from './protocol.js';

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
}

const participantOf = (s: Session): Participant => ({
  sessionId: s.id,
  userId: s.userId,
  displayName: s.displayName,
  role: s.role,
});

/**
 * Phase 2 realtime hub: presence plus opaque relay of update payloads (ADR-0007, ADR-0009).
 * Nothing here is persisted.
 */
export class CollabHub {
  private readonly docs = new Map<string, Map<string, Session>>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(
    events: AccessEvents,
    private readonly limits: HubLimits = DEFAULT_HUB_LIMITS,
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
    events.on('memberRoleChanged', onRole);
    events.on('memberRemoved', onRemoved);
    events.on('documentDeleted', onDeleted);
    events.on('tokenFamilyRevoked', onFamily);
    this.unsubscribe = () => {
      events.off('memberRoleChanged', onRole);
      events.off('memberRemoved', onRemoved);
      events.off('documentDeleted', onDeleted);
      events.off('tokenFamilyRevoked', onFamily);
    };
  }

  /** Registers an upgraded socket. Sends session:ready to it and user_joined to the others. */
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
    for (const o of others) this.send(o, { type: 'document:user_joined', participant: participantOf(session) });
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
    for (const o of sessions.values()) this.send(o, { type: 'document:user_left', participant: participantOf(session) });
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

    const msg = parsed.message;
    if (session.role === 'viewer') {
      this.send(session, { type: 'error', code: 'FORBIDDEN', message: 'Viewers cannot edit this document', ref: msg.updateId });
      return;
    }
    const out: ServerMessage = {
      type: 'update:broadcast',
      updateId: msg.updateId,
      payload: msg.payload,
      from: { sessionId: session.id, userId: session.userId },
    };
    for (const o of this.sessionsOf(session.documentId)) if (o.id !== session.id) this.send(o, out);
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
