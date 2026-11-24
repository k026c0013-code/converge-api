import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { CONTENT_ROOT, engineFor, type CRDTEngine } from '../crdt/engine.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { NO_TIMING, type StageTimer } from './timing.js';

export interface SubmitInput {
  updateId: string;
  sessionId: string;
  userId: string;
  update: Uint8Array;
}

/** An update created by the server itself (e.g. a restore) that connected clients must receive. */
export interface ServerUpdate {
  documentId: string;
  updateId: string;
  userId: string;
  update: Uint8Array;
  dbId: bigint;
}

export interface VersionInfo {
  id: string;
  name: string;
  note: string | null;
  kind: string;
  createdBy: string;
  createdAt: Date;
}

interface Live {
  doc: Y.Doc;
  engine: CRDTEngine<Y.Doc>;
  refs: number;
  /** Serializes persist+apply per document so DB order and apply order agree (ADR-0010 §3). */
  queue: Promise<unknown>;
  unloadTimer: NodeJS.Timeout | null;
  /** Highest document_updates.id reflected in `doc` (0n when none). */
  lastUpdateId: bigint;
  updatesSinceSnapshot: number;
  /** Lower bound for the next catch-up sweep (ADR-0013 §3). */
  sweptAt: Date;
  /** Recently applied document_updates ids → when we saw them; the sweep only fetches the others. */
  seenIds: Map<bigint, number>;
}

export interface LiveDocumentsOptions {
  unloadDelayMs?: number;
  /** Take a snapshot after this many updates (ADR-0012 §1). */
  snapshotEvery?: number;
  onError?: (err: unknown, context: string) => void;
  timing?: StageTimer;
}

/**
 * In-memory documents rebuilt from snapshots + document_updates (ADR-0010 §3, ADR-0012 §1).
 * The database is the source of truth; memory is a cache that can be dropped at any time.
 */
export class LiveDocuments {
  private readonly live = new Map<string, Live>();
  private readonly loading = new Map<string, Promise<Live>>();
  private readonly serverUpdateListeners = new Set<(u: ServerUpdate) => void>();
  private readonly unloadDelayMs: number;
  private readonly snapshotEvery: number;
  private readonly onError: (err: unknown, context: string) => void;
  private readonly timing: StageTimer;

  constructor(
    private readonly prisma: PrismaClient,
    opts: LiveDocumentsOptions = {},
  ) {
    this.unloadDelayMs = opts.unloadDelayMs ?? 30_000;
    this.snapshotEvery = opts.snapshotEvery ?? 500;
    this.onError = opts.onError ?? (() => {});
    this.timing = opts.timing ?? NO_TIMING;
  }

  onServerUpdate(fn: (u: ServerUpdate) => void): () => void {
    this.serverUpdateListeners.add(fn);
    return () => this.serverUpdateListeners.delete(fn);
  }

  async acquire(documentId: string, engineName: string): Promise<void> {
    const entry = await this.load(documentId, engineName);
    entry.refs++;
    if (entry.unloadTimer) {
      clearTimeout(entry.unloadTimer);
      entry.unloadTimer = null;
    }
  }

  release(documentId: string): void {
    const entry = this.live.get(documentId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0 && !entry.unloadTimer) {
      entry.unloadTimer = setTimeout(() => {
        if (entry.refs === 0) this.live.delete(documentId);
      }, this.unloadDelayMs);
      entry.unloadTimer.unref();
    }
  }

  isLoaded(documentId: string): boolean {
    return this.live.has(documentId);
  }

  /** Drops a document from memory immediately (e.g. after an apply failure). */
  evict(documentId: string): void {
    const entry = this.live.get(documentId);
    if (entry?.unloadTimer) clearTimeout(entry.unloadTimer);
    this.live.delete(documentId);
  }

