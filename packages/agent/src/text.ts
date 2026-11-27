import * as Y from 'yjs';

/**
 * Reading and writing the shared document as plain text (ADR-0015 §2).
 *
 * The Y.Doc root `content` is a Tiptap/ProseMirror tree: top-level elements such as `paragraph`,
 * `heading`, `bulletList`, `blockquote`. The agent writes its replies as `blockquote` blocks, so
 * "who wrote this" is visible in the editor and recoverable from the document itself.
 */

export const CONTENT_FIELD = 'content';
export const AGENT_BLOCK = 'blockquote';

export interface Block {
  /** Top-level node name, e.g. "paragraph", "blockquote". */
  kind: string;
  /** Plain text of the block; list items and nested paragraphs are separated by "\n". */
  text: string;
  /** Written by the agent (a top-level blockquote). */
  fromAgent: boolean;
}

function inlineText(text: Y.XmlText): string {
  return (text.toDelta() as Array<{ insert: unknown }>)
    .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
    .join('');
}

function nodeText(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) return inlineText(node);
  if (!(node instanceof Y.XmlElement)) return '';
  if (node.nodeName === 'hardBreak') return '\n';
  const parts = node.toArray().map(nodeText);
  // Block containers join their children line by line; inline content is concatenated.
  const isContainer = ['blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList'].includes(node.nodeName);
  if (node.nodeName === 'bulletList' || node.nodeName === 'orderedList') {
    return parts.map((p, i) => `${node.nodeName === 'orderedList' ? `${i + 1}.` : '-'} ${p}`).join('\n');
  }
  return isContainer ? parts.join('\n') : parts.join('');
}

export function readBlocks(doc: Y.Doc): Block[] {
  const fragment = doc.getXmlFragment(CONTENT_FIELD);
  return fragment.toArray().map((node) => {
    const kind = node instanceof Y.XmlElement ? node.nodeName : 'text';
    return { kind, text: nodeText(node), fromAgent: kind === AGENT_BLOCK };
  });
}

/** The whole document as text; the agent's own replies are marked with "Claude> ". */
export function renderDocument(blocks: Block[]): string {
  return blocks
    .filter((b) => b.text.trim() !== '')
    .map((b) => (b.fromAgent ? b.text.split('\n').map((l) => `Claude> ${l}`).join('\n') : b.text))
    .join('\n');
}

/** Non-empty blocks written by people (not by the agent). */
export function humanBlocks(blocks: Block[]): string[] {
  return blocks.filter((b) => !b.fromAgent && b.text.trim() !== '').map((b) => b.text);
}

/**
 * What people wrote since `baseline` (both from humanBlocks): everything after the common prefix.
 * The agent's own blocks are excluded on both sides, so inserting replies never shifts the diff.
 */
export function newHumanText(baseline: string[], current: string[]): string {
  let i = 0;
  while (i < baseline.length && i < current.length && baseline[i] === current[i]) i++;
  return current.slice(i).join('\n');
}

/** A paragraph holding `first` (one update, so the paragraph never exists without its text node). */
function paragraphWith(first: string): { paragraph: Y.XmlElement; text: Y.XmlText } {
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText(first);
  paragraph.insert(0, [text]);
  return { paragraph, text };
}

/**
 * Starts a reply at the end of the document: a quote block with one paragraph containing `first`,
 * created in a single transaction. A quote block must never be sent empty: ProseMirror's schema
 * requires content in a blockquote, and y-prosemirror deletes Y nodes that do not fit the schema,
 * so an open editor would remove the reply before its text arrived.
 *
 * If the document ends with an empty paragraph (where a person's cursor usually waits after Enter),
 * the reply goes above it, so the person keeps typing below the reply. Otherwise an empty paragraph
 * is added after the reply for the same reason.
 */
export function startReply(doc: Y.Doc, first: string, origin?: unknown): { quote: Y.XmlElement; text: Y.XmlText } {
  if (first === '') throw new Error('a reply must start with some text');
  const fragment = doc.getXmlFragment(CONTENT_FIELD);
  const quote = new Y.XmlElement(AGENT_BLOCK);
  const { paragraph, text } = paragraphWith(first);
  doc.transact(() => {
    quote.insert(0, [paragraph]);
    const last = fragment.length > 0 ? fragment.get(fragment.length - 1) : null;
    const lastIsEmptyParagraph = last instanceof Y.XmlElement && last.nodeName === 'paragraph' && nodeText(last) === '';
    if (lastIsEmptyParagraph) {
      fragment.insert(fragment.length - 1, [quote]);
    } else {
      fragment.insert(fragment.length, [quote, new Y.XmlElement('paragraph')]);
    }
  }, origin);
  return { quote, text };
}

/** Adds a paragraph containing `first` to a reply block and returns its text node. */
export function addReplyParagraph(doc: Y.Doc, quote: Y.XmlElement, first: string, origin?: unknown): Y.XmlText {
  const { paragraph, text } = paragraphWith(first);
  doc.transact(() => quote.insert(quote.length, [paragraph]), origin);
  return text;
}

/**
 * Splits a reply into paragraphs and each paragraph into typing chunks, so the reply appears
 * gradually (and well under the server's 20 messages/s limit) instead of all at once.
 */
export function typingPlan(reply: string, maxSteps: number): string[][] {
  const paragraphs = reply
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((p) => p.trimEnd())
    .filter((p) => p.trim() !== '');
  const total = paragraphs.reduce((n, p) => n + [...p].length, 0);
  const size = Math.max(1, Math.ceil(total / Math.max(1, maxSteps)));
  return paragraphs.map((p) => {
    const chars = [...p];
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(''));
    return chunks;
  });
}
