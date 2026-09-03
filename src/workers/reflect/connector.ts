// Contract 1 (SourceConnector) adapter for Reflect (reflect.app) — an
// archive-import connector over a Reflect notes export. The export is a JSON
// file (or a zip of JSON files) the user downloads from Reflect; there is no
// live API surface here, so authenticate() proves the archive exists and
// parses instead of issuing broker credentials.
//
// THIN by design: parse the export liberally (snake_case or camelCase keys, a
// top-level array or `{ notes: [...] }`, markdown strings or editor-JSON
// bodies), emit one normalized RawItem per note, and stop. Extraction,
// indexing, and retrieval stay in the shared spine.

import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';

const CONNECTOR_ID = 'reflect';
const NOTE_MIME_TYPE = 'text/markdown';
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 64_000_000;

export type ReflectTrustDomain = 'secure_local' | 'internal';

export interface ReflectSourceConnectorOptions {
  exportPath: string;
  account: string;
  trustDomain?: ReflectTrustDomain;
}

interface ReflectNote {
  id: string;
  title?: string;
  text: string;
  tags: readonly string[];
  createdAt?: string;
  updatedAt?: string;
}

export function createReflectSourceConnector(options: ReflectSourceConnectorOptions): SourceConnector {
  const exportPath = requireNonEmpty(options.exportPath, 'Reflect source connector exportPath');
  const account = requireNonEmpty(options.account, 'Reflect source connector account');
  const trustDomain = options.trustDomain ?? 'secure_local';
  if (trustDomain !== 'secure_local' && trustDomain !== 'internal') {
    throw new Error('Reflect source connector trustDomain must be secure_local or internal.');
  }

  let cachedNotes: readonly ReflectNote[] | undefined;

  const ensureNotes = async (): Promise<readonly ReflectNote[]> => {
    if (cachedNotes) return cachedNotes;
    cachedNotes = await loadReflectExport(exportPath);
    return cachedNotes;
  };

  const toRawItem = (note: ReflectNote, fetchedAt: string): RawItem => ({
    identity: {
      family: 'note',
      provider: CONNECTOR_ID,
      accountScope: account,
      providerItemId: note.id,
      localItemId: `${account}:${note.id}`,
      ...(note.updatedAt ? { sourceVersion: note.updatedAt } : {}),
    },
    mimeType: NOTE_MIME_TYPE,
    content: { kind: 'text', text: note.text },
    metadata: Object.freeze({
      ...(note.title !== undefined ? { title: note.title } : {}),
      tags: note.tags,
      ...(note.createdAt ? { createdAt: note.createdAt } : {}),
      ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}),
    }),
    fetchedAt,
  });

  return {
    id: CONNECTOR_ID,
    family: 'note',

    async authenticate(): Promise<void> {
      await ensureNotes();
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePositiveInteger(listOptions?.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
      const initialOffset = offsetFromCursor(listOptions?.cursor);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const notes = await ensureNotes();
        let offset = Math.min(initialOffset, notes.length);
        let done = false;
        while (!done) {
          const fetchedAt = nowIso();
          const slice = notes.slice(offset, offset + limit);
          offset += slice.length;
          done = offset >= notes.length;
          yield {
            items: slice.map((note) => toRawItem(note, fetchedAt)),
            ...(done ? {} : { nextCursor: String(offset) }),
            done,
          };
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const providerItemId = providerItemIdFromLocalItemId(localItemId, account);
      const notes = await ensureNotes();
      const note = notes.find((candidate) => candidate.id === providerItemId);
      if (!note) {
        throw new Error(`Reflect note ${providerItemId} was not found in the export at ${exportPath}.`);
      }
      return toRawItem(note, nowIso());
    },

    classify(item: RawItem): SourceSensitivity {
      // Archive-wide policy, not per-note: Reflect notes are private writing,
      // so the floor is S4/secure_local. The internal override exists for
      // exports the owner has explicitly marked shareable inside the trust
      // boundary; nothing here may classify below the configured domain.
      void item;
      return trustDomain === 'internal'
        ? buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' })
        : buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

// --- Export parsing ---------------------------------------------------------

async function loadReflectExport(exportPath: string): Promise<readonly ReflectNote[]> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(exportPath));
  } catch (error) {
    throw new Error(`Reflect export file could not be read at ${exportPath}: ${errorMessage(error)}`);
  }
  const texts = isZipArchive(bytes) ? readZipJsonEntryTexts(bytes, exportPath) : [decodeUtf8(bytes)];
  const notes: ReflectNote[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const note of parseReflectExportText(text, exportPath)) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      notes.push(note);
    }
  }
  return notes;
}

