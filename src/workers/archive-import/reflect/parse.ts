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
 * text that is not one (`{"budget":100}`, `{"type":"text","value":"..."}`) is
 * what the person wrote and is kept as it is. The document is recognised by an
 * editor node in it (a kind an editor writes, with its text or its children);
 * every node in it is then read on its own, so a node Olympus cannot read (an
 * image, a text field that is no text, children that are no list) is counted
 * and never hides the readable ones beside it. A body that is neither text nor
 * an editor document is not read either. The note says so (`unsupported`)
 * instead of being taken for empty.
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

/** The keys an editor node holds its children under. */
const CHILD_KEYS = ['content', 'children'] as const;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * A record that is positively an editor node: a kind an editor writes, with
 * what that kind carries: its text, or a place for children (whatever is in
 * it: a malformed one is read as unsupported, not passed over as no editor).
 * `{"type":"text","value":"..."}` has neither and is somebody's data.
 */
function isEditorNode(value: unknown): boolean {
  if (!isRecord(value) || !isKnownEditorNode(value)) return false;
  return typeof value.text === 'string' || CHILD_KEYS.some((key) => isPresent(value[key]));
}

/**
 * Whether a parsed value is an editor document: an editor node, a list with
 * an editor node in it, or a record whose `content` is such a list. Only the
 * container is recognised here; each node in it is read (or reported) on its
 * own, so one node Olympus does not know never hides the readable ones beside
 * it. Any other value, however much it looks like JSON, is not.
 */
export function isEditorDocument(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isEditorNode);
  if (!isRecord(value)) return false;
  if (isEditorNode(value)) return true;
  return CHILD_KEYS.some((key) => {
    const children = value[key];
    return Array.isArray(children) && children.some(isEditorNode);
  });
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
  let unsupported = 0;
  // Each field a node reads is checked on its own, whatever the node's kind or its other fields are.
  let ownText = '';
  if (typeof node.text === 'string') ownText = node.text;
  else if (isPresent(node.text)) unsupported += 1;
  let childText = '';
  for (const key of CHILD_KEYS) {
    const children = node[key];
    if (!isPresent(children)) continue;
    if (!Array.isArray(children)) {
      unsupported += 1;
      continue;
    }
    const flat = flattenEditorNodes(children, depth);
    unsupported += flat.unsupported;
    childText = childText && flat.text ? `${childText}\n${flat.text}` : childText || flat.text;
  }
  const text = ownText && childText ? `${ownText}\n${childText}` : ownText || childText;
  // A node that says nothing and is not a kind Olympus knows (an image, a mention, an embed) is content it could not read.
  if (text === '' && unsupported === 0 && !isKnownEditorNode(node)) unsupported = 1;
  return { text, unsupported };
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
