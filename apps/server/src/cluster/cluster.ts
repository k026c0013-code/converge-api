import { randomUUID } from 'node:crypto';
import type { Participant } from '../collab/protocol.js';
import type { AccessEventMap } from '../events.js';

/**
 * What one Collaboration Server tells the others about a document (ADR-0013 §2).
 * Payloads are base64 so messages stay plain JSON.
 */
export type DocMessage =
  | { kind: 'update'; updateId: string; payload: string; from: { sessionId: string; userId: string }; dbId: string }
  | { kind: 'awareness'; payload: string; sessionId: string }
  | { kind: 'joined'; participant: Participant }
  | { kind: 'left'; participant: Participant; awarenessGone: string | null };

export type AccessMessage = { [K in keyof AccessEventMap]: { event: K; args: AccessEventMap[K][0] } }[keyof AccessEventMap];

export interface Cluster {
  readonly nodeId: string;
  /** True when other nodes may exist (enables catch-up sweeps). */
  readonly distributed: boolean;
  publishDoc(documentId: string, msg: DocMessage): void;
  onDoc(fn: (documentId: string, msg: DocMessage) => void): void;
  publishAccess(msg: AccessMessage): void;
  onAccess(fn: (msg: AccessMessage) => void): void;
  /** Called when the link to the other nodes recovers after an outage (messages may have been lost). */
  onReconnect(fn: () => void): void;

  presenceAdd(documentId: string, participant: Participant): Promise<void>;
  presenceRemove(documentId: string, sessionId: string): Promise<void>;
  /** Participants on other live nodes. Entries of dead nodes are removed and returned separately. */
  presenceRemote(documentId: string): Promise<{ alive: Participant[]; dead: Participant[] }>;

  close(): Promise<void>;
}

/** Single-process cluster: nothing to share (Phases 2–5 behaviour). */
export class LocalCluster implements Cluster {
  readonly nodeId = randomUUID();
  readonly distributed = false;
  publishDoc(): void {}
  onDoc(): void {}
  publishAccess(): void {}
  onAccess(): void {}
  onReconnect(): void {}
  async presenceAdd(): Promise<void> {}
  async presenceRemove(): Promise<void> {}
  async presenceRemote(): Promise<{ alive: Participant[]; dead: Participant[] }> {
    return { alive: [], dead: [] };
  }
  async close(): Promise<void> {}
}
