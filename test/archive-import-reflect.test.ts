// Reflect exports as archive imports: which files are Reflect's (and which
// near-misses are not), how one record or one Markdown file becomes a note,
// paging and resuming through a JSON file or a zip, what is reported when a
// note is empty, unreadable, too big or undated, and a whole import through
// the runtime. Synthetic exports built in code, never a real one.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_LOOK_INCOMPLETE_ADVICE,
  ArchiveImportStoppedError,
  REFLECT_JSON_ARCHIVE_FORMAT,
  REFLECT_MARKDOWN_ARCHIVE_FORMAT,
  ROAM_JSON_ARCHIVE_FORMAT,
  ARCHIVE_FORMATS,
  archiveFormatConnector,
  archiveProbeNames,
  detectArchiveFormat,
  looksLikeReflectJson,
  reflectDailyNoteDate,
  type ArchiveDetection,
  type ArchiveProbe,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveContinuations } from '../src/workers/archive-import/continuation-cache.ts';
import { registerArchiveFormatConnectors } from '../src/workers/archive-import/format-connectors.ts';
import { probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import { NOTE_FINDINGS, NOTE_MAX_RECORD_BYTES, NOTE_MAX_TEXT_CHARS } from '../src/workers/archive-import/notes/note.ts';
import {
  REFLECT_JSON_CURSOR_PREFIX,
  createReflectJsonArchiveConnector,
  createReflectMarkdownArchiveConnector,
} from '../src/workers/archive-import/reflect/connector.ts';
import { parseReflectMarkdown, splitFrontMatter } from '../src/workers/archive-import/reflect/markdown.ts';
import { flattenEditorNode, parseReflectNote, reflectBodyText } from '../src/workers/archive-import/reflect/parse.ts';
import { startArchiveImport } from '../src/workers/archive-import/start.ts';
import { ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';
import { DASHBOARD_ARCHIVE_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { buildZip } from './helpers/zip-fixture.ts';
import {
  reflectDailyName,
  reflectJson,
  reflectJsonZip,
  reflectMarkdown,
  reflectMarkdownZip,
  reflectNoteRecord,
  reflectNotes,
} from './support/archive-fixtures-reflect.ts';
import { roamJson, roamPages } from './support/archive-fixtures-roam.ts';
import {
  importAllNotes,
  importFixture,
  listAll,
  noteChunkTexts,
  noteEmbeddingCount,
  openConnector,
  pullNotes,
  storedNotes,
  tempFolder,
  textOf,
  writeExport,
} from './support/archive-notes-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  archiveContinuations.clear();
  while (cleanups.length) cleanups.pop()!();
});

const SNAKE_FIXTURE = join(import.meta.dir, 'fixtures/archive-import/reflect/export-snake.json');
const CAMEL_FIXTURE = join(import.meta.dir, 'fixtures/archive-import/reflect/export-camel.json');

function detectFile(name: string, content: string | Uint8Array): ArchiveDetection {
  const file = writeExport(cleanups, name, content);
  const root = ScopeRoot.open(file.dir);
  try {
    return detectArchiveFormat(probeArchivePath(root, name, { probeNames: archiveProbeNames() }));
  } finally {
    root.close();
  }
}

function formatOf(detection: ArchiveDetection): string {
  return detection.kind === 'match' ? detection.format.id : detection.kind;
}

type OpenOptions = Parameters<typeof openConnector>[5];

/**
 * A connector over a file written for the test. `again` opens another over the
 * same file, which is what a restarted import does: same files, same manifest,
 * nothing remembered in the process.
 */
function jsonConnector(name: string, content: string | Uint8Array, options: OpenOptions = {}) {
  const file = writeExport(cleanups, name, content);
  const open = (opened: OpenOptions) => openConnector(cleanups, file.dir, [name], REFLECT_JSON_ARCHIVE_FORMAT, createReflectJsonArchiveConnector, opened);
  return { file, ...open(options), again: (opened: OpenOptions = options) => open(opened) };
}

function markdownConnector(name: string, content: Uint8Array, options: OpenOptions = {}) {
  const file = writeExport(cleanups, name, content);
  const open = (opened: OpenOptions) => openConnector(cleanups, file.dir, [name], REFLECT_MARKDOWN_ARCHIVE_FORMAT, createReflectMarkdownArchiveConnector, opened);
  return { file, ...open(options), again: (opened: OpenOptions = options) => open(opened) };
}

const kinds = (findings: ReadonlyArray<{ kind: string; class: string }>) => findings.map((finding) => `${finding.class}:${finding.kind}`);

describe('which files are Reflect exports', () => {
  test('a JSON file in either key style, a list or {notes}, is Reflect JSON', () => {
    expect(formatOf(detectFile('Reflect.json', reflectJson(reflectNotes(3))))).toBe('reflect-json');
    expect(formatOf(detectFile('Reflect.json', reflectJson(reflectNotes(3), { style: 'camel' })))).toBe('reflect-json');
    expect(formatOf(detectFile('Reflect.json', reflectJson(reflectNotes(3), { wrap: true, pretty: true })))).toBe('reflect-json');
    expect(formatOf(detectFile('export.json', readFileSync(SNAKE_FIXTURE)))).toBe('reflect-json');
    expect(formatOf(detectFile('export.json', readFileSync(CAMEL_FIXTURE)))).toBe('reflect-json');
    // The body written as an editor document is Reflect's too.
    expect(formatOf(detectFile('doc.json', reflectJson([{ id: 'a', doc: ['One'], created: '2023-01-01T00:00:00Z' }])))).toBe('reflect-json');
    // A BOM and leading blank lines do not hide it.
    expect(formatOf(detectFile('bom.json', `\uFEFF\n\n${reflectJson(reflectNotes(2))}`))).toBe('reflect-json');
  });

  test('a key inside a note\'s text is not a key of the export', () => {
    // Roam-looking keys in the note text are escaped in JSON, so they are not keys.
    const text = reflectJson([{ id: 'a', title: 'About Roam', body: 'Roam has "children": [] and "create-time": 1 in its JSON.' }], { style: 'camel' });
    expect(text).toContain('\\"children\\"');
    expect(formatOf(detectFile('about-roam.json', text))).toBe('reflect-json');
  });

  test('a zip holding the JSON is Reflect JSON, stored or deflated, with macOS metadata beside it', () => {
    const json = reflectJson(reflectNotes(3));
    for (const method of ['stored', 'deflate'] as const) {
      expect(formatOf(detectFile('Reflect export.zip', reflectJsonZip(json, { method })))).toBe('reflect-json');
    }
    const junk = [
      { name: '__MACOSX/' },
      { name: '__MACOSX/._reflect-export.json', data: 'not json' },
      { name: '.DS_Store', data: 'x' },
    ];
    expect(formatOf(detectFile('Reflect export.zip', reflectJsonZip(json, { extra: junk })))).toBe('reflect-json');
  });

  test('a JSON file far down a big zip is found', () => {
    const media = Array.from({ length: 300 }, (_, index) => ({ name: `media/photo-${index}.png`, data: `png ${index}` }));
    const zip = reflectJsonZip(reflectJson(reflectNotes(2)), { before: media });
    expect(formatOf(detectFile('Everything.zip', zip))).toBe('reflect-json');
  });

  test('a folder with one JSON export in it is that export', () => {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'reflect.json'), reflectJson(reflectNotes(2)));
    writeFileSync(join(dir, 'readme.txt'), 'hello');
    const root = ScopeRoot.open(dir);
    try {
      const detection = detectArchiveFormat(probeArchivePath(root, '', { probeNames: archiveProbeNames() }));
      expect(detection).toMatchObject({ kind: 'match', files: ['reflect.json'] });
      expect(formatOf(detection)).toBe('reflect-json');
      // Two candidates are never guessed between.
      writeFileSync(join(dir, 'second.json'), reflectJson(reflectNotes(2)));
      expect(detectArchiveFormat(probeArchivePath(root, '', { probeNames: archiveProbeNames() })).kind).toBe('none');
    } finally {
      root.close();
    }
  });

  test('a zip of Markdown files is Reflect Markdown when it shows Reflect\'s hand, and not otherwise', () => {
    const body = (text: string) => reflectMarkdown({ body: text, bare: true });
    const daily = reflectDailyName(new Date(Date.UTC(2023, 2, 21)));
    expect(daily).toBe('Tue, March 21st, 2023.md');
    // Named for a daily note.
    expect(formatOf(detectFile('Notes.zip', reflectMarkdownZip([{ name: daily, text: body('A day') }, { name: 'Ideas.md', text: body('x') }])))).toBe('reflect-markdown');
    // Named for Reflect.
    expect(formatOf(detectFile('Reflect Export.zip', reflectMarkdownZip([{ name: 'Ideas.md', text: body('x') }])))).toBe('reflect-markdown');
    // A link to Reflect inside.
    expect(formatOf(detectFile('Notes.zip', reflectMarkdownZip([{ name: 'Ideas.md', text: body('See https://reflect.app/g/graph/note') }])))).toBe('reflect-markdown');
    // Markdown that says nothing of where it came from is not guessed at.
    expect(formatOf(detectFile('Notes.zip', reflectMarkdownZip([{ name: 'Ideas.md', text: body('x') }])))).toBe('none');
    // Roam's Markdown export is a zip of .md files too, and is not Reflect's.
    expect(formatOf(detectFile('Roam-Export-1700000000000.zip', reflectMarkdownZip([{ name: 'October 24th, 2026.md', text: body('- a') }])))).toBe('none');
    expect(formatOf(detectFile('Roam-Export-1700000000000.zip', reflectMarkdownZip([{ name: daily, text: body('- a') }])))).toBe('none');
    // A zip with Reflect JSON in it is the JSON export, whatever else it holds.
    const both = reflectJsonZip(reflectJson(reflectNotes(2)), { extra: [{ name: daily, data: 'x' }] });
    expect(formatOf(detectFile('Reflect export.zip', both))).toBe('reflect-json');
  });

  test('a daily note found only far down a big zip still shows Reflect\'s hand', () => {
    const files = Array.from({ length: 300 }, (_, index) => ({ name: `Note ${index}.md`, text: reflectMarkdown({ body: `body ${index}`, bare: true }) }));
    files.push({ name: reflectDailyName(new Date(Date.UTC(2024, 0, 2))), text: 'The day' });
    expect(formatOf(detectFile('Export.zip', reflectMarkdownZip(files)))).toBe('reflect-markdown');
  });

  test('the other Reflect exports are not read, and the refusal says what is', () => {
    const csv = 'id,subject,created_at\n1,Hello,2023-01-01\n';
    const html = buildZip([{ name: 'index.html', data: '<html></html>' }, { name: 'Ideas.html', data: '<html><body>x</body></html>' }]);
    const roamMarkdown = reflectMarkdownZip([{ name: 'October 24th, 2026.md', text: '- a' }]);
    const edn = '[{:node/title "Page" :block/children [{:block/string "x"}]}]';
    const cases: Array<[string, string | Uint8Array]> = [
      ['Reflect.csv', csv],
      ['Reflect html export.zip', html],
      ['Roam-Export-1700000000000.zip', roamMarkdown],
      ['roam-export.edn', edn],
      ['empty.json', '[]'],
      ['plain.json', '{"a": [1, 2, 3]}'],
    ];
    for (const [name, content] of cases) {
      const detection = detectFile(name, content);
      expect(detection.kind).toBe('none');
      if (detection.kind !== 'none') continue;
      expect(detection.supported).toEqual(expect.arrayContaining([
        REFLECT_JSON_ARCHIVE_FORMAT.label,
        REFLECT_MARKDOWN_ARCHIVE_FORMAT.label,
        ROAM_JSON_ARCHIVE_FORMAT.label,
      ]));
    }
    // Through the start: nothing is recorded, and the answer lists what is imported.
    const base = tempFolder(cleanups);
    const state = new ArchiveImportStateStore({ path: join(base, 'data', 'archive-imports.json') });
    const file = writeExport(cleanups, 'Reflect.csv', csv);
    const refused = startArchiveImport({ state, path: join(file.dir, 'Reflect.csv') });
    expect(refused).toMatchObject({ kind: 'unsupported' });
    expect(state.list()).toEqual([]);
  });

  test('both Reflect formats read as the same app, and say what to choose', () => {
    expect([REFLECT_JSON_ARCHIVE_FORMAT, REFLECT_MARKDOWN_ARCHIVE_FORMAT].map((format) => [format.family, format.provider, format.citationLabel]))
      .toEqual([['note', 'reflect', 'Reflect'], ['note', 'reflect', 'Reflect']]);
    expect(REFLECT_JSON_ARCHIVE_FORMAT.chooseHint).toContain('JSON');
    expect(REFLECT_MARKDOWN_ARCHIVE_FORMAT.chooseHint).toContain('Markdown');
    registerArchiveFormatConnectors();
    expect(archiveFormatConnector('reflect-json')).toBeDefined();
    expect(archiveFormatConnector('reflect-markdown')).toBeDefined();
    expect(looksLikeReflectJson(new TextEncoder().encode('{"notes": [{"subject": "A", "content": "b"}]}'))).toBe(true);
    // An export with no note in it shows nothing to tell it by.
    expect(looksLikeReflectJson(new TextEncoder().encode('{"notes": []}'))).toBe(false);
    expect(looksLikeReflectJson(undefined)).toBe(false);
  });

  test('a daily note\'s file name stands for its day', () => {
    expect(reflectDailyNoteDate('Tue, March 21st, 2023.md')).toBe('2023-03-21T12:00:00.000Z');
    expect(reflectDailyNoteDate('Sat, October 1st, 2022.md')).toBe('2022-10-01T12:00:00.000Z');
    expect(reflectDailyNoteDate('Wed, February 2nd, 2022.md')).toBe('2022-02-02T12:00:00.000Z');
    expect(reflectDailyNoteDate('Thu, June 23rd, 2022.md')).toBe('2022-06-23T12:00:00.000Z');
    expect(reflectDailyNoteDate('Ideas.md')).toBeUndefined();
    expect(reflectDailyNoteDate('October 24th, 2026.md')).toBeUndefined();
    expect(reflectDailyNoteDate('Tue, Februarius 31st, 2023.md')).toBeUndefined();
    expect(reflectDailyNoteDate('Tue, February 31st, 2023.md')).toBeUndefined();
  });
});

