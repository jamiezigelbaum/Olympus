/**
 * One note of a Reflect JSON export, as a pure function of its parsed record.
 *
 * What a real export looks like is not published, so this reads liberally: keys
 * in snake_case or camelCase (`created_at`/`createdAt`, `document_json`/
 * `documentJson`), the title as `subject` or `title`, the id as `id` or `uid`,
 * the body as Markdown text or as an editor document, tags as strings or as
 * objects with a name. The body of a real export is believed to be a
 * ProseMirror document written as JSON inside a JSON string (`document_json`,
 * double-encoded); that is parsed and flattened to plain lines.
 *
 * Only a body that is positively an editor document is flattened: JSON-looking
 * text that is not one (`{"budget":100}`) is what the person wrote and is kept
 * as it is. A body that is neither text nor an editor document, and an editor
 * node with no text and no kind Olympus knows, are not read, and the note says
 * so (`unsupported`) instead of being taken for empty.
 */
import { reflectDailyNoteDate } from '../../../core/archive-formats.ts';
import {
  cleanTags,
  firstString,
  idText,
  isRecord,
  isoTime,
  type NoteOutcome,
} from '../notes/note.ts';

/** How deep an editor document is flattened; nothing real nests near this. */
const MAX_EDITOR_DEPTH = 200;

const BLOCK_EDITOR_NODE_TYPES = new Set([
  'blockquote',
  'bulletlist',
  'checklist',
  'checklistitem',
  'codeblock',
  'doc',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'heading',
  'horizontalrule',
  'li',
  'lic',
  'listitem',
  'ol',
  'orderedlist',
  'p',
  'paragraph',
  'table',
  'tablecell',
  'tableheader',
  'tablerow',
  'taskitem',
  'tasklist',
  'ul',
]);

/** Inline nodes that carry their text (`text`) or are a line break (`hardbreak`). */
const INLINE_EDITOR_NODE_TYPES = new Set(['hardbreak', 'text']);

function nodeType(node: unknown): string {
  return isRecord(node) && typeof node.type === 'string' ? node.type.toLowerCase().replace(/[_-]/g, '') : '';
}

function isBlockEditorNode(node: unknown): boolean {
  return BLOCK_EDITOR_NODE_TYPES.has(nodeType(node));
}

function isKnownEditorNode(node: unknown): boolean {
  const type = nodeType(node);
  return BLOCK_EDITOR_NODE_TYPES.has(type) || INLINE_EDITOR_NODE_TYPES.has(type);
}

function editorNodeChildren(node: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(node.content)) return node.content;
  if (Array.isArray(node.children)) return node.children;
  return [];
}

/**
 * Whether a parsed value is an editor document: a node of a kind an editor
 * writes (`doc`, `paragraph`, `text`, ...), a list of them, or a record whose
 * `content` is such a list. Any other value, however much it looks like JSON, is not.
 */
export function isEditorDocument(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isKnownEditorNode);
  if (!isRecord(value)) return false;
  if (isKnownEditorNode(value)) return true;
  const children = editorNodeChildren(value);
  return children.length > 0 && children.every(isKnownEditorNode);
}

/** Text read from part of a note, and how many parts of it could not be. */
interface Flattened {
  text: string;
  unsupported: number;
}

const NOTHING: Flattened = { text: '', unsupported: 0 };

/**
 * Editor-document nodes as plain text: document order kept, inline siblings
 * joined, block-level nodes on their own lines.
 */
function flattenEditorNodes(nodes: readonly unknown[], depth: number): Flattened {
  let text = '';
  let unsupported = 0;
  let previousWasBlock = false;
  let first = true;
  for (const node of nodes) {
    const flat = flattenNode(node, depth + 1);
    unsupported += flat.unsupported;
    if (!flat.text) continue;
    const block = isBlockEditorNode(node);
    if (!first && (block || previousWasBlock)) text += '\n';
    text += flat.text;
    previousWasBlock = block;
    first = false;
  }
  return { text, unsupported };
}

function flattenNode(node: unknown, depth: number): Flattened {
  if (typeof node === 'string') return { text: node, unsupported: 0 };
  if (node === null || node === undefined) return NOTHING;
  if (depth > MAX_EDITOR_DEPTH) return { text: '', unsupported: 1 };
  if (Array.isArray(node)) return flattenEditorNodes(node, depth);
  if (!isRecord(node)) return { text: '', unsupported: 1 };
  const ownText = typeof node.text === 'string' ? node.text : '';
  const children = flattenEditorNodes(editorNodeChildren(node), depth);
  const text = ownText && children.text ? `${ownText}\n${children.text}` : ownText || children.text;
  // A node that says nothing and is not a kind Olympus knows (an image, a mention, an embed) is content it could not read.
  const lost = text === '' && !isKnownEditorNode(node) ? 1 : 0;
  return { text, unsupported: children.unsupported + lost };
}

/** An editor node or document as plain text. */
export function flattenEditorNode(node: unknown, depth = 0): string {
  return flattenNode(node, depth).text;
}

/**
 * A body field read: an editor document (or JSON text holding one) is
 * flattened, any other text is kept as written, nothing is nothing, and any
 * other value is a body Olympus cannot read.
 */
export function readReflectBody(value: unknown): Flattened {
  if (value === undefined || value === null) return NOTHING;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not JSON after all: it is text.
        return { text: value, unsupported: 0 };
      }
      if (isEditorDocument(parsed)) return flattenNode(parsed, 0);
    }
    return { text: value, unsupported: 0 };
  }
  if (isEditorDocument(value)) return flattenNode(value, 0);
  return { text: '', unsupported: 1 };
}

/** A body as text; a body of a shape Olympus cannot read has none. */
export function reflectBodyText(value: unknown): string {
  return readReflectBody(value).text;
}

function reflectTags(value: unknown): string[] {
  const entries: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const tags: string[] = [];
  for (const entry of entries) {
    const tag = typeof entry === 'string' ? firstString(entry) : isRecord(entry) ? firstString(entry.name, entry.tag, entry.title) : undefined;
    if (tag !== undefined) tags.push(tag);
  }
  return cleanTags(tags);
}

/** One record of a Reflect JSON export as a note, an empty note, a note Olympus cannot read, or no note at all. */
export function parseReflectNote(record: unknown): NoteOutcome {
  if (!isRecord(record)) return { kind: 'unreadable' };
  // The first body field that holds any text: an empty `content` does not hide a `document_json`.
  let body = '';
  let unsupported = 0;
  for (const candidate of [record.content, record.body, record.document_json, record.documentJson]) {
    const read = readReflectBody(candidate);
    unsupported += read.unsupported;
    body = read.text.trim();
    if (body !== '') break;
  }
  if (body === '') return unsupported > 0 ? { kind: 'unsupported' } : { kind: 'empty' };
  const key = idText(record.id ?? record.uid);
  const createdAt = isoTime(record.created_at ?? record.createdAt);
  const updatedAt = isoTime(record.updated_at ?? record.updatedAt);
  const title = firstString(record.subject, record.title) ?? '';
  // A daily note is titled for its day; that day comes before the day the file was saved.
  const titleDate = reflectDailyNoteDate(title);
  return {
    kind: 'note',
    note: {
      ...(key !== undefined ? { key } : {}),
      title,
      body,
      tags: reflectTags(record.tags),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(titleDate !== undefined ? { titleDate } : {}),
      ...(unsupported > 0 ? { unsupported } : {}),
    },
  };
}
