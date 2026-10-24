/**
 * One note of a Reflect JSON export, as a pure function of its parsed record.
 *
 * What a real export looks like is not published, so this reads liberally: keys
 * in snake_case or camelCase (`created_at`/`createdAt`, `document_json`/
 * `documentJson`), the title as `subject` or `title`, the id as `id` or `uid`,
 * the body as Markdown text or as an editor document, tags as strings or as
 * objects with a name. The body of a real export is believed to be a
 * ProseMirror document written as JSON inside a JSON string (`document_json`,
 * double-encoded); that is parsed and flattened to plain lines, and any other
 * text passes through as it is.
 */
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
  'heading',
  'horizontalrule',
  'listitem',
  'orderedlist',
  'paragraph',
  'table',
  'tablecell',
  'tableheader',
  'tablerow',
  'taskitem',
  'tasklist',
]);

function isBlockEditorNode(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const type = typeof node.type === 'string' ? node.type.toLowerCase().replace(/[_-]/g, '') : '';
  return BLOCK_EDITOR_NODE_TYPES.has(type);
}

function editorNodeChildren(node: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(node.content)) return node.content;
  if (Array.isArray(node.children)) return node.children;
  return [];
}

/**
 * Editor-document nodes as plain text: document order kept, inline siblings
 * joined, block-level nodes on their own lines.
 */
function flattenEditorNodes(nodes: readonly unknown[], depth: number): string {
  let flattened = '';
  let previousWasBlock = false;
  let first = true;
  for (const node of nodes) {
    const text = flattenEditorNode(node, depth + 1);
    if (!text) continue;
    const block = isBlockEditorNode(node);
    if (!first && (block || previousWasBlock)) flattened += '\n';
    flattened += text;
    previousWasBlock = block;
    first = false;
  }
  return flattened;
}

export function flattenEditorNode(node: unknown, depth = 0): string {
  if (typeof node === 'string') return node;
  if (depth > MAX_EDITOR_DEPTH) return '';
  if (Array.isArray(node)) return flattenEditorNodes(node, depth);
  if (!isRecord(node)) return '';
  const ownText = typeof node.text === 'string' ? node.text : '';
  const childText = flattenEditorNodes(editorNodeChildren(node), depth);
  if (ownText && childText) return `${ownText}\n${childText}`;
  return ownText || childText;
}

/** A body as text: an editor document (or JSON text holding one) is flattened, Markdown text passes through. */
export function reflectBodyText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) || isRecord(parsed)) return flattenEditorNode(parsed);
      } catch {
        // Not JSON after all: it is text.
      }
    }
    return value;
  }
  if (Array.isArray(value) || isRecord(value)) return flattenEditorNode(value);
  return '';
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

/** One record of a Reflect JSON export as a note, an empty note, or no note at all. */
export function parseReflectNote(record: unknown): NoteOutcome {
  if (!isRecord(record)) return { kind: 'unreadable' };
  // The first body field that holds any text: an empty `content` does not hide a `document_json`.
  let body = '';
  for (const candidate of [record.content, record.body, record.document_json, record.documentJson]) {
    body = reflectBodyText(candidate).trim();
    if (body !== '') break;
  }
  if (body === '') return { kind: 'empty' };
  const key = idText(record.id ?? record.uid);
  const createdAt = isoTime(record.created_at ?? record.createdAt);
  const updatedAt = isoTime(record.updated_at ?? record.updatedAt);
  return {
    kind: 'note',
    note: {
      ...(key !== undefined ? { key } : {}),
      title: firstString(record.subject, record.title) ?? '',
      body,
      tags: reflectTags(record.tags),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    },
  };
}