describe('one Reflect JSON record', () => {
  test('either key style, the id as a number or text, tags as text or objects', () => {
    const snake = parseReflectNote({ id: 'a', subject: 'Snake', content: 'Body', created_at: '2023-03-01T10:00:00Z', updated_at: 1_677_751_200_000, tags: ['x', { name: 'y' }, { tag: 'z' }, 7, ''] });
    expect(snake).toEqual({
      kind: 'note',
      note: { key: 'a', title: 'Snake', body: 'Body', tags: ['x', 'y', 'z'], createdAt: '2023-03-01T10:00:00.000Z', updatedAt: '2023-03-02T10:00:00.000Z' },
    });
    const camel = parseReflectNote({ uid: 42, title: 'Camel', body: 'Text', createdAt: '2023-03-01', updatedAt: 1_677_751_200 });
    expect(camel).toEqual({
      kind: 'note',
      note: { key: '42', title: 'Camel', body: 'Text', tags: [], createdAt: '2023-03-01T00:00:00.000Z', updatedAt: '2023-03-02T10:00:00.000Z' },
    });
    expect(parseReflectNote({ title: 'Tags as text', body: 'x', tags: '#a, b ,#a' })).toMatchObject({ note: { tags: ['a', 'b'] } });
  });

  test('a body written as an editor document inside a string is flattened to lines', () => {
    const doc = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Plans' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Sail ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'north' }, { type: 'text', text: '.' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rope' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'chart' }] }] }] },
      ],
    });
    const outcome = parseReflectNote({ id: 'd', subject: 'Doc', document_json: doc });
    expect(outcome).toMatchObject({ kind: 'note', note: { body: 'Plans\nSail north.\nrope\nchart' } });
    // The same document as an object, and under the other key.
    expect(parseReflectNote({ id: 'd', documentJson: JSON.parse(doc) })).toMatchObject({ kind: 'note', note: { body: 'Plans\nSail north.\nrope\nchart' } });
    // Text that only looks like JSON passes through.
    expect(reflectBodyText('[draft] not json')).toBe('[draft] not json');
    expect(reflectBodyText('{still text')).toBe('{still text');
    expect(reflectBodyText(7)).toBe('');
  });

  test('an empty content does not hide the document, and no text anywhere is an empty note', () => {
    expect(parseReflectNote({ id: 'a', content: '  ', document_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Real' }] }] }) }))
      .toMatchObject({ kind: 'note', note: { body: 'Real' } });
    expect(parseReflectNote({ id: 'a', subject: 'Title only' })).toEqual({ kind: 'empty' });
    expect(parseReflectNote({ id: 'a', content: '', document_json: JSON.stringify({ type: 'doc', content: [] }) })).toEqual({ kind: 'empty' });
  });

  test('anything that is not a record is not a note', () => {
    for (const value of ['text', 7, null, true, [1, 2]]) expect(parseReflectNote(value)).toEqual({ kind: 'unreadable' });
  });

  test('a document nested absurdly deep is cut, not a stack overflow', () => {
    let node: Record<string, unknown> = { type: 'text', text: 'core' };
    for (let depth = 0; depth < 3000; depth += 1) node = { type: 'paragraph', content: [node] };
    expect(() => flattenEditorNode(node)).not.toThrow();
  });
});

describe('one Reflect Markdown file', () => {
  test('front matter gives the title, dates and tags; the rest is the note', () => {
    const text = reflectMarkdown({ title: 'Sailing', created: '2023-03-21T10:00:00Z', updated: '2023-03-22', tags: ['boats', 'north'], body: 'Out at dawn.\n\nBack by noon.' });
    expect(parseReflectMarkdown(text, 'Sailing.md')).toEqual({
      kind: 'note',
      note: { title: 'Sailing', body: 'Out at dawn.\n\nBack by noon.', tags: ['boats', 'north'], createdAt: '2023-03-21T10:00:00.000Z', updatedAt: '2023-03-22T00:00:00.000Z' },
    });
  });

  test('without front matter the heading is the title, then the file name; a daily note carries its day', () => {
    expect(parseReflectMarkdown('# A heading\n\nThe text.', 'Whatever.md')).toMatchObject({ note: { title: 'A heading', body: 'The text.' } });
    expect(parseReflectMarkdown('Only text.', 'Ideas.md')).toMatchObject({ note: { title: 'Ideas', body: 'Only text.' } });
    const daily = parseReflectMarkdown('Went sailing.', 'Tue, March 21st, 2023.md');
    expect(daily).toMatchObject({ note: { title: 'Tue, March 21st, 2023', titleDate: '2023-03-21T12:00:00.000Z' } });
    expect(parseReflectMarkdown('# C#\n\ntext', 'x.md')).toMatchObject({ note: { title: 'C#' } });
  });

  test('front matter is read liberally: quotes, inline lists, other spellings, CRLF, a BOM', () => {
    const text = '\uFEFF---\r\ntitle: "Quoted: title"\r\ncreatedAt: 2023-03-01\r\ntags: [a, "b c"]\r\n---\r\nBody text\r\n';
    expect(parseReflectMarkdown(text, 'x.md')).toMatchObject({
      note: { title: 'Quoted: title', createdAt: '2023-03-01T00:00:00.000Z', tags: ['a', 'b c'], body: 'Body text' },
    });
    // A block that never closes is text, not front matter.
    expect(splitFrontMatter('---\ntitle: x\nno end').meta.size).toBe(0);
  });

  test('a file with nothing written in it is an empty note', () => {
    expect(parseReflectMarkdown(reflectMarkdown({ title: 'Blank', body: '   ' }), 'Blank.md')).toEqual({ kind: 'empty' });
    expect(parseReflectMarkdown('# Only a heading', 'x.md')).toEqual({ kind: 'empty' });
    expect(parseReflectMarkdown('', 'x.md')).toEqual({ kind: 'empty' });
  });
});

describe('the Reflect JSON connector', () => {
  test('the snake_case export: titles, tags, dates, no prior, and an undated note takes the day the file was saved', async () => {
    const { connector, findings, file } = jsonConnector('export.json', readFileSync(SNAKE_FIXTURE));
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.identity).toMatchObject({ family: 'note', provider: 'reflect', accountScope: 'synthetic-archive' });
      expect(item.identity.localItemId).toBe(`synthetic-archive:${item.identity.providerItemId}`);
      expect(item.metadata.authoredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
    expect(items[0]!.metadata).toMatchObject({
      title: 'Alpha note', tags: ['olympus', 'ideas'], authoredAt: '2026-01-05T08:00:00.000Z', createdAt: '2026-01-05T08:00:00.000Z', updatedAt: '2026-02-01T09:30:00.000Z',
    });
    expect(textOf(items[0]!)).toContain('Markdown body for alpha.');
    expect(textOf(items[0]!)).toContain('Tags: olympus, ideas');
    // The untitled, undated note: the archive file's own date, said so.
    expect(items[2]!.metadata.title).toBe('(untitled)');
    expect(items[2]!.metadata.authoredAt).toBe(new Date(statSync(file.path).mtimeMs).toISOString());
    expect(kinds(findings)).toEqual(['gap:note_date_assumed']);
    // No prior: the tier comes from the settings and the judge.
    const signals = connector.classificationSignals(items[0]!);
    expect(signals.prior).toBeUndefined();
    expect(signals).toEqual({ title: 'Alpha note', labels: ['olympus', 'ideas'] });
    await expect(connector.fetchItem('x')).rejects.toThrow();
  });

  test('the camelCase export: a note with no id, a numeric id and an editor document body are all notes', async () => {
    const { connector, findings } = jsonConnector('export.json', readFileSync(CAMEL_FIXTURE));
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Camel note', 'Editor note', 'Numeric id note', 'No id note']);
    expect(textOf(items[1]!)).toContain('Hello world.\nFirst item\nSecond item');
    expect(items[0]!.metadata.tags).toEqual(['exports', 'reflect']);
    expect(findings.filter((finding) => finding.kind === NOTE_FINDINGS.dateAssumed)).toHaveLength(2);
  });

  test('{notes: [...]} and a top-level list read the same notes', async () => {
    const notes = reflectNotes(4);
    const list = await listAll(jsonConnector('a.json', reflectJson(notes)).connector);
    const wrapped = await listAll(jsonConnector('b.json', reflectJson(notes, { wrap: true, pretty: true })).connector);
    expect(wrapped.items.map((item) => item.metadata.title)).toEqual(list.items.map((item) => item.metadata.title));
    expect(list.items).toHaveLength(4);
  });

  test('two notes with one id are two notes, and the same note listed twice is not one', async () => {
    const note = { id: 'same', title: 'Same', body: 'same text', created: '2023-01-01T00:00:00Z' };
    const { connector, findings } = jsonConnector('dup.json', reflectJson([note, note, { ...note, body: 'other text' }]));
    const { items } = await listAll(connector);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(3);
    expect(findings).toEqual([]);
  });

  test('empty notes are skipped, what is no note is a gap, each where it is', async () => {
    const text = JSON.stringify([
      reflectNoteRecord({ id: 'ok-1', title: 'Fine', body: 'text', created: '2023-01-01T00:00:00Z' }),
      reflectNoteRecord({ id: 'blank', title: 'Blank', body: '   ', created: '2023-01-01T00:00:00Z' }),
      'a stray string',
      7,
      null,
      reflectNoteRecord({ id: 'ok-2', title: 'Also fine', body: 'more', created: '2023-01-02T00:00:00Z' }),
    ]);
    const { connector, findings } = jsonConnector('mixed.json', text);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual(['Fine', 'Also fine']);
    expect(kinds(findings)).toEqual(['skipped:note_empty', 'gap:note_unreadable', 'gap:note_unreadable', 'gap:note_unreadable']);
    // Each finding sits at its record's first byte, in order.
    const offsets = findings.map((finding) => finding.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(text.slice(offsets[0]!).startsWith('{"id":"blank"')).toBe(true);
    expect(text.slice(offsets[1]!).startsWith('"a stray string"')).toBe(true);
    expect(findings.every((finding) => finding.fileIndex === 0)).toBe(true);
  });

  test('a note too big to read is a gap naming its place, and the notes after it are read', async () => {
    const big = JSON.stringify(reflectNoteRecord({ id: 'big', title: 'Big', body: 'x'.repeat(NOTE_MAX_RECORD_BYTES + 1024), created: '2023-01-01T00:00:00Z' }));
    const before = JSON.stringify(reflectNoteRecord({ id: 'a', title: 'Before', body: 'first', created: '2023-01-01T00:00:00Z' }));
    const after = JSON.stringify(reflectNoteRecord({ id: 'z', title: 'After', body: 'last', created: '2023-01-03T00:00:00Z' }));
    const text = `[${before},${big},${after}]`;
    const { connector, findings } = jsonConnector('big.json', text);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual(['Before', 'After']);
    expect(findings).toEqual([{ kind: NOTE_FINDINGS.tooLarge, class: 'gap', fileIndex: 0, offset: before.length + 2 }]);
    expect(text.slice(findings[0]!.offset, findings[0]!.offset + 20)).toBe('{"id":"big","subject');
  });

  test('a note longer than the import keeps is cut to its start and says so', async () => {
    const body = `start ${'y'.repeat(NOTE_MAX_TEXT_CHARS + 500)} end`;
    const { connector, findings } = jsonConnector('long.json', reflectJson([{ id: 'l', title: 'Long', body, created: '2023-01-01T00:00:00Z' }]));
    const { items } = await listAll(connector);
    expect(textOf(items[0]!)).toHaveLength(NOTE_MAX_TEXT_CHARS);
    expect(textOf(items[0]!)).toContain('start yyy');
    expect(kinds(findings)).toEqual([`gap:${ARCHIVE_COMMON_FINDINGS.itemTruncated}`]);
  });

  test('authoredAt is the note\'s own created time, else its edited time, else the day the file was saved', async () => {
    const { connector, findings, file } = jsonConnector('dates.json', JSON.stringify([
      reflectNoteRecord({ id: 'a', title: 'Created', body: 'x', created: '2023-05-01T00:00:00Z', updated: '2023-06-01T00:00:00Z' }),
      reflectNoteRecord({ id: 'b', title: 'Edited', body: 'x', updated: '2023-06-01T00:00:00Z' }),
      reflectNoteRecord({ id: 'c', title: 'Seconds', body: 'x', created: 1_683_000_000 }),
      reflectNoteRecord({ id: 'd', title: 'Neither', body: 'x', created: 'not a date' }),
    ]));
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([
      '2023-05-01T00:00:00.000Z',
      '2023-06-01T00:00:00.000Z',
      '2023-05-02T04:00:00.000Z',
      new Date(statSync(file.path).mtimeMs).toISOString(),
    ]);
    expect(kinds(findings)).toEqual(['gap:note_date_assumed']);
  });

  test('a file cut short keeps the notes before the cut and reports the file as damaged', async () => {
    const text = reflectJson(reflectNotes(5));
    const { connector, findings } = jsonConnector('cut.json', text.slice(0, text.length - 40));
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(4);
    expect(kinds(findings)).toEqual(['gap:file_damaged']);
    // Not JSON at all: nothing is read, and it is said.
    const garbage = jsonConnector('garbage.json', '[{"id": 1,, ]');
    expect(await listAll(garbage.connector)).toMatchObject({ items: [], done: true });
    expect(kinds(garbage.findings)).toEqual(['gap:file_damaged']);
  });

  test('pages resume exactly where they ended, in a plain file and in a stored or a deflated zip', async () => {
    const json = reflectJson(reflectNotes(7), { wrap: true });
    const sources: Array<[string, string | Uint8Array]> = [
      ['plain.json', json],
      ['stored.zip', reflectJsonZip(json, { method: 'stored' })],
      ['deflated.zip', reflectJsonZip(json, { method: 'deflate' })],
    ];
    for (const [name, content] of sources) {
      const whole = jsonConnector(name, content, { pageSize: 2 });
      const all = await listAll(whole.connector);
      expect(all.items).toHaveLength(7);
      expect(all.pages).toEqual([2, 2, 2, 1]);
      expect(all.done).toBe(true);
      expect(all.cursors.every((cursor) => cursor.startsWith(`${REFLECT_JSON_CURSOR_PREFIX}${whole.input.manifestSha256.slice(0, 16)}:`))).toBe(true);
      const ids = all.items.map((item) => item.identity.providerItemId);
      expect(new Set(ids).size).toBe(7);
      // From each cursor, in a connector that has never seen the file (a restart), the rest comes back once.
      for (const [index, cursor] of all.cursors.entries()) {
        archiveContinuations.clear();
        const fresh = whole.again();
        const rest = await listAll(fresh.connector, cursor);
        expect({ name, index, ids: rest.items.map((item) => item.identity.providerItemId) })
          .toEqual({ name, index, ids: ids.slice(Math.min(7, 2 * (index + 1))) });
      }
    }
  });

  test('a deflated member\'s inflater waits between pages and the next page takes it back', async () => {
    const json = reflectJson(reflectNotes(6));
    const { connector, input } = jsonConnector('deflated.zip', reflectJsonZip(json, { method: 'deflate' }), { pageSize: 2 });
    const first = await listAll(connector, undefined, 2);
    expect(first.items).toHaveLength(2);
    expect(first.done).toBe(false);
    expect(archiveContinuations.size).toBe(1);
    const rest = await listAll(connector, first.cursors.at(-1));
    expect(rest.items).toHaveLength(4);
    expect(rest.done).toBe(true);
    expect(input.archiveId).toBe('synthetic-archive');
  });

  test('a stored member keeps its checksum across pages, so damage past the first page is still found', async () => {
    const json = reflectJson(reflectNotes(6));
    const bytes = reflectJsonZip(json, { method: 'stored' });
    const damaged = buildZip([{ name: 'reflect-export.json', data: json, method: 'stored', badCrc: 0x12345678 }]);
    expect(damaged.length).toBeGreaterThan(0);
    const { connector, findings } = jsonConnector('stored.zip', damaged, { pageSize: 2 });
    const first = await listAll(connector, undefined, 2);
    const cursor = first.cursors.at(-1)!;
    expect(cursor.split(':')[5]).not.toBe('');
    const rest = await listAll(connector, cursor);
    expect(rest.items).toHaveLength(4);
    expect(kinds(findings)).toEqual(['gap:file_damaged']);
    // The same bytes with the right checksum report nothing.
    const clean = jsonConnector('clean.zip', bytes, { pageSize: 2 });
    await listAll(clean.connector);
    expect(clean.findings).toEqual([]);
  });

  test('a zip\'s other files are counted, its macOS metadata is not, and JSON members are read in order', async () => {
    const zip = buildZip([
      { name: 'images/' },
      { name: 'images/a.png', data: 'png a' },
      { name: 'images/b.png', data: 'png b' },
      { name: '__MACOSX/._first.json', data: 'junk' },
      { name: 'first.json', data: reflectJson(reflectNotes(2, 'first')), method: 'deflate' },
      { name: 'second.json', data: reflectJson(reflectNotes(2, 'second')), method: 'stored' },
      { name: '.DS_Store', data: 'junk' },
    ]);
    const opened = jsonConnector('Reflect.zip', zip, { pageSize: 3 });
    const { connector, findings } = opened;
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual([
      'Synthetic first note 0', 'Synthetic first note 1', 'Synthetic second note 0', 'Synthetic second note 1',
    ]);
    expect(findings).toEqual([expect.objectContaining({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap', count: 2 })]);
    // Resuming into the second JSON member reads it from where it left off.
    const paged = await listAll(connector, undefined, 3);
    archiveContinuations.clear();
    const rest = await listAll(opened.again().connector, paged.cursors.at(-1));
    expect([...paged.items, ...rest.items].map((item) => item.identity.providerItemId)).toEqual(items.map((item) => item.identity.providerItemId));
  });

  test('a zip member that cannot be read is reported as damaged and the rest of the zip is read', async () => {
    const zip = buildZip([
      { name: 'locked.json', data: reflectJson(reflectNotes(2, 'locked')), encrypted: true },
      { name: 'open.json', data: reflectJson(reflectNotes(2, 'open')) },
    ]);
    const { connector, findings } = jsonConnector('Reflect.zip', zip);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Synthetic open note 0', 'Synthetic open note 1']);
    expect(kinds(findings)).toEqual(['gap:file_damaged']);
  });

  test('a resume point belongs to these files only, and a made-up one stops the import', async () => {
    const { connector } = jsonConnector('a.json', reflectJson(reflectNotes(5)), { pageSize: 2 });
    const all = await listAll(connector);
    const other = jsonConnector('a.json', reflectJson(reflectNotes(5)), { manifestSha256: 'f'.repeat(64) });
    await expect(listAll(other.connector, all.cursors[0])).rejects.toMatchObject({ code: 'resume_point_invalid' });
    const prefix = all.cursors[0]!.split(':').slice(0, 2).join(':');
    for (const made of [`${prefix}:5:-1:0::`, `${prefix}:0:-1:7:x:`, `${prefix}:0:-1:7::bm90IGpzb24`, `${prefix}:garbage`, `${prefix}:0:-1:0::e30`]) {
      await expect(listAll(connector, made)).rejects.toBeInstanceOf(ArchiveImportStoppedError);
    }
    // A point that names a spot in the file where no note ends is refused by the reader.
    const real = all.cursors[0]!.split(':');
    real[4] = String(Number(real[4]) + 1);
    await expect(listAll(connector, real.join(':'))).rejects.toBeInstanceOf(ArchiveImportStoppedError);
  });

  test('stopping between notes leaves a resume point at the next one', async () => {
    const notes = reflectNotes(5);
    let calls = 0;
    // Asked before each note and with each chunk read, so the stop lands wherever the count does.
    const opened = jsonConnector('a.json', reflectJson(notes), { shouldContinue: () => ++calls <= 3 });
    const first = await listAll(opened.connector);
    expect(first.done).toBe(false);
    const taken = first.items.length;
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(5);
    const rest = await listAll(opened.again({}).connector, first.cursors.at(-1));
    expect(rest.items.map((item) => item.metadata.title)).toEqual(notes.slice(taken).map((note) => note.title));
  });

  test('a file that changed or went missing stops the listing instead of reading other bytes', async () => {
    const { connector, file } = jsonConnector('a.json', reflectJson(reflectNotes(3)), { pageSize: 1 });
    const first = await listAll(connector, undefined, 1);
    expect(first.items).toHaveLength(1);
    appendFileSync(file.path, ' ');
    await expect(listAll(connector, first.cursors.at(-1))).rejects.toMatchObject({ code: 'file_changed', relPath: 'a.json' });
    unlinkSync(file.path);
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_missing', relPath: 'a.json' });
  });

  test('progress is told before each page, forward, inside the file', async () => {
    const json = reflectJson(reflectNotes(6));
    for (const content of [json, reflectJsonZip(json, { method: 'deflate' })]) {
      const { connector, positions, file } = jsonConnector(content === json ? 'p.json' : 'p.zip', content, { pageSize: 2 });
      await listAll(connector);
      expect(positions.length).toBeGreaterThanOrEqual(2);
      const size = statSync(file.path).size;
      for (const position of positions) {
        expect(position.fileIndex).toBe(0);
        expect(position.offset).toBeGreaterThan(0);
        expect(position.offset).toBeLessThanOrEqual(size);
      }
      expect(positions.map((position) => position.offset)).toEqual([...positions.map((position) => position.offset)].sort((a, b) => a - b));
    }
  });
});

describe('the Reflect Markdown connector', () => {
  const files = [
    { name: reflectDailyName(new Date(Date.UTC(2023, 2, 21))), text: 'Went sailing with [[Sam]].' },
    { name: 'Sailing.md', text: reflectMarkdown({ title: 'Sailing plans', created: '2023-04-02T08:00:00Z', tags: ['boats'], body: 'Chart the north coast.' }) },
    { name: 'Blank.md', text: reflectMarkdown({ title: 'Blank', body: ' ' }) },
    { name: 'Undated.md', text: '# Undated idea\n\nNo front matter, no date.' },
  ];

  test('one note per Markdown file: front matter, the daily note\'s day, the undated one dated by the file', async () => {
    const { connector, findings, file } = markdownConnector('Reflect Export.zip', reflectMarkdownZip(files));
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual(['Tue, March 21st, 2023', 'Sailing plans', 'Undated idea']);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([
      '2023-03-21T12:00:00.000Z',
      '2023-04-02T08:00:00.000Z',
      new Date(statSync(file.path).mtimeMs).toISOString(),
    ]);
    expect(items[1]!.metadata.tags).toEqual(['boats']);
    expect(textOf(items[0]!)).toContain('Went sailing with [[Sam]].');
    for (const item of items) expect(item.identity).toMatchObject({ family: 'note', provider: 'reflect' });
    expect(kinds(findings)).toEqual(['skipped:note_empty', 'gap:note_date_assumed']);
    expect(connector.classificationSignals(items[1]!).prior).toBeUndefined();
  });

  test('pages resume at the next member, with or without the inflater still parked', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `Note ${index}.md`, text: reflectMarkdown({ title: `Note ${index}`, created: `2023-01-0${index + 1}T00:00:00Z`, body: `Body ${index}` }) }));
    const zip = reflectMarkdownZip(many, [{ name: 'attachments/pic.png', data: 'png' }, { name: '__MACOSX/._Note 0.md', data: 'junk' }]);
    const whole = markdownConnector('Reflect Export.zip', zip, { pageSize: 4 });
    const all = await listAll(whole.connector);
    expect(all.items).toHaveLength(9);
    expect(all.pages).toEqual([4, 4, 1]);
    expect(kinds(whole.findings)).toEqual([`gap:${ARCHIVE_COMMON_FINDINGS.mediaNotImported}`]);
    expect(whole.findings[0]!.count).toBe(1);
    const ids = all.items.map((item) => item.identity.providerItemId);
    for (const [index, cursor] of all.cursors.entries()) {
      const fresh = whole.again();
      const rest = await listAll(fresh.connector, cursor);
      expect(rest.items.map((item) => item.identity.providerItemId)).toEqual(ids.slice(Math.min(9, 4 * (index + 1))));
    }
  });

  test('a note read with a wrong checksum is kept and the file is reported damaged; one that cannot be read is a gap', async () => {
    const zip = buildZip([
      { name: 'Good.md', data: 'Good text', method: 'deflate' },
      { name: 'Bad checksum.md', data: 'Text under a wrong checksum', method: 'stored', badCrc: 1 },
      { name: 'Locked.md', data: 'secret', encrypted: true },
      { name: 'Reflect.md', data: 'Also fine', method: 'stored' },
    ]);
    const { connector, findings } = markdownConnector('Reflect Export.zip', zip);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Good', 'Bad checksum', 'Reflect']);
    expect(kinds(findings)).toEqual([
      'gap:note_date_assumed', 'gap:note_date_assumed', 'gap:file_damaged', 'gap:note_unreadable', 'gap:note_date_assumed',
    ]);
  });

  test('a Markdown file longer than the import keeps is cut to its start and says so', async () => {
    const huge = `start ${'z'.repeat(NOTE_MAX_TEXT_CHARS * 4 + 100)} end`;
    const zip = reflectMarkdownZip([{ name: 'Huge.md', text: huge }, { name: 'After.md', text: 'Still read.' }]);
    const { connector, findings } = markdownConnector('Reflect Export.zip', zip);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Huge', 'After']);
    expect(textOf(items[0]!).length).toBeLessThanOrEqual(NOTE_MAX_TEXT_CHARS);
    expect(kinds(findings)).toContain(`gap:${ARCHIVE_COMMON_FINDINGS.itemTruncated}`);
  });

  test('a file that is not a zip holds no Markdown notes, and a broken zip is said to be damaged', async () => {
    const plain = markdownConnector('Reflect Export.zip', new TextEncoder().encode('not a zip at all'));
    expect(await listAll(plain.connector)).toMatchObject({ items: [], done: true });
    expect(kinds(plain.findings)).toEqual(['gap:file_damaged']);
    const zip = reflectMarkdownZip([{ name: 'A.md', text: 'x' }]);
    const broken = markdownConnector('Reflect Export.zip', zip.slice(0, zip.length - 8));
    expect(await listAll(broken.connector)).toMatchObject({ items: [], done: true });
    expect(kinds(broken.findings)).toEqual(['gap:file_damaged']);
  });
});

describe('every finding a notes archive reports has a sentence of its own', () => {
  test('one and many, never the catch-all', () => {
    const gaps = DASHBOARD_ARCHIVE_COPY.gaps as Record<string, { one: string; many: string } | undefined>;
    for (const kind of Object.values(NOTE_FINDINGS)) {
      expect(gaps[kind]).toBeDefined();
      expect(gaps[kind]!.many).toContain('{n}');
    }
  });
});

describe('a Reflect import through the runtime', () => {
  test('the notes are indexed once with Reflect as their source, dated, and held Private until judged', async () => {
    const f = importFixture(cleanups);
    const notes = [
      ...reflectNotes(4),
      { id: 'blank', title: 'Blank', body: ' ', created: '2023-03-20T10:00:00Z' },
    ];
    const started = f.start('Reflect.json', reflectJson(notes));
    expect(started.format).toBe('reflect-json');
    await expect(pullNotes(f.runtime, started.archiveId, { pageSize: 2, maxItems: 2 })).resolves.toMatchObject({ continueSoon: true });
    const last = await importAllNotes(f.runtime, started.archiveId, { pageSize: 2, maxItems: 2 });
    expect(last.receipt.counts.traversal_complete).toBe(1);
    const record = f.runtime.state.get(started.archiveId)!;
    expect(record).toMatchObject({ status: 'imported', family: 'note', provider: 'reflect', format: 'reflect-json' });
    expect(record.findings.skipped).toEqual({ note_empty: 1 });
    expect(record.findings.gaps).toEqual({});
    expect(record.date_range).toEqual({ earliest: '2023-03-01T10:00:00.000Z', latest: '2023-03-04T10:00:00.000Z' });
    const rows = storedNotes(f.env, started.archiveId);
    expect(new Set(rows.map((row) => row.providerItemId)).size).toBe(4);
    expect(new Set(rows.map((row) => `${row.provider}/${row.family}`))).toEqual(new Set(['reflect/note']));
    // With no judge running, the content of every note is in the Private store and nowhere else.
    const held = noteChunkTexts(f.env, 'secure_local', started.archiveId);
    expect(held.filter((text) => text.includes('harbour log')).length).toBeGreaterThanOrEqual(4);
    for (const domain of ['internal', 'public_safe'] as const) {
      expect(noteChunkTexts(f.env, domain, started.archiveId)).toEqual([]);
      expect(noteEmbeddingCount(f.env, domain)).toBe(0);
    }
  });

  test('a changed file stops the import visibly, and a Markdown zip imports like the JSON', async () => {
    const f = importFixture(cleanups);
    const stopped = f.start('Changing.json', reflectJson(reflectNotes(4)));
    await pullNotes(f.runtime, stopped.archiveId, { pageSize: 1, maxItems: 1 });
    appendFileSync(stopped.path, ' ');
    const outcome = await pullNotes(f.runtime, stopped.archiveId);
    expect(outcome.receipt.counts.import_stopped).toBe(1);
    expect(f.runtime.state.get(stopped.archiveId)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: 'Changing.json' } });

    const markdown = f.start('Reflect Export.zip', reflectMarkdownZip([
      { name: reflectDailyName(new Date(Date.UTC(2023, 2, 21))), text: 'Sailing day' },
      { name: 'Ideas.md', text: reflectMarkdown({ title: 'Ideas', created: '2023-04-01T00:00:00Z', body: 'Lanterns' }) },
    ]));
    expect(markdown.format).toBe('reflect-markdown');
    await importAllNotes(f.runtime, markdown.archiveId);
    expect(f.runtime.state.get(markdown.archiveId)).toMatchObject({ status: 'imported', date_range: { earliest: '2023-03-21T12:00:00.000Z', latest: '2023-04-01T00:00:00.000Z' } });
    expect(new Set(storedNotes(f.env, markdown.archiveId).map((row) => row.providerItemId)).size).toBe(2);
  });

  test('a restart in the middle counts nothing twice', async () => {
    const f = importFixture(cleanups);
    const notes = [...reflectNotes(5), { id: 'blank', title: 'Blank', body: '', created: '2023-03-20T10:00:00Z' }, ...reflectNotes(3, 'later')];
    const started = f.start('Reflect.json', reflectJson(notes));
    let calls = 0;
    // The first pass dies after its first page; the listing was already recorded.
    await expect(pullNotes(f.runtime, started.archiveId, {
      pageSize: 3,
      connectorFactory: () => (input) => {
        const real = createReflectJsonArchiveConnector(input);
        return {
          ...real,
          listItems(options) {
            return (async function* () {
              for await (const page of real.listItems(options)) {
                calls += 1;
                if (calls > 2) throw new Error('synthetic crash');
                yield page;
              }
            })();
          },
        };
      },
    })).rejects.toThrow('synthetic crash');
    archiveContinuations.clear();
    await importAllNotes(f.runtime, started.archiveId, { pageSize: 3, maxItems: 3 });
    const record = f.runtime.state.get(started.archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.skipped).toEqual({ note_empty: 1 });
    expect(new Set(storedNotes(f.env, started.archiveId).map((row) => row.providerItemId)).size).toBe(8);
  });
});

