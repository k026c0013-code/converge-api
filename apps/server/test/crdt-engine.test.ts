import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_UPDATE_BYTES, YjsEngine, engineFor } from '../src/crdt/engine.js';

const engine = new YjsEngine();

function updateFrom(edit: (doc: Y.Doc) => void, base?: Y.Doc): Uint8Array {
  const doc = new Y.Doc();
  if (base) Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  const sv = Y.encodeStateVector(doc);
  edit(doc);
  return Y.encodeStateAsUpdate(doc, sv);
}

const paragraph = (text: string) => (doc: Y.Doc) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('content').insert(doc.getXmlFragment('content').length, [p]);
};

describe('YjsEngine (requirements §6.2)', () => {
  it('round-trips state, state vectors and diffs', () => {
    const a = engine.createDocument();
    engine.applyUpdate(a, updateFrom(paragraph('hello')));
    const b = engine.createDocument();
    engine.applyUpdate(b, engine.getStateDiff(a, engine.encodeStateVector(b)));
    expect(b.getXmlFragment('content').toString()).toBe('<paragraph>hello</paragraph>');
    expect(engine.getStateDiff(a, engine.encodeStateVector(b)).byteLength).toBeLessThan(5); // nothing missing
    expect(engine.encodeState(a)).toEqual(engine.encodeState(b));
  });

  it('is selected by the documents.engine value (ADR-0006)', () => {
    expect(engineFor('yjs').name).toBe('yjs');
    expect(() => engineFor('custom')).toThrow(/unknown CRDT engine/);
  });
});

describe('validateUpdate (R-03, ADR-0010 §2)', () => {
  it('accepts edits inside the content root, including nested and neighbour inserts', () => {
    const base = new Y.Doc();
    Y.applyUpdate(base, updateFrom(paragraph('one')));
    expect(engine.validateUpdate(updateFrom(paragraph('two'), base))).toEqual({ ok: true });
    const nested = updateFrom((d) => {
      const text = (d.getXmlFragment('content').get(0) as Y.XmlElement).get(0) as Y.XmlText;
      text.insert(1, 'X', { bold: true });
    }, base);
    expect(engine.validateUpdate(nested)).toEqual({ ok: true });
    const deletion = updateFrom((d) => d.getXmlFragment('content').delete(0, 1), base);
    expect(engine.validateUpdate(deletion)).toEqual({ ok: true });
  });

  it.each([
    ['a meta map', (d: Y.Doc) => d.getMap('meta').set('title', 'hijack')],
    ['an unknown text root', (d: Y.Doc) => d.getText('evil').insert(0, 'x')],
    ['a second fragment', (d: Y.Doc) => d.getXmlFragment('default').insert(0, [new Y.XmlText('x')])],
  ])('rejects writes to %s', (_name, edit) => {
    expect(engine.validateUpdate(updateFrom(edit))).toMatchObject({ ok: false, code: 'FORBIDDEN_ROOT' });
  });

  it('rejects a mixed update that also touches another root', () => {
    const mixed = updateFrom((d) => {
      paragraph('ok')(d);
      d.getMap('meta').set('x', 1);
    });
    expect(engine.validateUpdate(mixed)).toMatchObject({ ok: false, code: 'FORBIDDEN_ROOT' });
  });

  it('rejects garbage bytes and oversized updates', () => {
    expect(engine.validateUpdate(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 1]))).toMatchObject({ ok: false, code: 'INVALID_UPDATE' });
    expect(engine.validateUpdate(new Uint8Array(MAX_UPDATE_BYTES + 1))).toMatchObject({ ok: false, code: 'UPDATE_TOO_LARGE' });
  });
});
