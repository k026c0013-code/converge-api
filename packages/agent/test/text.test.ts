import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  CONTENT_FIELD,
  addReplyParagraph,
  humanBlocks,
  newHumanText,
  readBlocks,
  renderDocument,
  startReply,
  typingPlan,
} from '../src/text.js';

/** Builds a Tiptap-shaped document: one element per entry, with optional text. */
function docWith(...nodes: Array<[string, string?]>): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(CONTENT_FIELD);
  for (const [name, text] of nodes) {
    const el = new Y.XmlElement(name);
    if (text !== undefined) el.insert(0, [new Y.XmlText(text)]);
    fragment.push([el]);
  }
  return doc;
}

/** Writes a reply the way ConvergeAgent.write does, recording every update it produces. */
function writeReply(doc: Y.Doc, reply: string): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const record = (u: Uint8Array) => updates.push(u);
  doc.on('update', record);
  let quote: Y.XmlElement | null = null;
  for (const [first, ...rest] of typingPlan(reply, 1000)) {
    let t: Y.XmlText;
    if (quote) t = addReplyParagraph(doc, quote, first!);
    else ({ quote, text: t } = startReply(doc, first!));
    for (const c of rest) t.insert(t.length, c);
  }
  doc.off('update', record);
  return updates;
}

describe('reading the document', () => {
  it('reads paragraphs, headings, lists and marks agent replies', () => {
    const doc = docWith(['heading', '議題'], ['paragraph', 'こんにちは']);
    const list = new Y.XmlElement('bulletList');
    for (const item of ['りんご', 'みかん']) {
      const li = new Y.XmlElement('listItem');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(item)]);
      li.insert(0, [p]);
      list.push([li]);
    }
    doc.getXmlFragment(CONTENT_FIELD).push([list]);
    writeReply(doc, 'はじめまして\n二段落目');

    const blocks = readBlocks(doc);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'bulletList', 'blockquote', 'paragraph']);
    expect(renderDocument(blocks)).toBe('議題\nこんにちは\n- りんご\n- みかん\nClaude> はじめまして\nClaude> 二段落目');
    expect(humanBlocks(blocks)).toEqual(['議題', 'こんにちは', '- りんご\n- みかん']);
  });

  it('ignores formatting marks and keeps the text', () => {
    const doc = docWith(['paragraph']);
    const p = doc.getXmlFragment(CONTENT_FIELD).get(0) as Y.XmlElement;
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, '太字', { bold: {} });
    t.insert(2, 'と普通');
    expect(renderDocument(readBlocks(doc))).toBe('太字と普通');
  });
});

describe('finding what people wrote', () => {
  it('returns only blocks after the common prefix, ignoring the agent and empty lines', () => {
    expect(newHumanText(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe('c\nd');
    expect(newHumanText(['a', 'b'], ['a', 'b'])).toBe('');
    expect(newHumanText(['a', 'b'], ['a', 'B', 'c'])).toBe('B\nc'); // an edited line counts as new
  });

  it('agent replies inserted in between do not hide or repeat human text', () => {
    const doc = docWith(['paragraph', '質問1'], ['paragraph', '']);
    const baseline = humanBlocks(readBlocks(doc));
    writeReply(doc, '回答1');
    expect(newHumanText(baseline, humanBlocks(readBlocks(doc)))).toBe('');

    // the person types in the empty paragraph that stayed below the reply
    const last = doc.getXmlFragment(CONTENT_FIELD).get(2) as Y.XmlElement;
    last.insert(0, [new Y.XmlText('質問2')]);
    expect(newHumanText(baseline, humanBlocks(readBlocks(doc)))).toBe('質問2');
  });
});

describe('placing replies', () => {
  it('puts the reply above a trailing empty paragraph (the waiting cursor)', () => {
    const doc = docWith(['paragraph', '質問'], ['paragraph']);
    writeReply(doc, '答え');
    expect(readBlocks(doc).map((b) => [b.kind, b.text])).toEqual([
      ['paragraph', '質問'],
      ['blockquote', '答え'],
      ['paragraph', ''],
    ]);
  });

  it('adds an empty paragraph after the reply when the document ends with text', () => {
    const doc = docWith(['paragraph', '質問']);
    writeReply(doc, '答え');
    expect(readBlocks(doc).map((b) => b.kind)).toEqual(['paragraph', 'blockquote', 'paragraph']);
  });

  it('never lets an open editor see an empty quote block or paragraph-less reply', () => {
    // y-prosemirror deletes nodes that do not fit the schema, so every intermediate state must be valid.
    const doc = docWith(['paragraph', '質問'], ['paragraph']);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    const updates = writeReply(doc, 'ひとつめ\nふたつめ\nみっつめ');
    expect(updates.length).toBeGreaterThan(3);
    for (const u of updates) {
      Y.applyUpdate(replica, u);
      for (const node of replica.getXmlFragment(CONTENT_FIELD).toArray()) {
        if (!(node instanceof Y.XmlElement) || node.nodeName !== 'blockquote') continue;
        expect(node.length).toBeGreaterThan(0);
        for (const p of node.toArray()) expect((p as Y.XmlElement).toArray().length).toBe(1); // text node present
      }
    }
    expect(renderDocument(readBlocks(replica))).toBe('質問\nClaude> ひとつめ\nClaude> ふたつめ\nClaude> みっつめ');
  });

  it('works on an empty document', () => {
    const doc = new Y.Doc();
    writeReply(doc, 'こんにちは');
    expect(readBlocks(doc).map((b) => [b.kind, b.text])).toEqual([
      ['blockquote', 'こんにちは'],
      ['paragraph', ''],
    ]);
  });
});

describe('typing plan', () => {
  it('splits into paragraphs and keeps the number of steps bounded', () => {
    const reply = 'あ'.repeat(500) + '\n\n' + 'い'.repeat(300);
    const plan = typingPlan(reply, 80);
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.join(''))).toEqual(['あ'.repeat(500), 'い'.repeat(300)]);
    expect(plan.flat().length).toBeLessThanOrEqual(82);
  });

  it('never splits a surrogate pair (emoji)', () => {
    const plan = typingPlan('😀😀😀', 3);
    expect(plan[0]).toEqual(['😀', '😀', '😀']);
  });

  it('returns nothing for blank text', () => {
    expect(typingPlan('  \n \n', 10)).toEqual([]);
  });
});