// Reading roamJson / roamPages here keeps the two note families' fixtures honest against each other.
describe('Reflect and Roam files are told apart', () => {
  test('a Roam export is not Reflect\'s, and Reflect\'s is not Roam\'s', () => {
    expect(formatOf(detectFile('roam.json', roamJson(roamPages(3))))).toBe('roam-json');
    expect(formatOf(detectFile('reflect.json', reflectJson(reflectNotes(3))))).toBe('reflect-json');
  });
});

// --- Review round 1: what a note is read as, and what is said when it is not read ------------

describe('a Reflect body is read as what it is', () => {
  test('text that only looks like JSON is the note, kept as written', () => {
    for (const body of ['{"budget":100}', '[1, 2, 3]', '{"type":"order","content":[{"sku":"x"}]}', '[{"name":"a"}]']) {
      expect(parseReflectNote({ id: 'a', subject: 'Data', content: body })).toMatchObject({ kind: 'note', note: { body } });
    }
    // The same text in a JSON-in-a-string `document_json` field is no more an editor document.
    expect(parseReflectNote({ id: 'a', document_json: '{"budget":100}' })).toMatchObject({ kind: 'note', note: { body: '{"budget":100}' } });
  });

  test('content Olympus cannot read is not an empty note, and unreadable parts are counted beside the text that is read', () => {
    const image = JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src: 'a.png' } }] });
    expect(parseReflectNote({ id: 'a', document_json: image })).toEqual({ kind: 'unsupported' });
    expect(parseReflectNote({ id: 'a', content: 7 })).toEqual({ kind: 'unsupported' });
    expect(parseReflectNote({ id: 'a', content: { budget: 100 } })).toEqual({ kind: 'unsupported' });
    // Nothing written is a different thing from nothing read.
    expect(parseReflectNote({ id: 'a', subject: 'Title only', content: null })).toEqual({ kind: 'empty' });
    expect(parseReflectNote({ id: 'a', document_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }) })).toEqual({ kind: 'empty' });
    const mixed = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] }, { type: 'image', attrs: { src: 'a.png' } }],
    });
    expect(parseReflectNote({ id: 'a', document_json: mixed })).toMatchObject({ kind: 'note', note: { body: 'Kept', unsupported: 1 } });
  });

  test('a daily note titled for its day is dated by it, in the JSON export too', async () => {
    expect(parseReflectNote({ id: 'a', subject: 'Tue, March 21st, 2023', content: 'Went sailing.' }))
      .toMatchObject({ kind: 'note', note: { titleDate: '2023-03-21T12:00:00.000Z' } });
    expect(parseReflectNote({ id: 'a', subject: 'Sailing', content: 'x' })).toMatchObject({ kind: 'note', note: { title: 'Sailing' } });
    const plain = parseReflectNote({ id: 'a', subject: 'Sailing', content: 'x' });
    expect(plain.kind === 'note' && plain.note.titleDate).toBeFalsy();
    const text = JSON.stringify([
      { id: 'd1', subject: 'Tue, March 21st, 2023', content: 'Went sailing.' },
      { id: 'd2', subject: 'Undated', content: 'No date at all.' },
      { id: 'd3', subject: 'Wed, March 22nd, 2023', content: 'Dated by title, edited later.', updated_at: '2023-04-01T00:00:00Z' },
    ]);
    const { connector, findings, file } = jsonConnector('a.json', text);
    const { items } = await listAll(connector);
    const savedDay = new Date(statSync(file.path).mtimeMs).toISOString().slice(0, 10);
    expect(items.map((item) => String(item.metadata.authoredAt).slice(0, 10))).toEqual(['2023-03-21', savedDay, '2023-04-01']);
    // Only the note nothing dates is reported as assumed.
    expect(findings.filter((finding) => finding.kind === 'note_date_assumed')).toHaveLength(1);
  });
});

