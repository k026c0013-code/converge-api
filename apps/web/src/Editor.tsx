import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

/** The Y.Doc root Tiptap binds to; the server only accepts writes here (ADR-0004, ADR-0010). */
export const CONTENT_FIELD = 'content';

interface Props {
  doc: Y.Doc;
  awareness: Awareness;
  editable: boolean;
  /** Shown on our own caret locally; the server overwrites it for everyone else (R-12). */
  userName: string;
}

const button = (active: boolean) => ({
  fontWeight: active ? 700 : 400,
  background: active ? '#dde6ff' : undefined,
});

/** Rich-text editor bound to the shared document (requirements §4.3). */
export function Editor({ doc, awareness, editable, userName }: Props) {
  const editor = useEditor(
    {
      extensions: [
        // Collaboration brings its own undo/redo that only undoes your own changes.
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: doc, field: CONTENT_FIELD }),
        CollaborationCaret.configure({ provider: { awareness }, user: { name: userName, color: '#4363d8' } }),
      ],
      editable,
      editorProps: { attributes: { 'aria-label': '本文', style: 'min-height: 240px; outline: none; padding: 8px' } },
    },
    [doc, awareness],
  );

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            h1: e.isActive('heading', { level: 1 }),
            h2: e.isActive('heading', { level: 2 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
          }
        : null,
  });

  if (!editor) return null;
  const chain = () => editor.chain().focus();

  return (
    <div style={{ border: '1px solid #ccc', borderRadius: 6 }}>
      {editable && (
        <div role="toolbar" aria-label="書式" style={{ display: 'flex', gap: 4, padding: 4, borderBottom: '1px solid #eee', flexWrap: 'wrap' }}>
          <button type="button" style={button(!!active?.h1)} onClick={() => chain().toggleHeading({ level: 1 }).run()}>見出し1</button>
          <button type="button" style={button(!!active?.h2)} onClick={() => chain().toggleHeading({ level: 2 }).run()}>見出し2</button>
          <button type="button" style={button(!!active?.bold)} onClick={() => chain().toggleBold().run()}>太字</button>
          <button type="button" style={button(!!active?.italic)} onClick={() => chain().toggleItalic().run()}>斜体</button>
          <button type="button" style={button(!!active?.bullet)} onClick={() => chain().toggleBulletList().run()}>箇条書き</button>
          <button type="button" style={button(!!active?.ordered)} onClick={() => chain().toggleOrderedList().run()}>番号付き</button>
          <button type="button" onClick={() => chain().undo().run()}>元に戻す</button>
          <button type="button" onClick={() => chain().redo().run()}>やり直す</button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
