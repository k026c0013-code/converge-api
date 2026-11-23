import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ConvergeConnection } from './index.js';

/** Origin used for changes that came from the server, so they are not sent back. */
export const REMOTE = Symbol('converge-remote');

export type SyncState = 'offline' | 'syncing' | 'synced';

/** True when an encoded update carries no structs and no deletions. */
function isEmptyUpdate(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
}

/**
 * Binds a Y.Doc (and optionally an Awareness) to a ConvergeConnection (ADR-0010 §4–6).
 *
 * - On every (re)connect: sync:request with the local state vector, apply the server's diff,
 *   then send whatever the server is missing as one new update (R-10: state-vector based recovery).
 * - Local changes are sent as update:submit while connected; offline changes are recovered by the next sync.
 */
export class YjsSync {
  private readonly unsubs: Array<() => void> = [];
  private readonly pending = new Set<string>();
  private _state: SyncState = 'offline';
  private readonly listeners = new Set<(s: SyncState, pending: number) => void>();

  constructor(
    private readonly conn: ConvergeConnection,
    readonly doc: Y.Doc,
    readonly awareness?: awarenessProtocol.Awareness,
  ) {
    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this._state !== 'synced' || !this.canEdit()) return;
      this.submit(update);
    };
    doc.on('update', onDocUpdate);
    this.unsubs.push(() => doc.off('update', onDocUpdate));

    this.unsubs.push(
      conn.on('ready', () => {
        this.setState('syncing');
        conn.requestSync(Y.encodeStateVector(doc));
        this.sendLocalAwareness();
      }),
      conn.on('syncResponse', ({ update, stateVector }) => {
        Y.applyUpdate(doc, update, REMOTE);
        if (this.canEdit()) {
          const missing = Y.encodeStateAsUpdate(doc, stateVector);
          if (!isEmptyUpdate(missing)) this.submit(missing);
        }
      }),
      conn.on('syncComplete', () => this.setState('synced')),
      conn.on('update', (u) => Y.applyUpdate(doc, u.payload, REMOTE)),
      conn.on('ack', (id) => {
        if (this.pending.delete(id)) this.emit();
      }),
      conn.on('serverError', (e) => {
        // A failed save is recovered by a fresh state-vector sync (the server tells us what it lacks).
        if (e.code === 'PERSIST_FAILED' && e.ref && this.pending.delete(e.ref)) {
          conn.requestSync(Y.encodeStateVector(doc));
        }
      }),
      conn.on('status', (s) => {
        if (s !== 'open') {
          this.pending.clear();
          this.setState('offline');
          this.dropRemoteAwareness();
        }
      }),
    );

    if (awareness) {
      const onAwareness = (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === REMOTE) return;
        const changed = [...added, ...updated, ...removed].filter((id) => id === doc.clientID);
        if (changed.length) conn.sendAwareness(awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      };
      awareness.on('update', onAwareness);
      this.unsubs.push(
        () => awareness.off('update', onAwareness),
        conn.on('awareness', (payload) => awarenessProtocol.applyAwarenessUpdate(awareness, payload, REMOTE)),
      );
    }
  }

  get state(): SyncState {
    return this._state;
  }

  /** Updates sent but not yet confirmed as persisted. */
  get pendingCount(): number {
    return this.pending.size;
  }

  onChange(fn: (state: SyncState, pending: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.listeners.clear();
  }

  private canEdit(): boolean {
    return this.conn.role !== 'viewer';
  }

  private submit(update: Uint8Array): void {
    const id = this.conn.sendUpdate(update);
    if (id) {
      this.pending.add(id);
      this.emit();
    }
  }

  private sendLocalAwareness(): void {
    if (!this.awareness || this.awareness.getLocalState() === null) return;
    this.conn.sendAwareness(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
  }

  private dropRemoteAwareness(): void {
    if (!this.awareness) return;
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length) awarenessProtocol.removeAwarenessStates(this.awareness, others, REMOTE);
  }

  private setState(s: SyncState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this._state, this.pending.size);
  }
}