describe('text between two rules is the note, not front matter', () => {
  test('a block that is not metadata stays in the note', () => {
    const intro = parseReflectMarkdown('---\nSome intro text\n---\nThe body.', 'x.md');
    expect(intro).toMatchObject({ kind: 'note', note: { body: '---\nSome intro text\n---\nThe body.' } });
    // Lines that look like pairs, none of them a key Reflect writes.
    const pairs = splitFrontMatter('---\nTodo: buy milk\nNotes: call Bob\n---\nrest');
    expect(pairs.meta.size).toBe(0);
    expect(pairs.body).toBe('---\nTodo: buy milk\nNotes: call Bob\n---\nrest');
    // One prose line among the pairs makes it text.
    const mixed = splitFrontMatter('---\ntitle: T\nthen I went home\n---\nrest');
    expect(mixed.meta.size).toBe(0);
    expect(mixed.body).toContain('then I went home');
    // Real front matter is still metadata.
    expect(splitFrontMatter('---\ntitle: T\ntags:\n  - a\n# a comment\n\n---\nrest')).toMatchObject({ body: 'rest' });
  });
});

describe('a Reflect JSON file is told by its structure', () => {
  test('one key of the kind, or a key in the wrong place, is not a Reflect export', () => {
    for (const [name, text] of [
      ['single.json', '[{"content":"hello"}]'],
      ['comments.json', '[{"id":1,"content":"hello","author":"bob"}]'],
      ['wrapped.json', '{"notes":[{"content":"x"}]}'],
      ['tree.json', '[{"children":[]}]'],
      ['nested.json', '{"data":[{"subject":"a","content":"b"}]}'],
      ['both.json', '[{"subject":"a","content":"b"},{"title":"p","create-time":1}]'],
    ] as const) {
      expect({ name, format: formatOf(detectFile(name, text)) }).toEqual({ name, format: 'none' });
    }
    // A title or a date with what the note says is a note.
    expect(formatOf(detectFile('titled.json', '[{"subject":"a","content":"b"}]'))).toBe('reflect-json');
    expect(formatOf(detectFile('dated.json', '[{"content":"b","created_at":"2023-01-01"}]'))).toBe('reflect-json');
    expect(formatOf(detectFile('wrapped.json', '{"version":2,"notes":[{"title":"a","body":"b"}]}'))).toBe('reflect-json');
  });

  test('a zip is Reflect JSON for the file that is, never for every JSON file in it, and a zip of two apps is refused', async () => {
    const zip = reflectJsonZip(reflectJson(reflectNotes(2)), {
      extra: [
        { name: 'comments.json', data: JSON.stringify([{ id: 1, content: 'a comment, not a note' }]) },
        { name: 'package.json', data: '{"name": "x"}' },
      ],
    });
    expect(formatOf(detectFile('Reflect export.zip', zip))).toBe('reflect-json');
    const { connector, findings } = jsonConnector('Reflect export.zip', zip);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    expect(items.map((item) => textOf(item)).join('\n')).not.toContain('a comment, not a note');
    expect(kinds(findings)).toEqual(['gap:section_not_imported', 'gap:section_not_imported']);
    const both = buildZip([
      { name: 'reflect.json', data: reflectJson(reflectNotes(2)) },
      { name: 'roam.json', data: roamJson(roamPages(2)) },
    ]);
    expect(formatOf(detectFile('Both.zip', both))).toBe('none');
  });
});

