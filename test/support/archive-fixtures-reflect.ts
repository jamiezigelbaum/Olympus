/**
 * Synthetic Reflect exports built in code, for tests and for the release
 * check: a JSON export in either key style, the double-encoded editor
 * document, and a zip of Markdown files. Nothing here is a real export; the
 * shapes are the ones the connector reads (archive-import/reflect), each note
 * carrying a search word of its own so a question can find it.
 */
import { buildZip, type ZipFixtureEntry } from '../helpers/zip-fixture.ts';

export type ReflectKeyStyle = 'snake' | 'camel';

export interface ReflectNoteInput {
  id?: string | number;
  title?: string;
  /** Plain text as the body. */
  body?: string;
  /** The body as an editor document written as JSON inside a string (`document_json`). */
  doc?: readonly string[];
  /** The body as an editor document object. */
  docObject?: readonly string[];
  created?: string | number;
  updated?: string | number;
  tags?: readonly (string | { name: string })[];
}

/** A ProseMirror-style document with one paragraph per line. */
export function editorDocument(lines: readonly string[]): Record<string, unknown> {
  return {
    type: 'doc',
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

/** One record of a Reflect JSON export. */
export function reflectNoteRecord(input: ReflectNoteInput, style: ReflectKeyStyle = 'snake'): Record<string, unknown> {
  const snake = style === 'snake';
  const record: Record<string, unknown> = {};
  if (input.id !== undefined) record.id = input.id;
  if (input.title !== undefined) record[snake ? 'subject' : 'title'] = input.title;
  if (input.body !== undefined) record[snake ? 'content' : 'body'] = input.body;
  if (input.doc) record[snake ? 'document_json' : 'documentJson'] = JSON.stringify(editorDocument(input.doc));
  if (input.docObject) record[snake ? 'document_json' : 'documentJson'] = editorDocument(input.docObject);
  if (input.created !== undefined) record[snake ? 'created_at' : 'createdAt'] = input.created;
  if (input.updated !== undefined) record[snake ? 'updated_at' : 'updatedAt'] = input.updated;
  if (input.tags) record.tags = input.tags;
  return record;
}

export interface ReflectJsonOptions {
  style?: ReflectKeyStyle;
  /** `{"notes": [...]}` instead of a top-level list. */
  wrap?: boolean;
  /** Pretty-printed (multi-line) instead of compact. */
  pretty?: boolean;
}

/** A Reflect JSON export of these notes. Records written by hand go through `JSON.stringify` directly. */
export function reflectJson(notes: readonly ReflectNoteInput[], options: ReflectJsonOptions = {}): string {
  const records = notes.map((note) => reflectNoteRecord(note, options.style ?? 'snake'));
  const document = options.wrap ? { notes: records } : records;
  return options.pretty ? JSON.stringify(document, null, 2) : JSON.stringify(document);
}

/** A numbered run of ordinary notes, each with a word of its own ("harbour 3"). */
export function reflectNotes(count: number, word = 'harbour'): ReflectNoteInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${word}-${index}`,
    title: `Synthetic ${word} note ${index}`,
    body: `The synthetic ${word} log, entry ${index}.`,
    created: `2023-03-${String(1 + index).padStart(2, '0')}T10:00:00Z`,
    updated: `2023-03-${String(1 + index).padStart(2, '0')}T11:00:00Z`,
    tags: index % 2 === 0 ? ['logs'] : [{ name: 'harbour' }],
  }));
}

/** A zip holding the JSON export (and anything else a zip may hold). */
export function reflectJsonZip(
  json: string,
  options: { name?: string; method?: 'stored' | 'deflate'; extra?: readonly ZipFixtureEntry[]; before?: readonly ZipFixtureEntry[] } = {},
): Uint8Array {
  return buildZip([
    ...(options.before ?? []),
    { name: options.name ?? 'reflect-export.json', data: json, method: options.method ?? 'deflate' },
    ...(options.extra ?? []),
  ]);
}

export interface ReflectMarkdownInput {
  title?: string;
  created?: string;
  updated?: string;
  tags?: readonly string[];
  body: string;
  /** No front matter at all. */
  bare?: boolean;
}

/** One Reflect Markdown note: front matter (unless bare), then the text. */
export function reflectMarkdown(input: ReflectMarkdownInput): string {
  if (input.bare) return input.body;
  return [
    '---',
    ...(input.title ? [`title: ${input.title}`] : []),
    ...(input.created ? [`created: ${input.created}`] : []),
    ...(input.updated ? [`updated: ${input.updated}`] : []),
    ...(input.tags ? ['tags:', ...input.tags.map((tag) => `  - ${tag}`)] : []),
    '---',
    '',
    input.body,
  ].join('\n');
}

/** A Reflect Markdown export: a flat zip, one .md file per note. */
export function reflectMarkdownZip(
  files: ReadonlyArray<{ name: string; text: string; method?: 'stored' | 'deflate' }>,
  extra: readonly ZipFixtureEntry[] = [],
): Uint8Array {
  return buildZip([
    ...files.map((file) => ({ name: file.name, data: file.text, method: file.method ?? 'deflate' as const })),
    ...extra,
  ]);
}

/** How Reflect's Markdown export names a daily note. */
export function reflectDailyName(date: Date): string {
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]!;
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][date.getUTCMonth()]!;
  const day = date.getUTCDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][day % 10]!;
  return `${weekday}, ${month} ${day}${suffix}, ${date.getUTCFullYear()}.md`;
}
