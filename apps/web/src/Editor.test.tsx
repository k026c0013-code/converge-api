import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CONTENT_FIELD, Editor } from './Editor';

afterEach(cleanup);

// jsdom has no layout engine; ProseMirror asks for rects when it scrolls the selection into view.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => new DOMRect(0, 0, 0, 0);
for (const proto of [Element.prototype, Range.prototype] as Array<{ getClientRects: () => DOMRectList; getBoundingClientRect: () => DOMRect }>) {
  proto.getClientRects ??= emptyRects;
  proto.getBoundingClientRect ??= zeroRect;
}
document.elementFromPoint ??= () => null;

function remoteParagraph(doc: Y.Doc, text: string) {
  // Simulates an update arriving from another user.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  other.getXmlFragment(CONTENT_FIELD).push([p]);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), 'remote');
}

describe('Editor (Tiptap ⇄ Y.Doc, ADR-0010 §6)', () => {
  it('renders remote changes to the `content` fragment', async () => {
    const doc = new Y.Doc();
    render(<Editor doc={doc} awareness={new Awareness(doc)} editable userName="Me" />);
    act(() => remoteParagraph(doc, '共同編集のテキスト'));
    await waitFor(() => expect(screen.getByLabelText('本文').textContent).toContain('共同編集のテキスト'));
  });

  it('writes local formatting commands into the shared document', async () => {
    const doc = new Y.Doc();
    act(() => remoteParagraph(doc, 'heading me'));
    render(<Editor doc={doc} awareness={new Awareness(doc)} editable userName="Me" />);
    await waitFor(() => expect(screen.getByLabelText('本文').textContent).toContain('heading me'));
    act(() => screen.getByRole('button', { name: '見出し1' }).click());
    await waitFor(() => expect(doc.getXmlFragment(CONTENT_FIELD).toString()).toContain('<heading level="1">'));
  });

  it('is read-only without a toolbar for viewers', async () => {
    const doc = new Y.Doc();
    render(<Editor doc={doc} awareness={new Awareness(doc)} editable={false} userName="Me" />);
    await waitFor(() => expect(screen.getByLabelText('本文').getAttribute('contenteditable')).toBe('false'));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});
