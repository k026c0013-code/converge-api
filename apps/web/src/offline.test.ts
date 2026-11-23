import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { clearSavedLocalCopies, dirtyStore, discardLocal, openLocal } from './offline';

const content = (d: Y.Doc) => d.getXmlFragment('content').toString();

async function write(userId: string, docId: string, text: string) {
  const doc = new Y.Doc();
  const p = await openLocal(userId, docId, doc);
  doc.getXmlFragment('content').push([new Y.XmlText(text)]);
  await new Promise((r) => setTimeout(r, 20)); // let y-indexeddb flush
  await p.destroy();
}

async function read(userId: string, docId: string) {
  const doc = new Y.Doc();
  const p = await openLocal(userId, docId, doc);
  const out = content(doc);
  await p.destroy();
  return out;
}

beforeEach(() => localStorage.clear());

describe('offline store (ADR-0011)', () => {
  it('keeps local edits across Y.Doc instances (page reloads)', async () => {
    await write('u1', 'd1', 'typed offline');
    expect(await read('u1', 'd1')).toBe('typed offline');
  });

  it('separates users on the same browser', async () => {
    await write('alice', 'shared', 'alice draft');
    expect(await read('bob', 'shared')).toBe('');
  });

  it('logout clears only copies without unsaved changes', async () => {
    await write('u2', 'saved', 'all saved');
    await write('u2', 'unsaved', 'not yet sent');
    dirtyStore('u2', 'unsaved').set(true);

    expect(await clearSavedLocalCopies('u2')).toBe(1);
    expect(await read('u2', 'saved')).toBe('');
    expect(await read('u2', 'unsaved')).toBe('not yet sent');
  });

  it('discardLocal removes the copy and its dirty flag', async () => {
    await write('u3', 'gone', 'x');
    dirtyStore('u3', 'gone').set(true);
    await discardLocal('u3', 'gone');
    expect(dirtyStore('u3', 'gone').get()).toBe(false);
    expect(await read('u3', 'gone')).toBe('');
  });
});
