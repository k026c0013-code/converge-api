import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { addReplyParagraph, readBlocks, startReply } from '@converge/agent/text';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
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

  it("shows the AI agent's reply as a quote block and its caret with a name label (ADR-0015)", async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    act(() => remoteParagraph(doc, '質問です'));
    render(<Editor doc={doc} awareness={awareness} editable userName="Me" />);

    // The agent edits its own copy, exactly as packages/agent does, and the update arrives remotely.
    const agentDoc = new Y.Doc();
    Y.applyUpdate(agentDoc, Y.encodeStateAsUpdate(doc));
    const { text } = startReply(agentDoc, 'お答えします');
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(doc)), 'remote'));

    await waitFor(() => expect(screen.getByLabelText('本文').querySelector('blockquote')?.textContent).toBe('お答えします'));

    // Its caret, in the format the agent sends (server adds the `user` field).
    const agentAwareness = new Awareness(agentDoc);
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length));
    agentAwareness.setLocalState({ cursor: { anchor: pos, head: pos }, user: { name: 'Claude', color: '#7c5cff' } });
    act(() => applyAwarenessUpdate(awareness, encodeAwarenessUpdate(agentAwareness, [agentDoc.clientID]), 'remote'));

    await waitFor(() => expect(document.querySelector('.collaboration-carets__label')?.textContent).toBe('Claude'));
    expect(document.querySelector('blockquote .collaboration-carets__caret')).not.toBeNull();
    agentAwareness.destroy();
  });

  it('keeps a reply that arrives chunk by chunk while the editor is open (ADR-0015)', async () => {
    const doc = new Y.Doc();
    act(() => remoteParagraph(doc, '質問です'));
    render(<Editor doc={doc} awareness={new Awareness(doc)} editable userName="Me" />);
    await waitFor(() => expect(screen.getByLabelText('本文').textContent).toContain('質問です'));

    // Each agent step is its own update, exactly as the agent sends them.
    const agentDoc = new Y.Doc();
    Y.applyUpdate(agentDoc, Y.encodeStateAsUpdate(doc));
    const relay = () => act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(doc)), 'remote'));
    const { quote, text } = startReply(agentDoc, 'お');
    relay();
    for (const ch of ['答え', 'します']) {
      agentDoc.transact(() => text.insert(text.length, ch));
      relay();
    }
    addReplyParagraph(agentDoc, quote, '二段落目');
    relay();
    await waitFor(() => expect(screen.getByLabelText('本文').querySelector('blockquote')?.textContent).toBe('お答えします二段落目'));
    expect(readBlocks(doc).find((b) => b.fromAgent)?.text).toBe('お答えします\n二段落目'); // nothing was deleted by the editor
  });

  it('is read-only without a toolbar for viewers', async () => {
    const doc = new Y.Doc();
    render(<Editor doc={doc} awareness={new Awareness(doc)} editable={false} userName="Me" />);
    await waitFor(() => expect(screen.getByLabelText('本文').getAttribute('contenteditable')).toBe('false'));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});