function parseReflectExportText(text: string, exportPath: string): ReflectNote[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Reflect export at ${exportPath} is not valid JSON: ${errorMessage(error)}`);
  }
  const rawNotes = extractNotesArray(parsed);
  if (rawNotes === undefined) {
    throw new Error(
      `Reflect export at ${exportPath} must be a top-level array of notes or an object with a "notes" array.`,
    );
  }
  const notes: ReflectNote[] = [];
  for (const raw of rawNotes) {
    const note = normalizeReflectNote(raw);
    if (note) notes.push(note);
  }
  return notes;
}

function extractNotesArray(parsed: unknown): readonly unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.notes)) return parsed.notes;
  return undefined;
}

function normalizeReflectNote(raw: unknown): ReflectNote | undefined {
  if (!isRecord(raw)) return undefined;
  const id = normalizeNoteId(raw.id ?? raw.uid);
  if (id === undefined) return undefined;
  const title = firstString(raw.subject, raw.title);
  const createdAt = normalizeTimestamp(raw.created_at ?? raw.createdAt);
  const updatedAt = normalizeTimestamp(raw.updated_at ?? raw.updatedAt);
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    text: noteBodyText(raw.content ?? raw.body ?? raw.document_json ?? raw.documentJson),
    tags: Object.freeze(normalizeTags(raw.tags)),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function noteBodyText(value: unknown): string {
  if (typeof value === 'string') {
    // Real reflect.app exports double-encode the body: `document_json` is a
    // JSON STRING containing a ProseMirror doc. Parse-then-flatten when the
    // string is such a document; ordinary markdown strings pass through.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) || isRecord(parsed)) return flattenEditorNode(parsed);
      } catch {
        // fall through: treat as plain text
      }
    }
    return value;
  }
  if (Array.isArray(value) || isRecord(value)) return flattenEditorNode(value);
  return '';
}

// --- Editor-JSON flattening (best-effort) -----------------------------------
// Reflect bodies may be ProseMirror-style editor documents instead of
// markdown: nested nodes with `type`, child `content`/`children` arrays, and
// `text` leaves. Flattening keeps document order, concatenates inline
// siblings, and separates block-level nodes with newlines.

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

function flattenEditorNode(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return flattenEditorNodes(node);
  if (!isRecord(node)) return '';
  const ownText = typeof node.text === 'string' ? node.text : '';
  const childText = flattenEditorNodes(editorNodeChildren(node));
  if (ownText && childText) return `${ownText}\n${childText}`;
  return ownText || childText;
}

function flattenEditorNodes(nodes: readonly unknown[]): string {
  let flattened = '';
  let previousWasBlock = false;
  let first = true;
  for (const node of nodes) {
    const text = flattenEditorNode(node);
    if (!text) continue;
    const block = isBlockEditorNode(node);
    if (!first && (block || previousWasBlock)) flattened += '\n';
    flattened += text;
    previousWasBlock = block;
    first = false;
  }
  return flattened;
}

function editorNodeChildren(node: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(node.content)) return node.content;
  if (Array.isArray(node.children)) return node.children;
  return [];
}

function isBlockEditorNode(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const type = typeof node.type === 'string' ? node.type.toLowerCase().replace(/[_-]/g, '') : '';
  return BLOCK_EDITOR_NODE_TYPES.has(type);
}

// --- Zip export support ------------------------------------------------------
// Reflect exports may arrive as a zip of JSON files. This is a minimal,
// self-contained central-directory reader (stored + deflate entries only) so
// the connector does not reach into another worker's extraction internals.

function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

function readZipJsonEntryTexts(bytes: Uint8Array, exportPath: string): string[] {
  const eocdOffset = findZipEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error(`Reflect export zip at ${exportPath} has no central directory; the archive is malformed.`);
  }
  const entryCount = readUint16Le(bytes, eocdOffset + 10);
  let offset = readUint32Le(bytes, eocdOffset + 16);
  const texts: string[] = [];
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (readUint32Le(bytes, offset) !== 0x02014b50) {
      throw new Error(`Reflect export zip at ${exportPath} has a malformed central directory entry.`);
    }
    const flags = readUint16Le(bytes, offset + 8);
    const method = readUint16Le(bytes, offset + 10);
    const compressedSize = readUint32Le(bytes, offset + 20);
    const uncompressedSize = readUint32Le(bytes, offset + 24);
    const nameLength = readUint16Le(bytes, offset + 28);
    const extraLength = readUint16Le(bytes, offset + 30);
    const commentLength = readUint16Le(bytes, offset + 32);
    const localHeaderOffset = readUint32Le(bytes, offset + 42);
    const name = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!isJsonZipEntryName(name)) continue;
    if ((flags & 0x0001) !== 0) {
      throw new Error(`Reflect export zip entry ${name} is encrypted; encrypted archives are not supported.`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`Reflect export zip entry ${name} uses zip64, which is not supported.`);
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`Reflect export zip entry ${name} exceeds the local extraction cap.`);
    }
    texts.push(readZipEntryText(bytes, { method, compressedSize, localHeaderOffset }, name));
  }
  if (texts.length === 0) {
    throw new Error(`Reflect export zip at ${exportPath} contains no JSON entries.`);
  }
  return texts;
}

function isJsonZipEntryName(name: string): boolean {
  if (name.endsWith('/')) return false;
  if (name.startsWith('__MACOSX/')) return false;
  const basename = name.split('/').pop() ?? '';
  if (basename.startsWith('.')) return false;
  return basename.toLowerCase().endsWith('.json');
}

function readZipEntryText(
  bytes: Uint8Array,
  entry: { method: number; compressedSize: number; localHeaderOffset: number },
  name: string,
): string {
  const offset = entry.localHeaderOffset;
  if (readUint32Le(bytes, offset) !== 0x04034b50) {
    throw new Error(`Reflect export zip entry ${name} has a malformed local header.`);
  }
  const nameLength = readUint16Le(bytes, offset + 26);
  const extraLength = readUint16Le(bytes, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return decodeUtf8(compressed);
  if (entry.method === 8) return decodeUtf8(new Uint8Array(inflateRawSync(compressed)));
  throw new Error(`Reflect export zip entry ${name} uses unsupported compression method ${entry.method}.`);
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_558);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32Le(bytes, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

// --- Liberal field normalization ---------------------------------------------

function normalizeNoteId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    const tag = typeof entry === 'string'
      ? firstString(entry)
      : isRecord(entry)
        ? firstString(entry.name, entry.tag, entry.title)
        : undefined;
    if (tag !== undefined) tags.push(tag);
  }
  return tags;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- Small shared helpers -----------------------------------------------------

function offsetFromCursor(cursor: string | undefined): number {
  const trimmed = cursor?.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Reflect source connector cursors are array offsets like "200"; got ${JSON.stringify(cursor)}.`);
  }
  return Number.parseInt(trimmed, 10);
}

function providerItemIdFromLocalItemId(localItemId: string, account: string): string {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length <= prefix.length) {
    throw new Error(`Reflect source connector local item ids look like ${prefix}<note id>.`);
  }
  return localItemId.slice(prefix.length);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.max(1, Math.floor(value));
  return maximum === undefined ? floored : Math.min(floored, maximum);
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}
