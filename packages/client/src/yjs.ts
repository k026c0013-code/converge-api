import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ConvergeConnection } from './index.js';

/** Origin used for changes that came from the server, so they are not sent back. */
export const REMOTE = Symbol('converge-remote');

export type SyncState = 'offline' | 'syncing' | 'synced';

export interface YjsSyncOptions {
  /** Persists the "has unsaved local changes" flag across reloads (e.g. localStorage). */
  dirtyStore?: { get(): boolean; set(dirty: boolean): void };
}

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
  private open = false;
  /** sync:complete received on the current connection. */
  private complete = false;
  private _dirty: boolean;
  private readonly listeners = new Set<(s: SyncState, pending: number, dirty: boolean) => void>();

  constructor(
    private readonly conn: ConvergeConnection,
    readonly doc: Y.Doc,
    readonly awareness?: awarenessProtocol.Awareness,
    private readonly opts: YjsSyncOptions = {},
  ) {
    this._dirty = opts.dirtyStore?.get() ?? false;
    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !this.canEdit()) return;
      if (this.open && this.complete) this.submit(update);
      else this.setDirty(true); // offline: recovered by the next state-vector sync (ADR-0011 §2)
    };
    doc.on('update', onDocUpdate);
    this.unsubs.push(() => doc.off('update', onDocUpdate));

    this.unsubs.push(
      conn.on('ready', () => {
        this.open = true;
        this.complete = false;
        this.recompute();
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
      conn.on('syncComplete', () => {
        this.complete = true;
        this.recompute();
      }),
      conn.on('update', (u) => Y.applyUpdate(doc, u.payload, REMOTE)),
      conn.on('ack', (id) => {
        if (this.pending.delete(id)) this.recompute();
      }),
      conn.on('serverError', (e) => {
        // A failed save is recovered by a fresh state-vector sync (the server tells us what it lacks).
        if (e.code === 'PERSIST_FAILED' && e.ref && this.pending.delete(e.ref)) {
          conn.requestSync(Y.encodeStateVector(doc));
        }
      }),
      conn.on('status', (s) => {
        if (s !== 'open') {
          this.open = false;
          this.complete = false;
          this.pending.clear();
          this.recompute();
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

  /** Local changes the server has not confirmed yet (ADR-0011 §2). */
  get dirty(): boolean {
    return this._dirty;
  }

  /** Updates sent but not yet confirmed as persisted. */
  get pendingCount(): number {
    return this.pending.size;
  }

  onChange(fn: (state: SyncState, pending: number, dirty: boolean) => void): () => void {
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
    this.setDirty(true);
    const id = this.conn.sendUpdate(update);
    if (id) this.pending.add(id);
    this.recompute();
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

  /** offline → not connected; syncing → before sync:complete or with unacknowledged updates; synced → all saved. */
  private recompute(): void {
    const next: SyncState = !this.open ? 'offline' : !this.complete || this.pending.size > 0 ? 'syncing' : 'synced';
    this._state = next;
    if (next === 'synced') this.setDirty(false);
    this.emit();
  }

  private setDirty(d: boolean): void {
    if (this._dirty === d) return;
    this._dirty = d;
    this.opts.dirtyStore?.set(d);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this._state, this.pending.size, this._dirty);
  }
}