describe('the Reflect connector says what it could not read', () => {
  test('content of a kind it has no rule for is a gap at its note: the note is kept when it has other text, left out when it has none', async () => {
    const image = JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src: 'a.png' } }] });
    const mixed = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept words' }] }, { type: 'image', attrs: {} }],
    });
    const text = JSON.stringify([
      { id: 'a', subject: 'Only an image', created_at: '2023-03-01T00:00:00Z', document_json: image },
      { id: 'b', subject: 'Words and an image', created_at: '2023-03-02T00:00:00Z', document_json: mixed },
      { id: 'c', subject: 'Plain', created_at: '2023-03-03T00:00:00Z', content: 'Plain words' },
      { id: 'd', subject: 'Nothing', created_at: '2023-03-04T00:00:00Z', content: '' },
    ]);
    const { connector, findings } = jsonConnector('a.json', text);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Words and an image', 'Plain']);
    expect(kinds(findings)).toEqual(['gap:note_content_unsupported', 'gap:note_content_unsupported', 'skipped:note_empty']);
  });

  test('a document without the list of notes is reported, an export with an empty list is just empty', async () => {
    for (const [what, text] of [
      ['no list', '{"meta": {"version": 1}}'],
      ['a number', '{"notes": 5}'],
      ['a record', JSON.stringify({ notes: { a: { id: 'x', subject: 'S', content: 'C' } } })],
      ['text', '{"notes": "none yet"}'],
    ] as const) {
      const { connector, findings } = jsonConnector('a.json', text);
      const result = await listAll(connector);
      expect({ what, items: result.items.length, done: result.done, findings: kinds(findings) })
        .toEqual({ what, items: 0, done: true, findings: ['gap:section_not_imported'] });
    }
    const empty = jsonConnector('b.json', '{"notes": [], "version": 2}');
    expect(await listAll(empty.connector)).toMatchObject({ items: [], done: true });
    expect(empty.findings).toEqual([]);
    const bare = jsonConnector('c.json', '[]');
    expect(await listAll(bare.connector)).toMatchObject({ items: [], done: true });
    expect(bare.findings).toEqual([]);
  });

  test('a zip member that is not an export is reported where it is, and the files around it are read', async () => {
    const good = reflectJson(reflectNotes(2), { wrap: true });
    const noList = '{"notes_v2": [], "subject": "a", "content": "b"}';
    const zip = buildZip([
      { name: 'one.json', data: good },
      { name: 'two.json', data: noList },
      { name: 'three.json', data: reflectJson(reflectNotes(1, 'dock'), { wrap: true }) },
    ]);
    const { connector, findings } = jsonConnector('Reflect export.zip', zip);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(3);
    expect(kinds(findings)).toEqual(['gap:section_not_imported']);
  });
});

