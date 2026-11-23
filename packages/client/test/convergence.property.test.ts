import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

/**
 * Requirements §4.4 / §15: "if every client receives the same set of updates, they converge" —
 * checked for random edits, random delivery order (CT-04) and duplicated delivery (CT-05).
 */
describe('Yjs convergence (property-based)', () => {
  const op = fc.record({
    who: fc.integer({ min: 0, max: 3 }),
    kind: fc.constantFrom('insert', 'delete', 'format'),
    pos: fc.nat(),
    len: fc.integer({ min: 1, max: 4 }),
    str: fc.string({ minLength: 1, maxLength: 4 }),
  });

  it('all replicas converge regardless of delivery order and duplicates', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), fc.integer(), (ops, seed) => {
        const docs = Array.from({ length: 4 }, () => new Y.Doc());
        const log: Uint8Array[] = [];
        docs.forEach((d) => d.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && log.push(u)));

        for (const o of ops) {
          const t = docs[o.who]!.getXmlFragment('content');
          if (t.length === 0) t.insert(0, [new Y.XmlText('')]);
          const text = t.get(0) as Y.XmlText;
          const n = text.length;
          if (o.kind === 'insert') text.insert(o.pos % (n + 1), o.str);
          else if (n > 0 && o.kind === 'delete') text.delete(o.pos % n, Math.min(o.len, n - (o.pos % n)));
          else if (n > 0) text.format(o.pos % n, Math.min(o.len, n - (o.pos % n)), { bold: true });
        }

        // Each replica receives every update (plus some twice) in its own shuffled order.
        let s = seed >>> 0;
        const next = () => ((s = (s * 1103515245 + 12345) >>> 0), s);
        for (const d of docs) {
          const delivery = [...log, ...log.filter(() => next() % 3 === 0)];
          for (let i = delivery.length - 1; i > 0; i--) {
            const j = next() % (i + 1);
            [delivery[i], delivery[j]] = [delivery[j]!, delivery[i]!];
          }
          for (const u of delivery) Y.applyUpdate(d, u, 'remote');
        }

        const states = docs.map((d) => d.getXmlFragment('content').toString());
        expect(new Set(states).size).toBe(1);
        const vectors = docs.map((d) => Y.encodeStateVector(d).toString());
        expect(new Set(vectors).size).toBe(1);
      }),
      { numRuns: 300 },
    );
  });
});