  /** Missing updates for a client plus the server's state vector (sync:response). */
  syncFor(documentId: string, clientStateVector: Uint8Array): { update: Uint8Array; stateVector: Uint8Array } {
    const entry = this.require(documentId);
    return {
      update:
        clientStateVector.byteLength === 0
          ? entry.engine.encodeState(entry.doc)
          : entry.engine.getStateDiff(entry.doc, clientStateVector),
      stateVector: entry.engine.encodeStateVector(entry.doc),
    };
  }

  /**
   * Applies an update another node already persisted (ADR-0013 §2). No-op when the document
   * is not loaded here: it will be read from the database on first use.
   */
  applyRemote(documentId: string, update: Uint8Array, dbId: bigint): boolean {
    const entry = this.live.get(documentId);
    if (!entry) return false;
    entry.engine.applyUpdate(entry.doc, update, 'remote-node');
    if (dbId > entry.lastUpdateId) entry.lastUpdateId = dbId;
    entry.seenIds.set(dbId, Date.now());
    return true;
  }

  loadedDocuments(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Re-reads recently persisted updates and applies those this node is missing (lost Pub/Sub
   * messages, races while loading). Returns the diff it applied, or null if nothing was missing.
   */
  async sweep(documentId: string, windowMs = 30_000): Promise<Uint8Array | null> {
    const entry = this.live.get(documentId);
    if (!entry) return null;
    const started = new Date();
    const since = new Date(entry.sweptAt.getTime() - windowMs);
    // Ids only: almost everything was already applied through Pub/Sub or locally.
    const recent = await this.prisma.documentUpdate.findMany({
      where: { documentId, createdAt: { gte: since } },
      select: { id: true },
    });
    entry.sweptAt = started;
    const cutoff = started.getTime() - 4 * windowMs;
    for (const [id, at] of entry.seenIds) if (at < cutoff) entry.seenIds.delete(id);
    const missing = recent.map((r) => r.id).filter((id) => !entry.seenIds.has(id));
    if (missing.length === 0) return null;
    const rows = await this.prisma.documentUpdate.findMany({
      where: { id: { in: missing } },
      orderBy: { id: 'asc' },
      select: { id: true, updateData: true },
    });
    const before = entry.engine.encodeStateVector(entry.doc);
    entry.doc.transact(() => {
      for (const r of rows) {
        entry.engine.applyUpdate(entry.doc, r.updateData, 'sweep');
        entry.seenIds.set(r.id, Date.now());
        if (r.id > entry.lastUpdateId) entry.lastUpdateId = r.id;
      }
    }, 'sweep');
    const diff = entry.engine.getStateDiff(entry.doc, before);
    const { structs, ds } = Y.decodeUpdate(diff);
    return structs.length === 0 && ds.clients.size === 0 ? null : diff;
  }

  /** Full encoded state (tests and diagnostics). */
  state(documentId: string): Uint8Array {
    const entry = this.require(documentId);
    return entry.engine.encodeState(entry.doc);
  }

  /**
   * Persists then applies (ADR-0003). Resolves 'duplicate' when (documentId, updateId) already exists.
   * Rejects if the insert fails; in that case nothing was applied.
   */
  submit(documentId: string, input: SubmitInput): Promise<{ outcome: 'applied'; dbId: bigint } | { outcome: 'duplicate' }> {
    const entry = this.require(documentId);
    const queued = performance.now();
    return this.enqueue(entry, async () => {
      const started = performance.now();
      this.timing.record('queue_wait', started - queued);
      const row = await this.persist(documentId, input.updateId, input.sessionId, input.userId, input.update);
      this.timing.record('insert', performance.now() - started);
      if (!row) return { outcome: 'duplicate' as const };
      this.applyPersisted(documentId, entry, row, input.update);
      await this.maybeSnapshot(documentId, entry);
      return { outcome: 'applied' as const, dbId: row.id };
    });
  }

  /** Saves the current state as a named version (ADR-0012 §2). Loads the document if needed. */
  async createVersion(
    documentId: string,
    engineName: string,
    input: { createdBy: string; name: string; note?: string | null; kind?: 'manual' | 'pre_restore' },
  ): Promise<VersionInfo> {
    return this.withDocument(documentId, engineName, (entry) =>
      this.enqueue(entry, () => this.versionLocked(documentId, entry, input)),
    );
  }

  /**
   * Restores a version as a new edit (ADR-0012 §3): saves a pre-restore version, replaces the
   * `content` children with the version's, persists, applies and notifies connected clients.
   */
  async restore(
    documentId: string,
    engineName: string,
    input: { versionId: string; userId: string; preRestoreName: string },
  ): Promise<{ preRestoreVersionId: string }> {
    return this.withDocument(documentId, engineName, (entry) =>
      this.enqueue(entry, async () => {
        const version = await this.prisma.documentVersion.findFirst({
          where: { id: input.versionId, documentId },
          include: { snapshot: { select: { stateData: true } } },
        });
        if (!version) throw new VersionNotFoundError();

        const pre = await this.versionLocked(documentId, entry, {
          createdBy: input.userId,
          name: input.preRestoreName,
          kind: 'pre_restore',
        });

        const target = new Y.Doc();
        Y.applyUpdate(target, version.snapshot.stateData);
        const update = buildReplacementUpdate(entry.doc, target);
        if (update) {
          const updateId = randomUUID();
          const row = await this.persist(documentId, updateId, 'server:restore', input.userId, update);
          if (!row) throw new Error('restore update id collided');
          this.applyPersisted(documentId, entry, row, update);
          for (const fn of this.serverUpdateListeners) fn({ documentId, updateId, userId: input.userId, update, dbId: row.id });
          await this.maybeSnapshot(documentId, entry);
        }
        return { preRestoreVersionId: pre.id };
      }),
    );
  }

  /** The `content` of a version as XML text (requirements §4.6 "過去状態の参照"). */
  static contentOf(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc.getXmlFragment(CONTENT_ROOT).toString();
  }

  // ---- internals -------------------------------------------------------

  private enqueue<T>(entry: Live, fn: () => Promise<T>): Promise<T> {
    const result = entry.queue.then(fn, fn);
    entry.queue = result.catch(() => undefined);
    return result;
  }

  private async withDocument<T>(documentId: string, engineName: string, fn: (entry: Live) => Promise<T>): Promise<T> {
    await this.acquire(documentId, engineName);
    try {
      return await fn(this.require(documentId));
    } finally {
      this.release(documentId);
    }
  }

  /** Inserts the update; returns its row id, or null when (documentId, updateId) already exists. */
  private async persist(documentId: string, updateId: string, clientId: string, userId: string, update: Uint8Array) {
    try {
      return await this.prisma.documentUpdate.create({
        data: { documentId, updateId, clientId, userId, updateData: Buffer.from(update) },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  private applyPersisted(documentId: string, entry: Live, row: { id: bigint }, update: Uint8Array): void {
    try {
      entry.engine.applyUpdate(entry.doc, update, 'persisted');
    } catch (err) {
      // Validated updates should always apply. If not, the DB is still right: rebuild on next access.
      this.evict(documentId);
      throw err;
    }
    entry.lastUpdateId = row.id;
    entry.seenIds.set(row.id, Date.now());
    entry.updatesSinceSnapshot++;
  }

  private async maybeSnapshot(documentId: string, entry: Live): Promise<void> {
    if (entry.updatesSinceSnapshot < this.snapshotEvery) return;
    try {
      await this.snapshotLocked(documentId, entry);
    } catch (err) {
      this.onError(err, 'snapshot failed'); // not fatal: the update itself is saved
    }
  }

  private async snapshotLocked(documentId: string, entry: Live): Promise<string> {
    const id = randomUUID();
    await this.prisma.documentSnapshot.create({
      data: { id, documentId, stateData: Buffer.from(entry.engine.encodeState(entry.doc)), lastUpdateId: entry.lastUpdateId },
    });
    entry.updatesSinceSnapshot = 0;
    return id;
  }

  private async versionLocked(
    documentId: string,
    entry: Live,
    input: { createdBy: string; name: string; note?: string | null; kind?: 'manual' | 'pre_restore' },
  ): Promise<VersionInfo> {
    const snapshotId = await this.snapshotLocked(documentId, entry);
    return this.prisma.documentVersion.create({
      data: {
        id: randomUUID(),
        documentId,
        snapshotId,
        createdBy: input.createdBy,
        name: input.name,
        note: input.note ?? null,
        kind: input.kind ?? 'manual',
      },
      select: { id: true, name: true, note: true, kind: true, createdBy: true, createdAt: true },
    });
  }

  private require(documentId: string): Live {
    const entry = this.live.get(documentId);
    if (!entry) throw new Error(`document ${documentId} is not loaded`);
    return entry;
  }

  private load(documentId: string, engineName: string): Promise<Live> {
    const existing = this.live.get(documentId);
    if (existing) return Promise.resolve(existing);
    const pending = this.loading.get(documentId);
    if (pending) return pending;

    const promise = (async () => {
      const loadStartedAt = new Date();
      const engine = engineFor(engineName);
      const doc = engine.createDocument();
      let lastUpdateId = 0n;
      const snapshot = await this.prisma.documentSnapshot.findFirst({
        where: { documentId },
        orderBy: { lastUpdateId: 'desc' },
        select: { stateData: true, lastUpdateId: true },
      });
      if (snapshot) {
        engine.applyUpdate(doc, snapshot.stateData, 'persisted');
        lastUpdateId = snapshot.lastUpdateId;
      }
      const PAGE = 500;
      let since = 0;
      // Ids applied from the tail; rows folded into the snapshot may be re-applied once (idempotent).
      const seenIds = new Map<bigint, number>();
      for (;;) {
        const rows = await this.prisma.documentUpdate.findMany({
          where: { documentId, id: { gt: lastUpdateId } },
          orderBy: { id: 'asc' },
          select: { id: true, updateData: true },
          take: PAGE,
        });
        for (const r of rows) {
          engine.applyUpdate(doc, r.updateData, 'persisted');
          lastUpdateId = r.id;
          seenIds.set(r.id, Date.now());
        }
        since += rows.length;
        if (rows.length < PAGE) break;
      }
      const entry: Live = {
        doc,
        engine,
        refs: 0,
        queue: Promise.resolve(),
        unloadTimer: null,
        lastUpdateId,
        updatesSinceSnapshot: since,
        sweptAt: loadStartedAt,
        seenIds,
      };
      this.live.set(documentId, entry);
      return entry;
    })().finally(() => this.loading.delete(documentId));

    this.loading.set(documentId, promise);
    return promise;
  }
}

export class VersionNotFoundError extends Error {
  constructor() {
    super('version not found');
  }
}

/**
 * One Yjs update that turns `current`'s content into `target`'s content:
 * delete every current child, insert clones of the target's children. Returns null if nothing changes.
 */
export function buildReplacementUpdate(current: Y.Doc, target: Y.Doc): Uint8Array | null {
  const work = new Y.Doc();
  Y.applyUpdate(work, Y.encodeStateAsUpdate(current));
  const before = Y.encodeStateVector(work);
  const fragment = work.getXmlFragment(CONTENT_ROOT);
  const source = target.getXmlFragment(CONTENT_ROOT);
  if (fragment.toString() === source.toString()) return null;
  work.transact(() => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    const clones = source.toArray().map((child) => (child as Y.XmlElement | Y.XmlText).clone());
    if (clones.length > 0) fragment.insert(0, clones);
  });
  return Y.encodeStateAsUpdate(work, before);
}