describe('the Reflect connector holds its bounds while it reads', () => {
  test('the byte budget stops a listing at a note, not after the whole file, and the next listing goes on from there', async () => {
    const notes = reflectNotes(5);
    const opened = jsonConnector('a.json', reflectJson(notes), { maxBytesPerListing: 50 });
    const first = await listAll(opened.connector);
    expect(first.items).toHaveLength(1);
    expect(first.done).toBe(false);
    const titles = first.items.map((item) => item.metadata.title);
    let cursor = first.cursors.at(-1);
    for (let listing = 0; listing < 10 && cursor; listing += 1) {
      const next = await listAll(opened.again().connector, cursor);
      expect(next.items.length).toBeLessThanOrEqual(1);
      titles.push(...next.items.map((item) => item.metadata.title));
      if (next.done) break;
      cursor = next.cursors.at(-1);
    }
    expect(titles).toEqual(notes.map((note) => note.title));
  });

  test('the byte budget holds between Markdown members too', async () => {
    const files = Array.from({ length: 4 }, (_, index) => ({
      name: `Note ${index}.md`,
      text: reflectMarkdown({ title: `Note ${index}`, body: `word${index} ${'x'.repeat(2000)}` }),
    }));
    const opened = markdownConnector('Reflect.zip', reflectMarkdownZip(files), { maxBytesPerListing: 3000 });
    const first = await listAll(opened.connector);
    expect(first.items).toHaveLength(1);
    expect(first.done).toBe(false);
    const titles = first.items.map((item) => item.metadata.title);
    let cursor = first.cursors.at(-1);
    for (let listing = 0; listing < 10 && cursor; listing += 1) {
      const next = await listAll(opened.again().connector, cursor);
      titles.push(...next.items.map((item) => item.metadata.title));
      if (next.done) break;
      cursor = next.cursors.at(-1);
    }
    expect(titles).toEqual(files.map((_, index) => `Note ${index}`));
  });

  test('an import told to stop leaves a long Markdown member part-way, and reads it again from its start', async () => {
    const big = 'word '.repeat(1_000_000);
    const zip = reflectMarkdownZip([
      { name: 'Big.md', text: reflectMarkdown({ title: 'Big', body: big }), method: 'stored' },
      { name: 'Small.md', text: reflectMarkdown({ title: 'Small', body: 'little' }) },
    ]);
    let calls = 0;
    const opened = markdownConnector('Reflect.zip', zip, { shouldContinue: () => ++calls <= 3 });
    const first = await listAll(opened.connector);
    expect(first).toMatchObject({ items: [], done: false });
    const all = await listAll(opened.again({}).connector, first.cursors.at(-1));
    expect(all.items.map((item) => item.metadata.title)).toEqual(['Big', 'Small']);
  });

  test('an import told to stop leaves a long note part-way, and reads it again from its start', async () => {
    const huge = { id: 'big', subject: 'Big', created_at: '2023-01-01T00:00:00Z', content: 'word '.repeat(1_000_000) };
    const text = JSON.stringify([huge, ...reflectNotes(2).map((note) => reflectNoteRecord(note))]);
    let calls = 0;
    const opened = jsonConnector('a.json', text, { shouldContinue: () => ++calls <= 3 });
    const first = await listAll(opened.connector);
    expect(first).toMatchObject({ items: [], done: false });
    const all = await listAll(opened.again({}).connector, first.cursors.at(-1));
    expect(all.items.map((item) => item.metadata.title)).toEqual(['Big', 'Synthetic harbour note 0', 'Synthetic harbour note 1']);
  });
});

// --- Review round 2: the editor container, empty lists, and a long first record -------------

describe('a Reflect body: the container is recognised, every node is read on its own', () => {
  test('JSON text with a kind an editor writes but not what that kind carries is the note, kept as written', () => {
    const text = '{"type":"text","value":"keep me"}';
    for (const field of ['content', 'body', 'document_json']) {
      expect(parseReflectNote({ id: 'a', [field]: text })).toMatchObject({ kind: 'note', note: { body: text } });
    }
    const list = '[{"type":"paragraph","value":"x"}]';
    expect(parseReflectNote({ id: 'a', content: list })).toMatchObject({ kind: 'note', note: { body: list } });
  });

  test('a field that is there and is not what it should be is unsupported, whatever the node or its other fields are', () => {
    const lostContent = { type: 'doc', content: { text: 'lost' } };
    expect(parseReflectNote({ id: 'a', document_json: JSON.stringify(lostContent) })).toEqual({ kind: 'unsupported' });
    expect(parseReflectNote({ id: 'a', document_json: lostContent })).toEqual({ kind: 'unsupported' });
    const numberText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 7 }] }] };
    expect(parseReflectNote({ id: 'a', document_json: numberText })).toEqual({ kind: 'unsupported' });
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] };
    const oddChildren = { type: 'doc', content: [paragraph, { type: 'paragraph', content: 'oops' }] };
    expect(parseReflectNote({ id: 'a', document_json: oddChildren })).toMatchObject({ kind: 'note', note: { body: 'Kept', unsupported: 1 } });
    // A node that has both its lists reads both, and a text that is no text is counted beside the list it came with.
    const both = { type: 'doc', content: [paragraph], children: [{ type: 'paragraph', content: [{ type: 'text', text: 'Also' }] }] };
    expect(parseReflectNote({ id: 'a', document_json: both })).toMatchObject({ kind: 'note', note: { body: 'Kept\nAlso' } });
    const textAndList = { type: 'doc', content: [{ type: 'paragraph', text: 5, content: [{ type: 'text', text: 'Kept' }] }] };
    expect(parseReflectNote({ id: 'a', document_json: textAndList })).toMatchObject({ kind: 'note', note: { body: 'Kept', unsupported: 1 } });
  });

  test('one node Olympus does not know never hides the readable ones beside it', () => {
    const kept = { type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] };
    const image = { type: 'image', attrs: { src: 'a.png' } };
    const outcomes = [
      parseReflectNote({ id: 'a', document_json: [kept, image] }),
      parseReflectNote({ id: 'a', document_json: JSON.stringify([kept, image]) }),
      parseReflectNote({ id: 'a', document_json: { content: [image, kept] } }),
      parseReflectNote({ id: 'a', content: JSON.stringify({ content: [kept, image] }) }),
      parseReflectNote({ id: 'a', document_json: { type: 'doc', content: [kept, image] } }),
    ];
    for (const outcome of outcomes) expect(outcome).toMatchObject({ kind: 'note', note: { body: 'Kept', unsupported: 1 } });
    // With nothing readable in it, it is unsupported and not empty.
    expect(parseReflectNote({ id: 'a', document_json: [image] })).toEqual({ kind: 'unsupported' });
    expect(parseReflectNote({ id: 'a', document_json: { type: 'doc', content: [image] } })).toEqual({ kind: 'unsupported' });
  });
});

describe('a long first record does not hide what a Reflect file is', () => {
  const LONG = 'word '.repeat(40_000);

  test('the keys after a long text still tell, in a list, a wrapped list and a zip member', () => {
    const late = (extra: Record<string, unknown> = {}) => ({ id: 'a', content: LONG, subject: 'Late title', created_at: '2023-01-01T00:00:00Z', ...extra });
    expect(formatOf(detectFile('list.json', JSON.stringify([late(), late({ id: 'b' })])))).toBe('reflect-json');
    expect(formatOf(detectFile('wrapped.json', JSON.stringify({ version: 2, notes: [late()] })))).toBe('reflect-json');
    expect(formatOf(detectFile('Reflect.zip', reflectJsonZip(JSON.stringify([late()]))))).toBe('reflect-json');
    expect(formatOf(detectFile('Reflect stored.zip', reflectJsonZip(JSON.stringify([late()]), { method: 'stored' })))).toBe('reflect-json');
    // A first record that shows nothing of the kind, however long, is still not Reflect's, and the answer is not a refusal for size.
    expect(formatOf(detectFile('other.json', JSON.stringify([{ blob: LONG, other: 1 }])))).toBe('none');
    expect(formatOf(detectFile('roam.json', JSON.stringify([{ children: [{ string: LONG }], title: 'Late page', uid: 'p1', 'create-time': 1 }])))).toBe('roam-json');
  });

  test('a first record bigger than the most one record is read whole does not refuse the file', () => {
    const body = 'x'.repeat(NOTE_MAX_RECORD_BYTES + 1024);
    const text = JSON.stringify([{ id: 'a', content: body, subject: 'Huge', created_at: '2023-01-01T00:00:00Z' }]);
    expect(formatOf(detectFile('huge.json', text))).toBe('reflect-json');
  });

  test('the way on past the first bytes is asked only when they cannot settle it, and with what decides', () => {
    const calls: Array<readonly string[]> = [];
    const deciding: Array<(keys: ReadonlySet<string>) => boolean> = [];
    const probeOf = (head: string, keys?: readonly string[]): ArchiveProbe => ({
      chosen: {
        relPath: '',
        name: 'a.json',
        kind: 'file',
        head: new TextEncoder().encode(head),
        firstRecordKeys: (list, enough) => {
          calls.push(list);
          if (enough) deciding.push(enough);
          return keys ? new Set(keys) : undefined;
        },
      },
      children: [],
    });
    const idOf = (probe: ArchiveProbe) => formatOf(detectArchiveFormat(probe));
    // Settled by the first bytes: not asked.
    expect(idOf(probeOf('[{"subject":"a","content":"b"}]'))).toBe('reflect-json');
    expect(idOf(probeOf('[{"id":1,"x":2}]'))).toBe('none');
    expect(idOf(probeOf('[' + ' '.repeat(5000)))).toBe('none');
    expect(idOf(probeOf('[1,2,3,' + '4,'.repeat(2000)))).toBe('none');
    expect(calls).toEqual([]);
    // Cut inside the first record: asked, for the list it is in.
    expect(idOf(probeOf(`[{"content":"${'x'.repeat(5000)}`, ['content', 'subject']))).toBe('reflect-json');
    expect(idOf(probeOf(`{"notes":[{"content":"${'x'.repeat(5000)}`, ['content', 'title']))).toBe('reflect-json');
    expect(calls).toEqual([[], ['notes']]);
    // A scan that finds no such record, or none that tells, is no match.
    expect(idOf(probeOf(`[{"content":"${'x'.repeat(5000)}`))).toBe('none');
    expect(idOf(probeOf(`[{"content":"${'x'.repeat(5000)}`, ['content', 'other']))).toBe('none');
    // It is told when the keys so far decide.
    const enough = deciding[0]!;
    expect(enough(new Set(['content']))).toBe(false);
    expect(enough(new Set(['content', 'subject']))).toBe(true);
    expect(enough(new Set(['title', 'create-time']))).toBe(true);
  });
});

