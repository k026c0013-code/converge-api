import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';

/**
 * Local (IndexedDB) copies of documents for offline editing (ADR-0011).
 * Names are scoped per user so accounts on a shared browser never mix.
 */

const dbName = (userId: string, documentId: string) => `converge:${userId}:${documentId}`;
const dirtyKey = (userId: string, documentId: string) => `converge:dirty:${userId}:${documentId}`;
const indexKey = (userId: string) => `converge:docs:${userId}`;

// localStorage can be unavailable (private mode, blocked storage): everything degrades to "not stored".
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function knownDocs(userId: string): string[] {
  try {
    return JSON.parse(lsGet(indexKey(userId)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function remember(userId: string, documentId: string): void {
  const docs = new Set(knownDocs(userId));
  docs.add(documentId);
  lsSet(indexKey(userId), JSON.stringify([...docs]));
}

function forget(userId: string, documentId: string): void {
  lsSet(indexKey(userId), JSON.stringify(knownDocs(userId).filter((d) => d !== documentId)));
  lsSet(dirtyKey(userId, documentId), null);
}

/** "Has local changes the server has not confirmed" flag, kept across reloads. */
export function dirtyStore(userId: string, documentId: string) {
  return {
    get: () => lsGet(dirtyKey(userId, documentId)) === '1',
    set: (dirty: boolean) => lsSet(dirtyKey(userId, documentId), dirty ? '1' : null),
  };
}

/**
 * Binds a Y.Doc to IndexedDB and resolves once the local copy is loaded,
 * so the first sync:request already includes offline edits (ADR-0011 §1).
 */
export async function openLocal(userId: string, documentId: string, doc: Y.Doc): Promise<IndexeddbPersistence> {
  const persistence = new IndexeddbPersistence(dbName(userId, documentId), doc);
  await persistence.whenSynced;
  remember(userId, documentId);
  return persistence;
}

/** Deletes a local copy outright (document deleted or access revoked: nowhere left to send it). */
export async function discardLocal(userId: string, documentId: string): Promise<void> {
  await clearDocument(dbName(userId, documentId));
  forget(userId, documentId);
}

/**
 * On logout, removes local copies whose changes are all saved on the server.
 * Copies with unsaved changes are kept for the next sign-in (requirements §11). Returns how many were kept.
 */
export async function clearSavedLocalCopies(userId: string): Promise<number> {
  let kept = 0;
  for (const documentId of knownDocs(userId)) {
    if (dirtyStore(userId, documentId).get()) {
      kept++;
      continue;
    }
    await discardLocal(userId, documentId);
  }
  return kept;
}
