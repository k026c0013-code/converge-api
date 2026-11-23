import * as Y from 'yjs';

/**
 * CRDT engine abstraction (requirements §6.2, ADR-0010 §1).
 * Documents pick their engine via documents.engine (ADR-0006); only "yjs" exists until Phase 8.
 */
export type ValidationResult = { ok: true } | { ok: false; code: 'UPDATE_TOO_LARGE' | 'INVALID_UPDATE' | 'FORBIDDEN_ROOT'; reason: string };

export interface CRDTEngine<D = unknown> {
  readonly name: string;
  createDocument(): D;
  applyUpdate(document: D, update: Uint8Array, origin?: unknown): void;
  encodeState(document: D): Uint8Array;
  encodeStateVector(document: D): Uint8Array;
  getStateDiff(document: D, stateVector: Uint8Array): Uint8Array;
  /** Checks an untrusted update without touching any live document (R-03). */
  validateUpdate(update: Uint8Array): ValidationResult;
}

/** The only shared root a document may have (ADR-0004). Tiptap binds to it with `field: 'content'`. */
export const CONTENT_ROOT = 'content';
export const MAX_UPDATE_BYTES = 512 * 1024;

export class YjsEngine implements CRDTEngine<Y.Doc> {
  readonly name = 'yjs';

  createDocument(): Y.Doc {
    // gc stays on (Yjs default): history is kept in document_updates, not in the live doc.
    return new Y.Doc();
  }

  applyUpdate(document: Y.Doc, update: Uint8Array, origin?: unknown): void {
    Y.applyUpdate(document, update, origin);
  }

  encodeState(document: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(document);
  }

  encodeStateVector(document: Y.Doc): Uint8Array {
    return Y.encodeStateVector(document);
  }

  getStateDiff(document: Y.Doc, stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(document, stateVector);
  }

  validateUpdate(update: Uint8Array): ValidationResult {
    if (update.byteLength > MAX_UPDATE_BYTES) {
      return { ok: false, code: 'UPDATE_TOO_LARGE', reason: `update exceeds ${MAX_UPDATE_BYTES} bytes` };
    }
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(update);
    } catch {
      return { ok: false, code: 'INVALID_UPDATE', reason: 'update could not be decoded' };
    }
    for (const struct of decoded.structs) {
      // Items attached directly to a root carry the root's name as a string parent.
      // Nested or neighbour-inserted items reference existing items, which are themselves under `content`.
      if (struct instanceof Y.Item && typeof struct.parent === 'string' && struct.parent !== CONTENT_ROOT) {
        return { ok: false, code: 'FORBIDDEN_ROOT', reason: `only the "${CONTENT_ROOT}" root may be written` };
      }
    }
    return { ok: true };
  }
}

const engines: Record<string, CRDTEngine<Y.Doc>> = { yjs: new YjsEngine() };

export function engineFor(name: string): CRDTEngine<Y.Doc> {
  const engine = engines[name];
  if (!engine) throw new Error(`unknown CRDT engine "${name}"`);
  return engine;
}