describe('a long value before the list of notes does not hide what a Reflect file is', () => {
  const note = { id: 'a', content: 'Hello from the harbour.', subject: 'Title', created_at: '2023-01-01T00:00:00Z' };
  const lateNote = { id: 'a', content: 'word '.repeat(40_000), subject: 'Late title', created_at: '2023-01-01T00:00:00Z' };

  test('the list is looked for through the root object\'s other keys, whatever their values are', () => {
    const bigObject = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`key${index}`, 'v'.repeat(40)]));
    const roots: Array<[string, unknown]> = [
      ['a long text', { settings: 'x'.repeat(1_000_000), notes: [note] }],
      ['a big object', { settings: bigObject, notes: [note] }],
      ['a long list', { settings: Array.from({ length: 200_000 }, (_, index) => index), notes: [note] }],
      ['several, then a first note that is long too', { a: 'x'.repeat(600_000), b: bigObject, version: 2, notes: [lateNote, note] }],
    ];
    for (const [what, root] of roots) {
      const text = JSON.stringify(root);
      expect({ what, size: text.length > 4096, format: formatOf(detectFile('export.json', text)) }).toEqual({ what, size: true, format: 'reflect-json' });
    }
    const zipped = JSON.stringify({ settings: 'x'.repeat(1_000_000), notes: [note] });
    expect(formatOf(detectFile('Reflect.zip', reflectJsonZip(zipped)))).toBe('reflect-json');
    expect(formatOf(detectFile('Reflect stored.zip', reflectJsonZip(zipped, { method: 'stored' })))).toBe('reflect-json');
  });

  test('an object that has no list of notes, however long it is, is not Reflect\'s', () => {
    const settings = 'x'.repeat(1_000_000);
    for (const root of [
      { settings },
      { settings, notes: 5 },
      { settings, notes: { a: note } },
      { settings, notes: [1, 2, 3] },
      { settings, other: [note] },
      { settings, notes: [{ id: 1, content: 'a comment, not a note' }] },
    ]) {
      expect(formatOf(detectFile('export.json', JSON.stringify(root)))).toBe('none');
    }
    // A notes key that shows in the first bytes holding no list needs no reading on.
    expect(formatOf(detectFile('export.json', JSON.stringify({ notes: 'none yet', settings })))).toBe('none');
  });

  test('the way on is asked, for the notes list, only while the first bytes end before it is reached', () => {
    const calls: Array<readonly string[]> = [];
    const probeOf = (head: string, keys?: readonly string[]): ArchiveProbe => ({
      chosen: {
        relPath: '',
        name: 'a.json',
        kind: 'file',
        head: new TextEncoder().encode(head),
        firstRecordKeys: (list) => {
          calls.push(list);
          return keys ? new Set(keys) : undefined;
        },
      },
      children: [],
    });
    const idOf = (probe: ArchiveProbe) => formatOf(detectArchiveFormat(probe));
    const long = 'x'.repeat(5000);
    // An object that goes on past the first bytes: the list may be further down.
    expect(idOf(probeOf(`{"settings":"${long}`, ['content', 'subject']))).toBe('reflect-json');
    expect(idOf(probeOf(`{"settings":{"a":[1,2,3],"b":"${long}`))).toBe('none');
    expect(idOf(probeOf(`{"settings":"short","notes":`, ['content', 'title']))).toBe('reflect-json');
    expect(calls).toEqual([['notes'], ['notes'], ['notes']]);
    calls.length = 0;
    // Settled by the first bytes: not asked.
    expect(idOf(probeOf('{"settings":"short"}'))).toBe('none');
    expect(idOf(probeOf(`{"notes":{"a":1},"pad":"${long}`))).toBe('none');
    expect(idOf(probeOf(`{"notes":"none yet","pad":"${long}`))).toBe('none');
    expect(idOf(probeOf('{}'))).toBe('none');
    expect(calls).toEqual([]);
  });
});

describe('the slower look at a file runs only when the first bytes settled nothing', () => {
  const probeOf = (head: string, calls: string[]): ArchiveProbe => {
    const spy = (list: readonly string[]) => {
      calls.push(`keys:${list.join('/')}`);
      return undefined;
    };
    return {
      chosen: {
        relPath: '',
        name: 'result.json',
        kind: 'file',
        head: new TextEncoder().encode(head),
        firstRecordKeys: spy,
        listIsEmpty: (list) => { calls.push(`empty:${list.join('/')}`); return false; },
      },
      children: [],
    };
  };

  test('a format the first bytes settle leaves the others no reading on', () => {
    const calls: string[] = [];
    const telegram = `{"about":"Here is the data you requested.","personal_information":{"user_id":1,"pad":"${'x'.repeat(5000)}`;
    const detection = detectArchiveFormat(probeOf(telegram, calls), ARCHIVE_FORMATS);
    expect(formatOf(detection)).toBe('telegram_json');
    expect(calls).toEqual([]);
    // With nothing settled by the first bytes the look is made, once for the file.
    expect(formatOf(detectArchiveFormat(probeOf(`{"settings":"${'x'.repeat(5000)}`, calls), ARCHIVE_FORMATS))).toBe('none');
    expect(calls).toEqual(['keys:notes']);
  });
});

describe('a second export that the first bytes do not tell is not left out of a folder', () => {
  const LONG = 'word '.repeat(40_000);
  const note = (extra: Record<string, unknown> = {}) => ({ id: 'a', content: 'Hello from the harbour.', subject: 'Title', created_at: '2023-01-01T00:00:00Z', ...extra });
  // The keys that say what it is come after more than the first 4 KB of text.
  const lateReflect = () => JSON.stringify([{ id: 'late', content: LONG, subject: 'Late title', created_at: '2023-01-02T00:00:00Z' }]);
  const lateRoam = () => JSON.stringify([{ children: [{ string: LONG }], title: 'Late page', uid: 'p1', 'create-time': 1 }]);
  const settled = () => JSON.stringify([note(), note({ id: 'b' })]);

  /** A folder holding these files, picked, with an allowance for the look (the default unless given). */
  function detectFolder(files: Record<string, string | Uint8Array>, scanBytes?: { document?: number; folder?: number }): ArchiveDetection {
    const dir = tempFolder(cleanups);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const root = ScopeRoot.open(dir);
    try {
      return detectArchiveFormat(probeArchivePath(root, '', { probeNames: archiveProbeNames(), ...(scanBytes ? { scanBytes } : {}) }));
    } finally {
      root.close();
    }
  }

  test('two exports, one told by its first bytes and one by keys further in, are refused as two exports are when both are told at once', () => {
    const both = detectFolder({ 'a.json': settled(), 'b.json': settled() });
    expect(both.kind).toBe('none');
    const late = detectFolder({ 'a.json': settled(), 'b.json': lateReflect() });
    expect(late).toEqual(both);
    // Either one first in the listing.
    expect(detectFolder({ 'z.json': settled(), 'b.json': lateReflect() })).toEqual(both);
    // The same when the late one is the only other file in a folder of other things.
    expect(detectFolder({ 'a.json': settled(), 'b.json': lateReflect(), 'readme.txt': 'hello' })).toEqual(both);
  });

  test('a second export of another kind is two kinds of export, which are asked about', () => {
    const detection = detectFolder({ 'a.json': settled(), 'b.json': lateRoam() });
    expect(detection).toEqual({ kind: 'ambiguous', formats: ['reflect-json', 'roam-json'] });
  });

  test('a file that is no export, however long its first record, is left alone and the export beside it is the match', () => {
    const detection = detectFolder({ 'a.json': settled(), 'other.json': JSON.stringify([{ blob: LONG, other: 1 }]), 'notes.txt': 'x' });
    expect(detection).toMatchObject({ kind: 'match', files: ['a.json'] });
    expect(formatOf(detection)).toBe('reflect-json');
    // A single late export is still found when it is the only candidate.
    expect(detectFolder({ 'b.json': lateReflect(), 'readme.txt': 'x' })).toMatchObject({ kind: 'match', files: ['b.json'] });
  });

  test('only the files the first bytes left open are read on through: a file they settled is never asked', () => {
    const calls: string[] = [];
    const entry = (name: string, head: string): ArchiveProbe['children'][number] => ({
      relPath: name,
      name,
      kind: 'file',
      head: new TextEncoder().encode(head),
      firstRecordKeys: () => { calls.push(`${name}:keys`); return undefined; },
      listIsEmpty: () => { calls.push(`${name}:empty`); return false; },
    });
    const telegram = `{"about":"Here is the data you requested.","personal_information":{"user_id":1,"pad":"${'x'.repeat(5000)}`;
    const probe: ArchiveProbe = {
      chosen: { relPath: '', name: 'folder', kind: 'directory' },
      children: [
        entry('result.json', telegram),
        entry('open.json', `[{"content":"${'x'.repeat(5000)}`),
        entry('short.json', '[{"id":1,"x":2}]'),
      ],
    };
    const detection = detectArchiveFormat(probe, ARCHIVE_FORMATS);
    expect(formatOf(detection)).toBe('telegram_json');
    // Only the open one was read on through, once (the formats that ask about it share the read).
    expect(calls).toEqual(['open.json:keys']);
  });

  test('a folder whose look ran out of allowance before every file was reached is refused in plain words, not imported with a file left out', () => {
    const MiB = 1024 * 1024;
    const filler = (mib: number) => JSON.stringify([{ blob: 'x'.repeat(mib * MiB), other: 1 }]);
    const lateBig = () => JSON.stringify([{ id: 'late', content: 'x'.repeat(3 * MiB), subject: 'Late title', created_at: '2023-01-02T00:00:00Z' }]);
    const small = { folder: 4 * MiB };
    // Enough allowance: the late export is found, and with the first one that is two exports.
    expect(detectFolder({ 'a.json': settled(), 'b.json': filler(3), 'c.json': lateBig() }, { folder: 64 * MiB }).kind).toBe('none');
    // Too little: the late export was not reached, so nothing is imported, and the person is told what to do.
    const refused = detectFolder({ 'a.json': settled(), 'b.json': filler(3), 'c.json': lateBig() }, small);
    expect(refused).toMatchObject({ kind: 'none', advice: ARCHIVE_LOOK_INCOMPLETE_ADVICE });
    // The same when the files not reached are no exports at all: the look cannot say so, and says what it could not do.
    expect(detectFolder({ 'a.json': settled(), 'b.json': filler(3), 'c.json': filler(3) }, small)).toMatchObject({ kind: 'none', advice: ARCHIVE_LOOK_INCOMPLETE_ADVICE });
    // Within the allowance the same folder is the export beside the files that are none.
    expect(detectFolder({ 'a.json': settled(), 'b.json': filler(1), 'c.json': filler(1) }, small)).toMatchObject({ kind: 'match', files: ['a.json'] });
    // A file that ran into its own allowance is one the look could not tell, as before; it is not the folder running out.
    expect(detectFolder({ 'a.json': settled(), 'b.json': filler(3) }, { document: 1 * MiB, folder: 64 * MiB })).toMatchObject({ kind: 'match', files: ['a.json'] });
    // The sentence is plain words with no file names, and leaves the person a way out.
    expect(ARCHIVE_LOOK_INCOMPLETE_ADVICE).toContain('Choose just the export file');
    expect(ARCHIVE_LOOK_INCOMPLETE_ADVICE).not.toMatch(/\.json|\.zip|\//);
  });

  test('a refused folder shows as the supported-formats answer with the advice added; the file picked on its own is not subject to the folder\'s allowance', () => {
    const MiB = 1024 * 1024;
    const filler = JSON.stringify([{ blob: 'x'.repeat(3 * MiB), other: 1 }]);
    const refused = detectFolder({ 'a.json': settled(), 'b.json': filler, 'c.json': filler }, { folder: 4 * MiB });
    expect(refused.kind).toBe('none');
    if (refused.kind === 'none') expect(refused.supported).toContain('Reflect notes (JSON)');
    // The export on its own is picked as a file: a match, whatever sits beside it.
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'a.json'), settled());
    writeFileSync(join(dir, 'b.json'), filler);
    const root = ScopeRoot.open(dir);
    try {
      expect(detectArchiveFormat(probeArchivePath(root, 'a.json', { probeNames: archiveProbeNames(), scanBytes: { folder: 1 } })).kind).toBe('match');
    } finally {
      root.close();
    }
  });

  test('through the import start: a folder with a second export is refused and nothing is recorded', () => {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'a.json'), settled());
    writeFileSync(join(dir, 'b.json'), lateReflect());
    const state = new ArchiveImportStateStore({ path: join(tempFolder(cleanups), 'data', 'archive-imports.json') });
    expect(startArchiveImport({ state, path: dir })).toMatchObject({ kind: 'unsupported' });
    expect(state.list()).toEqual([]);
    // The first export alone is the import.
    unlinkSync(join(dir, 'b.json'));
    expect(startArchiveImport({ state, path: dir }).kind).toBe('started');
  });

  // The listing in name order, so where the export falls among the files does not depend on the machine.
  function inNameOrder<T>(body: () => T): T {
    const original = ScopeRoot.prototype.list;
    ScopeRoot.prototype.list = function (this: ScopeRoot, relDir: string) {
      return original.call(this, relDir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    };
    try {
      return body();
    } finally {
      ScopeRoot.prototype.list = original;
    }
  }

  describe('a real Reflect export as the 33rd file of a folder is found or reported, never dropped', () => {
    const realExport = () => reflectJson(reflectNotes(3, 'lighthouse'));
    const pad = (index: number) => String(index).padStart(2, '0');
    const fill = (dir: string, count: number, name: (index: number) => string, content: string) => {
      for (let index = 0; index < count; index += 1) writeFileSync(join(dir, name(index)), content);
    };
    const probeInOrder = (dir: string) => {
      const root = ScopeRoot.open(dir);
      try {
        return inNameOrder(() => probeArchivePath(root, '', { probeNames: archiveProbeNames() }));
      } finally {
        root.close();
      }
    };

    test('named like a JSON export, it is read ahead of 32 other JSON files and is the match', () => {
      const dir = tempFolder(cleanups);
      fill(dir, 32, (index) => `a-${pad(index)}.json`, JSON.stringify([{ blob: 'word ', other: 1 }]));
      writeFileSync(join(dir, 'z-notes.json'), realExport());
      expect(readdirSync(dir)).toHaveLength(33);
      const detection = detectArchiveFormat(probeInOrder(dir));
      expect(detection).toMatchObject({ kind: 'match', files: ['z-notes.json'] });
      expect(formatOf(detection)).toBe('reflect-json');
    });

    test('named like a JSON export, it is read ahead of 32 files nobody asks for and is the match', () => {
      const dir = tempFolder(cleanups);
      fill(dir, 32, (index) => `a-${pad(index)}.dat`, 'plain');
      writeFileSync(join(dir, 'z-notes.json'), realExport());
      expect(detectArchiveFormat(probeInOrder(dir))).toMatchObject({ kind: 'match', files: ['z-notes.json'] });
    });

    test('with a name no format asks for it is past the files read, and the refusal says the look was not complete', () => {
      const dir = tempFolder(cleanups);
      fill(dir, 32, (index) => `a-${pad(index)}.dat`, 'plain');
      writeFileSync(join(dir, 'z-notes-export'), realExport());
      const probe = probeInOrder(dir);
      expect(probe.othersNotLookedAt).toBe(1);
      expect(detectArchiveFormat(probe)).toMatchObject({ kind: 'none', advice: expect.stringContaining(ARCHIVE_LOOK_INCOMPLETE_ADVICE) });
      // The same folder through the start: refused with the same words, nothing recorded.
      const state = new ArchiveImportStateStore({ path: join(tempFolder(cleanups), 'data', 'archive-imports.json') });
      const refused = inNameOrder(() => startArchiveImport({ state, path: dir }));
      expect(refused.kind).toBe('unsupported');
      if (refused.kind === 'unsupported') expect(refused.advice).toContain(ARCHIVE_LOOK_INCOMPLETE_ADVICE);
      expect(state.list()).toEqual([]);
    });

    test('a folder of 32 such files and no export says nothing of a look not complete', () => {
      const dir = tempFolder(cleanups);
      fill(dir, 32, (index) => `a-${pad(index)}.dat`, 'plain');
      const probe = probeInOrder(dir);
      expect(probe.othersNotLookedAt).toBeUndefined();
      const detection = detectArchiveFormat(probe);
      expect(detection.kind).toBe('none');
      if (detection.kind === 'none') expect(detection.advice ?? '').not.toContain(ARCHIVE_LOOK_INCOMPLETE_ADVICE);
    });
  });
});

