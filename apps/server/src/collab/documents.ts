import type * as Y from 'yjs';
import { engineFor, type CRDTEngine } from '../crdt/engine.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

export interface SubmitInput {
  updateId: string;
  sessionId: string;
  userId: string;
  update: Uint8Array;
}

interface Live {
  doc: Y.Doc;
  engine: CRDTEngine<Y.Doc>;
  refs: number;
  /** Serializes persist+apply per document so DB order and apply order agree (ADR-0010 §3). */
  queue: Promise<unknown>;
  unloadTimer: NodeJS.Timeout | null;
}

/**
 * In-memory documents rebuilt from document_updates (ADR-0010 §3).
 * The database is the source of truth; memory is a cache that can be dropped at any time.
 */
export class LiveDocuments {
  private readonly live = new Map<string, Live>();
  private readonly loading = new Map<string, Promise<Live>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly unloadDelayMs = 30_000,
  ) {}

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

  /** Drops a document from memory immediately (e.g. after deletion or an apply failure). */
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

  /** Full encoded state (tests and diagnostics). */
  state(documentId: string): Uint8Array {
    const entry = this.require(documentId);
    return entry.engine.encodeState(entry.doc);
  }

  /**
   * Persists then applies (ADR-0003). Resolves 'duplicate' when (documentId, updateId) already exists.
   * Rejects if the insert fails; in that case nothing was applied.
   */
  submit(documentId: string, input: SubmitInput): Promise<'applied' | 'duplicate'> {
    const entry = this.require(documentId);
    const run = async (): Promise<'applied' | 'duplicate'> => {
      try {
        await this.prisma.documentUpdate.create({
          data: {
            documentId,
            updateId: input.updateId,
            clientId: input.sessionId,
            userId: input.userId,
            updateData: Buffer.from(input.update),
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'duplicate';
        throw err;
      }
      try {
        entry.engine.applyUpdate(entry.doc, input.update, 'persisted');
      } catch (err) {
        // Validated updates should always apply. If not, the DB is still right: rebuild on next access.
        this.evict(documentId);
        throw err;
      }
      return 'applied';
    };
    const result = entry.queue.then(run, run);
    entry.queue = result.catch(() => undefined);
    return result;
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
      const engine = engineFor(engineName);
      const doc = engine.createDocument();
      const PAGE = 500;
      let cursor: bigint | undefined;
      for (;;) {
        const rows = await this.prisma.documentUpdate.findMany({
          where: { documentId, ...(cursor !== undefined && { id: { gt: cursor } }) },
          orderBy: { id: 'asc' },
          select: { id: true, updateData: true },
          take: PAGE,
        });
        for (const r of rows) engine.applyUpdate(doc, r.updateData, 'persisted');
        if (rows.length < PAGE) break;
        cursor = rows.at(-1)!.id;
      }
      const entry: Live = { doc, engine, refs: 0, queue: Promise.resolve(), unloadTimer: null };
      this.live.set(documentId, entry);
      return entry;
    })().finally(() => this.loading.delete(documentId));

    this.loading.set(documentId, promise);
    return promise;
  }
}