describe('a second export inside a zip that the first bytes do not tell is not left out of it', () => {
  const MiB = 1024 * 1024;
  const LONG = 'word '.repeat(40_000);
  const note = (extra: Record<string, unknown> = {}) => ({ id: 'a', content: 'Hello from the harbour.', subject: 'Title', created_at: '2023-01-01T00:00:00Z', ...extra });
  const page = { title: 'Page', uid: 'p0', 'create-time': 1, children: [{ string: 'A block.' }] };
  const settledReflect = () => JSON.stringify([note(), note({ id: 'b' })]);
  const settledRoam = () => JSON.stringify([page, { ...page, uid: 'p1' }]);
  // The keys that say what each is come after more than the first 4 KB of text.
  const lateReflect = (text = LONG) => JSON.stringify([{ id: 'late', content: text, subject: 'Late title', created_at: '2023-01-02T00:00:00Z' }]);
  const lateRoam = () => JSON.stringify([{ children: [{ string: LONG }], title: 'Late page', uid: 'p1', 'create-time': 1 }]);
  const blob = (mib: number) => JSON.stringify([{ blob: 'x'.repeat(mib * MiB), other: 1 }]);
  const zipOf = (members: Array<[string, string]>) => buildZip(members.map(([name, data]) => ({ name, data, method: 'deflate' as const })));

  type Allowance = { document?: number; folder?: number };
  /** The zip, picked on its own (a file), or inside a folder that is picked. */
  function detectZip(members: Array<[string, string]>, scanBytes?: Allowance, inFolder = false): ArchiveDetection {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'export.zip'), zipOf(members));
    const root = ScopeRoot.open(dir);
    try {
      return detectArchiveFormat(probeArchivePath(root, inFolder ? '' : 'export.zip', { probeNames: archiveProbeNames(), ...(scanBytes ? { scanBytes } : {}) }));
    } finally {
      root.close();
    }
  }

  test('a Reflect member told by its first bytes and a Roam member told only further in are refused as the two kinds are when both are told at once', () => {
    const bothSettled = detectZip([['reflect.json', settledReflect()], ['roam.json', settledRoam()]]);
    expect(bothSettled.kind).toBe('none');
    expect(detectZip([['reflect.json', settledReflect()], ['roam.json', lateRoam()]])).toEqual(bothSettled);
    // Either one first in the zip, and the other way about.
    expect(detectZip([['roam.json', lateRoam()], ['reflect.json', settledReflect()]])).toEqual(bothSettled);
    expect(detectZip([['reflect.json', lateReflect()], ['roam.json', settledRoam()]])).toEqual(bothSettled);
    // Inside a folder that is picked, the same.
    expect(detectZip([['reflect.json', settledReflect()], ['roam.json', lateRoam()]], undefined, true)).toEqual(bothSettled);
  });

  test('a second member of the same kind, or one that is no export however long, leaves the zip the export it is', () => {
    expect(detectZip([['a.json', settledReflect()], ['b.json', lateReflect()]])).toMatchObject({ kind: 'match', files: [''] });
    expect(formatOf(detectZip([['a.json', settledReflect()], ['b.json', lateReflect()]]))).toBe('reflect-json');
    expect(formatOf(detectZip([['a.json', settledReflect()], ['b.json', JSON.stringify([{ blob: LONG, other: 1 }])], ['c.txt', 'x']]))).toBe('reflect-json');
    // A late member alone is found as before.
    expect(formatOf(detectZip([['a.json', lateRoam()], ['readme.txt', 'x']]))).toBe('roam-json');
  });

  test('only the members the first bytes left open are read on through: a member they settled is never asked', () => {
    const calls: string[] = [];
    const member = (name: string, head: string): ArchiveProbe['children'][number] => ({
      relPath: name,
      name,
      kind: 'file',
      head: new TextEncoder().encode(head),
      firstRecordKeys: () => { calls.push(`${name}:keys`); return undefined; },
      listIsEmpty: () => { calls.push(`${name}:empty`); return false; },
    });
    const probe: ArchiveProbe = {
      chosen: {
        relPath: '',
        name: 'export.zip',
        kind: 'file',
        head: new Uint8Array([0x50, 0x4b, 3, 4]),
        members: [
          member('reflect.json', '[{"subject":"a","content":"b"}]'),
          member('open.json', `[{"content":"${'x'.repeat(5000)}`),
          member('short.json', '[{"id":1,"x":2}]'),
        ],
      },
      children: [],
    };
    // The zip is told by its settled member; the one that is open is still read on through, once.
    expect(formatOf(detectArchiveFormat(probe, ARCHIVE_FORMATS))).toBe('reflect-json');
    expect(calls).toEqual(['open.json:keys']);
  });

  test('a zip whose look ran out of allowance before every member was reached is refused in plain words', () => {
    const settled: [string, string] = ['a.json', settledReflect()];
    const members: Array<[string, string]> = [settled, ['b.json', blob(3)], ['c.json', lateReflect('x'.repeat(3 * MiB))]];
    // Within the allowance every member is looked through: two Reflect members are one Reflect export.
    expect(formatOf(detectZip(members, { document: 64 * MiB }))).toBe('reflect-json');
    // The zip's members share one document's worth: too little and the last was not reached, so nothing is imported.
    expect(detectZip(members, { document: 2 * MiB })).toMatchObject({ kind: 'none', advice: ARCHIVE_LOOK_INCOMPLETE_ADVICE });
    // The same inside a folder that is picked, where the folder's allowance is the zip's share.
    expect(detectZip(members, { folder: 2 * MiB }, true)).toMatchObject({ kind: 'none', advice: ARCHIVE_LOOK_INCOMPLETE_ADVICE });
    expect(formatOf(detectZip(members, { folder: 64 * MiB }, true))).toBe('reflect-json');
    // A member that ran into its own allowance is one the look could not tell, as before: not the zip running out.
    expect(formatOf(detectZip([settled, ['b.json', blob(3)]], { document: 1 * MiB }))).toBe('reflect-json');
    // And a member told by its first bytes costs the allowance nothing.
    expect(formatOf(detectZip([settled, ['b.json', settledReflect()], ['c.json', settledReflect()]], { document: 1 }))).toBe('reflect-json');
  });

  test('a picked file or zip says whether its look ran out; a plain JSON file has no allowance to run out', () => {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'plain.json'), settledReflect());
    writeFileSync(join(dir, 'export.zip'), zipOf([['a.json', settledReflect()]]));
    const root = ScopeRoot.open(dir);
    try {
      expect(probeArchivePath(root, 'plain.json', { probeNames: archiveProbeNames() }).readsRanOut).toBeUndefined();
      const zip = probeArchivePath(root, 'export.zip', { probeNames: archiveProbeNames() });
      expect(zip.readsRanOut?.()).toBe(false);
    } finally {
      root.close();
    }
  });
});
