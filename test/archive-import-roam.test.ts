// Roam exports as archive imports: which files are Roam's, how one page of
// nested blocks becomes a note, paging and resuming through a JSON file or a
// zip, what is reported when a page is empty, unreadable, too big or undated,
// and a whole import through the runtime: held Private until judged, cited as
// Roam, and removable without touching another archive. Synthetic exports
// built in code, never a real one.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_NEUTRAL_PROVIDER,
  ArchiveImportStoppedError,
  REFLECT_JSON_ARCHIVE_FORMAT,
  REFLECT_MARKDOWN_ARCHIVE_FORMAT,
  ROAM_JSON_ARCHIVE_FORMAT,
  archiveFormatConnector,
  archiveFormatForProvider,
  archiveProbeNames,
  detectArchiveFormat,
  looksLikeRoamJson,
  type ArchiveDetection,
} from '../src/core/archive-formats.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveContinuations } from '../src/workers/archive-import/continuation-cache.ts';
import { registerArchiveFormatConnectors } from '../src/workers/archive-import/format-connectors.ts';
import { probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import { NOTE_FINDINGS, NOTE_MAX_RECORD_BYTES, NOTE_MAX_TEXT_CHARS } from '../src/workers/archive-import/notes/note.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { ROAM_CURSOR_PREFIX, createRoamArchiveConnector } from '../src/workers/archive-import/roam/connector.ts';
import { parseRoamPage, roamDailyPageDate } from '../src/workers/archive-import/roam/parse.ts';
import { archiveCorpusId, withArchiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { createReflectJsonArchiveConnector } from '../src/workers/archive-import/reflect/connector.ts';
import { buildZip } from './helpers/zip-fixture.ts';
import { reflectDailyName, reflectJson, reflectMarkdownZip, reflectNotes } from './support/archive-fixtures-reflect.ts';
import { roamJson, roamJsonZip, roamPages } from './support/archive-fixtures-roam.ts';
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

const MAIN_FIXTURE = join(import.meta.dir, 'fixtures/archive-import/roam/export-main.json');

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

/** A connector over a file written for the test; `again` opens another over the same file, as a restart does. */
function roamConnector(name: string, content: string | Uint8Array, options: OpenOptions = {}) {
  const file = writeExport(cleanups, name, content);
  const open = (opened: OpenOptions) => openConnector(cleanups, file.dir, [name], ROAM_JSON_ARCHIVE_FORMAT, createRoamArchiveConnector, opened);
  return { file, ...open(options), again: (opened: OpenOptions = options) => open(opened) };
}

const kinds = (findings: ReadonlyArray<{ kind: string; class: string }>) => findings.map((finding) => `${finding.class}:${finding.kind}`);
const iso = (ms: number) => new Date(ms).toISOString();

describe('which files are Roam exports', () => {
  test('a JSON list of pages with blocks is Roam JSON, compact or pretty-printed', () => {
    expect(formatOf(detectFile('Roam.json', roamJson(roamPages(3))))).toBe('roam-json');
    expect(formatOf(detectFile('Roam.json', roamJson(roamPages(3), true)))).toBe('roam-json');
    expect(formatOf(detectFile('export.json', readFileSync(MAIN_FIXTURE)))).toBe('roam-json');
    expect(formatOf(detectFile('bom.json', `\uFEFF\n${roamJson(roamPages(2))}`))).toBe('roam-json');
    // Block times alone, before any children, are Roam's too.
    expect(formatOf(detectFile('times.json', '[{"title":"T","create-time":1717200000000,"edit-time":1717300000000}]'))).toBe('roam-json');
  });

  test('a zip holding the JSON is Roam JSON, stored or deflated, with macOS metadata beside it', () => {
    const json = roamJson(roamPages(3));
    for (const method of ['stored', 'deflate'] as const) {
      expect(formatOf(detectFile('Roam-Export-1700000000000.zip', roamJsonZip(json, { method })))).toBe('roam-json');
    }
    const junk = [
      { name: '__MACOSX/' },
      { name: '__MACOSX/._roam-export.json', data: 'not json' },
      { name: '.DS_Store', data: 'x' },
    ];
    expect(formatOf(detectFile('Roam-Export.zip', roamJsonZip(json, { extra: junk })))).toBe('roam-json');
  });

  test('a JSON file far down a big zip is found', () => {
    const media = Array.from({ length: 300 }, (_, index) => ({ name: `assets/photo-${index}.png`, data: `png ${index}` }));
    expect(formatOf(detectFile('Everything.zip', roamJsonZip(roamJson(roamPages(2)), { before: media })))).toBe('roam-json');
  });

  test('a folder with one JSON export in it is that export; one holding Roam\'s and Reflect\'s is left to the person to choose', () => {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'roam.json'), roamJson(roamPages(2)));
    writeFileSync(join(dir, 'readme.txt'), 'hello');
    const root = ScopeRoot.open(dir);
    try {
      const alone = detectArchiveFormat(probeArchivePath(root, '', { probeNames: archiveProbeNames() }));
      expect(alone).toMatchObject({ kind: 'match', files: ['roam.json'] });
      expect(formatOf(alone)).toBe('roam-json');
      writeFileSync(join(dir, 'reflect.json'), reflectJson(reflectNotes(2)));
      const both = detectArchiveFormat(probeArchivePath(root, '', { probeNames: archiveProbeNames() }));
      expect(both).toMatchObject({ kind: 'ambiguous' });
      if (both.kind === 'ambiguous') expect([...both.formats].sort()).toEqual(['reflect-json', 'roam-json']);
    } finally {
      root.close();
    }
  });

  test('the other Roam exports are not read, and the refusal says what is', () => {
    const roamMarkdown = reflectMarkdownZip([
      { name: 'October 24th, 2026.md', text: '- a block\n  - a nested block' },
      { name: 'Project Olympus.md', text: '- Top priority: ship the connector' },
    ]);
    const edn = '[{:node/title "Page" :block/children [{:block/string "x" :block/uid "u1"}]}]';
    const cases: Array<[string, string | Uint8Array]> = [
      ['Roam-Export-1700000000000.zip', roamMarkdown],
      ['Roam-Export-1700000000000.zip', buildZip([{ name: 'export.edn', data: edn }])],
      ['export.edn', edn],
      ['plain.json', '{"a": [1, 2, 3]}'],
      ['empty.json', '[]'],
      ['strings.json', '["Page one", "Page two"]'],
    ];
    for (const [name, content] of cases) {
      const detection = detectFile(name, content);
      expect({ name, kind: detection.kind }).toEqual({ name, kind: 'none' });
      if (detection.kind !== 'none') continue;
      expect(detection.supported).toEqual(expect.arrayContaining([
        REFLECT_JSON_ARCHIVE_FORMAT.label,
        REFLECT_MARKDOWN_ARCHIVE_FORMAT.label,
        ROAM_JSON_ARCHIVE_FORMAT.label,
      ]));
    }
  });

  test('the format says what it is, and what to choose', () => {
    expect([ROAM_JSON_ARCHIVE_FORMAT.family, ROAM_JSON_ARCHIVE_FORMAT.provider, ROAM_JSON_ARCHIVE_FORMAT.citationLabel]).toEqual(['note', 'roam', 'Roam']);
    expect(ROAM_JSON_ARCHIVE_FORMAT.chooseHint).toContain('Export All');
    registerArchiveFormatConnectors();
    expect(archiveFormatConnector('roam-json')).toBeDefined();
    expect(looksLikeRoamJson(new TextEncoder().encode('[{"title":"x","uid":"u","children":[]}]'))).toBe(true);
    // Blocks under a title are any outline; a page has its id or its times too.
    expect(looksLikeRoamJson(new TextEncoder().encode('[{"title":"x","children":[]}]'))).toBe(false);
    expect(looksLikeRoamJson(new TextEncoder().encode('[{"id":"x","subject":"y","content":"z"}]'))).toBe(false);
    expect(looksLikeRoamJson(undefined)).toBe(false);
  });

  test('a daily page\'s title stands for its day', () => {
    expect(roamDailyPageDate('October 24th, 2026')).toBe('2026-10-24T12:00:00.000Z');
    expect(roamDailyPageDate('March 1st, 2024')).toBe('2024-03-01T12:00:00.000Z');
    expect(roamDailyPageDate('February 2nd, 2022')).toBe('2022-02-02T12:00:00.000Z');
    expect(roamDailyPageDate('June 23rd, 2022')).toBe('2022-06-23T12:00:00.000Z');
    expect(roamDailyPageDate('Daily Notes! (June 10th, 2026)')).toBeUndefined();
    expect(roamDailyPageDate('Project Olympus')).toBeUndefined();
    expect(roamDailyPageDate('February 31st, 2023')).toBeUndefined();
    expect(roamDailyPageDate('Smarch 3rd, 2023')).toBeUndefined();
  });
});

describe('one Roam page', () => {
  test('blocks become indented bullets in order, text exactly as written', () => {
    const outcome = parseRoamPage({
      title: ' Project ',
      uid: 'p1',
      children: [
        { string: 'Top with [[Link]] and **bold** and {{[[TODO]]}}', children: [{ string: 'Nested', children: [{ string: 'Deeper' }] }, { string: 'Sibling' }] },
        { string: 'Second top' },
      ],
    });
    expect(outcome).toMatchObject({
      kind: 'note',
      note: {
        key: 'p1',
        title: 'Project',
        tags: [],
        blockCount: 5,
        body: [
          '- Top with [[Link]] and **bold** and {{[[TODO]]}}',
          '  - Nested',
          '    - Deeper',
          '  - Sibling',
          '- Second top',
        ].join('\n'),
      },
    });
  });

  test('a block with no text adds no line but its children keep their level; trailing spaces go', () => {
    const outcome = parseRoamPage({
      title: 'T',
      children: [{ string: 'a', children: [{ string: '', children: [{ string: 'c' }] }, { string: '   ' }, { string: 'd   ' }, { notAString: 1 }] }],
    });
    expect(outcome).toMatchObject({ kind: 'note', note: { body: '- a\n    - c\n  - d', blockCount: 6 } });
  });

  test('created is the earliest time on the page or its blocks, updated the latest, in milliseconds', () => {
    const outcome = parseRoamPage({
      title: 'T',
      'create-time': 1_717_250_000_000,
      'edit-time': 1_717_260_000_000,
      children: [
        { string: 'a', 'create-time': 1_717_200_000_000, 'edit-time': 1_717_300_000_000, children: [{ string: 'b', 'create-time': 1_717_400_000_000 }] },
        { string: 'c', 'edit-time': 'not a time' },
      ],
    });
    expect(outcome).toMatchObject({ kind: 'note', note: { createdAt: iso(1_717_200_000_000), updatedAt: iso(1_717_300_000_000) } });
  });

  test('a page with no title is untitled, a uid may be a number, a daily page title gives its day', () => {
    expect(parseRoamPage({ uid: 12, children: [{ string: 'x' }] })).toMatchObject({ kind: 'note', note: { key: '12', title: '' } });
    expect(parseRoamPage({ children: [{ string: 'x' }] })).toMatchObject({ kind: 'note', note: { title: '' } });
    const daily = parseRoamPage({ title: 'October 24th, 2026', children: [{ string: 'x' }] });
    expect(daily).toMatchObject({ kind: 'note', note: { title: 'October 24th, 2026', titleDate: '2026-10-24T12:00:00.000Z' } });
  });

  test('a page with nothing written is an empty note; one with content Olympus cannot read is not taken for empty', () => {
    for (const page of [
      { title: 'Empty Page', uid: 'e', children: [] },
      { title: 'Stub Page' },
      { title: 'Blank blocks', children: [{ string: '' }, { string: '  ', children: [{ string: '' }] }] },
    ]) {
      expect({ title: page.title, outcome: parseRoamPage(page) }).toEqual({ title: page.title, outcome: { kind: 'empty' } });
    }
    for (const page of [
      { title: 'Children are not a list', children: 'text' },
      { title: 'Blocks are not records', children: ['text', 7, null] },
      { title: 'A block with a rich string', children: [{ string: { rich: 'text' } }] },
      { title: 'A block with no string', children: [{ uid: 'x' }] },
    ]) {
      expect({ title: page.title, outcome: parseRoamPage(page) }).toEqual({ title: page.title, outcome: { kind: 'unsupported' } });
    }
  });

  test('a page with some text and some blocks Olympus cannot read keeps the text and says what it could not read', () => {
    const outcome = parseRoamPage({ title: 'Mixed', children: [{ string: 'Kept' }, { uid: 'odd' }, 7, { string: 'Also kept', children: 'oops' }] });
    expect(outcome).toMatchObject({ kind: 'note', note: { title: 'Mixed', body: '- Kept\n- Also kept', unsupported: 3 } });
    // Nothing unreadable: no count at all.
    expect(parseRoamPage({ title: 'Plain', children: [{ string: 'x' }] })).toMatchObject({ kind: 'note' });
    const plain = parseRoamPage({ title: 'Plain', children: [{ string: 'x' }] });
    expect(plain.kind === 'note' && plain.note.unsupported).toBeFalsy();
  });

  test('anything that is not a record is not a page', () => {
    for (const value of ['text', 7, null, true, [1, 2]]) expect(parseRoamPage(value)).toEqual({ kind: 'unreadable' });
  });

  test('blocks nested absurdly deep are cut, not a stack overflow', () => {
    let block: Record<string, unknown> = { string: 'core' };
    for (let depth = 0; depth < 3000; depth += 1) block = { string: `level ${depth}`, children: [block] };
    const outcome = parseRoamPage({ title: 'Deep', children: [block] });
    expect(outcome.kind).toBe('note');
    if (outcome.kind === 'note') expect(outcome.note.body.split('\n').length).toBeLessThanOrEqual(260);
  });
});

describe('the Roam connector', () => {
  test('the main export: nested bullets, ids, dates from the blocks, no prior, empty pages left out', async () => {
    const { connector, findings } = roamConnector('export.json', readFileSync(MAIN_FIXTURE));
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.identity).toMatchObject({ family: 'note', provider: 'roam', accountScope: 'synthetic-archive' });
      expect(item.identity.localItemId).toBe(`synthetic-archive:${item.identity.providerItemId}`);
      expect(item.metadata.authoredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(item.mimeType).toBe('text/markdown');
    }
    const first = items[0]!;
    expect(first.metadata).toMatchObject({
      title: 'Project Olympus',
      blockCount: 5,
      authoredAt: iso(1_717_100_000_000),
      createdAt: iso(1_717_100_000_000),
      updatedAt: iso(1_717_400_000_000),
    });
    expect(textOf(first).endsWith([
      '- Top priority: ship the connector',
      '  - Nested detail A with [[Argus]] and **markup**',
      '    - Deep grandchild {{[[TODO]]}} kept verbatim',
      '  - Nested detail B',
      '- Second top-level block',
    ].join('\n'))).toBe(true);
    expect(textOf(first).startsWith(`Project Olympus\nCreated: ${iso(1_717_100_000_000).slice(0, 10)}\nUpdated: ${iso(1_717_400_000_000).slice(0, 10)}\n\n`)).toBe(true);
    expect(items[1]!.metadata).toMatchObject({ title: 'Daily Notes! (June 10th, 2026)', blockCount: 1, authoredAt: iso(1_717_000_000_000) });
    // The two pages with nothing written are counted as left out, not imported and not errors.
    expect(kinds(findings)).toEqual(['skipped:note_empty', 'skipped:note_empty']);
    const signals = connector.classificationSignals(first);
    expect(signals.prior).toBeUndefined();
    expect(signals).toEqual({ title: 'Project Olympus' });
  });

  test('pages with one uid or one title are separate notes; the same page twice is not one', async () => {
    const page = { title: 'Same', uid: 'same', 'create-time': 1_717_000_000_000, children: [{ string: 'same text' }] };
    const { connector, findings } = roamConnector('dup.json', roamJson([page, page, { ...page, children: [{ string: 'other text' }] }]));
    const { items } = await listAll(connector);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(3);
    expect(findings).toEqual([]);
  });

  test('a page with no times is dated by its daily title, else by the day the file was saved, and the second says so', async () => {
    const { connector, findings, file } = roamConnector('dates.json', roamJson([
      { title: 'October 24th, 2026', children: [{ string: 'Daily page, no times' }] },
      { title: 'Plain page', children: [{ string: 'No times, no daily title' }] },
      { title: 'Timed page', children: [{ string: 'Has a time', 'edit-time': 1_717_300_000_000 }] },
    ]));
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([
      '2026-10-24T12:00:00.000Z',
      new Date(statSync(file.path).mtimeMs).toISOString(),
      iso(1_717_300_000_000),
    ]);
    expect(kinds(findings)).toEqual(['gap:note_date_assumed']);
  });

  test('what is not a page is a gap at its place, and the pages after it are read', async () => {
    const text = JSON.stringify([
      { title: 'One', children: [{ string: 'first', 'create-time': 1_717_000_000_000 }] },
      'a stray string',
      42,
      null,
      { title: 'Two', children: [{ string: 'second', 'create-time': 1_717_100_000_000 }] },
    ]);
    const { connector, findings } = roamConnector('mixed.json', text);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual(['One', 'Two']);
    expect(kinds(findings)).toEqual(['gap:note_unreadable', 'gap:note_unreadable', 'gap:note_unreadable']);
    const offsets = findings.map((finding) => finding.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(text.slice(offsets[0]!).startsWith('"a stray string"')).toBe(true);
  });

  test('a document that is not a list of pages is reported as not imported, not guessed at', async () => {
    const { connector, findings } = roamConnector('object.json', JSON.stringify({ pages: [{ title: 'x', children: [{ string: 'y' }] }] }));
    expect(await listAll(connector)).toMatchObject({ items: [], done: true });
    expect(kinds(findings)).toEqual([`gap:${ARCHIVE_COMMON_FINDINGS.sectionNotImported}`]);
  });

  test('a page too big to read is a gap naming its place, and the pages after it are read', async () => {
    const big = JSON.stringify({ title: 'Big', children: [{ string: 'x'.repeat(NOTE_MAX_RECORD_BYTES + 1024) }] });
    const before = JSON.stringify({ title: 'Before', children: [{ string: 'first', 'create-time': 1_717_000_000_000 }] });
    const after = JSON.stringify({ title: 'After', children: [{ string: 'last', 'create-time': 1_717_200_000_000 }] });
    const text = `[${before},${big},${after}]`;
    const { connector, findings } = roamConnector('big.json', text);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual(['Before', 'After']);
    expect(findings).toEqual([{ kind: NOTE_FINDINGS.tooLarge, class: 'gap', fileIndex: 0, offset: before.length + 2 }]);
    expect(text.slice(findings[0]!.offset, findings[0]!.offset + 15)).toBe('{"title":"Big",');
  });

  test('a page longer than the import keeps is cut to its start and says so', async () => {
    const page = { title: 'Long', children: [{ string: `start ${'y'.repeat(NOTE_MAX_TEXT_CHARS + 500)} end`, 'create-time': 1_717_000_000_000 }] };
    const { connector, findings } = roamConnector('long.json', roamJson([page]));
    const { items } = await listAll(connector);
    expect(textOf(items[0]!)).toHaveLength(NOTE_MAX_TEXT_CHARS);
    expect(kinds(findings)).toEqual([`gap:${ARCHIVE_COMMON_FINDINGS.itemTruncated}`]);
  });

  test('a file cut short keeps the pages before the cut and reports the file as damaged', async () => {
    const text = roamJson(roamPages(5));
    const { connector, findings } = roamConnector('cut.json', text.slice(0, text.length - 60));
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(4);
    expect(kinds(findings)).toEqual(['gap:file_damaged']);
  });

  test('pages resume exactly where they ended, in a plain file and in a stored or a deflated zip', async () => {
    const json = roamJson(roamPages(7));
    const sources: Array<[string, string | Uint8Array]> = [
      ['plain.json', json],
      ['stored.zip', roamJsonZip(json, { method: 'stored' })],
      ['deflated.zip', roamJsonZip(json, { method: 'deflate' })],
    ];
    for (const [name, content] of sources) {
      const whole = roamConnector(name, content, { pageSize: 2 });
      const all = await listAll(whole.connector);
      expect(all.items).toHaveLength(7);
      expect(all.pages).toEqual([2, 2, 2, 1]);
      expect(all.cursors.every((cursor) => cursor.startsWith(`${ROAM_CURSOR_PREFIX}${whole.input.manifestSha256.slice(0, 16)}:`))).toBe(true);
      const ids = all.items.map((item) => item.identity.providerItemId);
      expect(new Set(ids).size).toBe(7);
      for (const [index, cursor] of all.cursors.entries()) {
        archiveContinuations.clear();
        const rest = await listAll(whole.again().connector, cursor);
        expect({ name, index, ids: rest.items.map((item) => item.identity.providerItemId) })
          .toEqual({ name, index, ids: ids.slice(Math.min(7, 2 * (index + 1))) });
      }
    }
  });

  test('a deflated member\'s inflater waits between pages and the next page takes it back', async () => {
    const { connector } = roamConnector('deflated.zip', roamJsonZip(roamJson(roamPages(6)), { method: 'deflate' }), { pageSize: 2 });
    const first = await listAll(connector, undefined, 2);
    expect(first.items).toHaveLength(2);
    expect(first.done).toBe(false);
    expect(archiveContinuations.size).toBe(1);
    const rest = await listAll(connector, first.cursors.at(-1));
    expect(rest.items).toHaveLength(4);
    expect(rest.done).toBe(true);
  });

  test('a stored member keeps its checksum across pages, so damage past the first page is still found', async () => {
    const json = roamJson(roamPages(6));
    const damaged = buildZip([{ name: 'roam-export.json', data: json, method: 'stored', badCrc: 0x12345678 }]);
    const { connector, findings } = roamConnector('stored.zip', damaged, { pageSize: 2 });
    const first = await listAll(connector, undefined, 2);
    const rest = await listAll(connector, first.cursors.at(-1));
    expect(rest.items).toHaveLength(4);
    expect(kinds(findings)).toEqual(['gap:file_damaged']);
  });

  test('a zip\'s other files are counted, its macOS metadata is not, and JSON members are read in order', async () => {
    const zip = buildZip([
      { name: 'assets/' },
      { name: 'assets/a.png', data: 'png a' },
      { name: '__MACOSX/._first.json', data: 'junk' },
      { name: 'first.json', data: roamJson(roamPages(2, 'first')), method: 'deflate' },
      { name: 'second.json', data: roamJson(roamPages(2, 'second')), method: 'stored' },
      { name: '.DS_Store', data: 'junk' },
    ]);
    const opened = roamConnector('Roam.zip', zip, { pageSize: 3 });
    const { items, done } = await listAll(opened.connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata.title)).toEqual([
      'Synthetic first page 0', 'Synthetic first page 1', 'Synthetic second page 0', 'Synthetic second page 1',
    ]);
    expect(opened.findings).toEqual([expect.objectContaining({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap', count: 1 })]);
    const paged = await listAll(opened.again().connector, undefined, 3);
    archiveContinuations.clear();
    const rest = await listAll(opened.again().connector, paged.cursors.at(-1));
    expect([...paged.items, ...rest.items].map((item) => item.identity.providerItemId)).toEqual(items.map((item) => item.identity.providerItemId));
  });

  test('a resume point belongs to these files and to Roam only, and a made-up one stops the import', async () => {
    const { connector, file } = roamConnector('a.json', roamJson(roamPages(5)), { pageSize: 2 });
    const all = await listAll(connector);
    const other = roamConnector('a.json', roamJson(roamPages(5)), { manifestSha256: 'f'.repeat(64) });
    await expect(listAll(other.connector, all.cursors[0])).rejects.toMatchObject({ code: 'resume_point_invalid' });
    // Another format's cursor over the same files is not this one's.
    const reflect = openConnector(cleanups, file.dir, ['a.json'], REFLECT_JSON_ARCHIVE_FORMAT, createReflectJsonArchiveConnector, { pageSize: 2 });
    await expect(listAll(reflect.connector, all.cursors[0])).rejects.toMatchObject({ code: 'resume_point_invalid' });
    const prefix = all.cursors[0]!.split(':').slice(0, 2).join(':');
    for (const made of [`${prefix}:5:-1:0::`, `${prefix}:0:-1:7:x:`, `${prefix}:0:-1:7::bm90IGpzb24`, `${prefix}:garbage`, 'not a resume point']) {
      await expect(listAll(connector, made)).rejects.toBeInstanceOf(ArchiveImportStoppedError);
    }
  });

  test('stopping between pages leaves a resume point at the next one', async () => {
    let calls = 0;
    const opened = roamConnector('a.json', roamJson(roamPages(5)), { shouldContinue: () => ++calls <= 3 });
    const first = await listAll(opened.connector);
    expect(first.done).toBe(false);
    const taken = first.items.length;
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(5);
    const rest = await listAll(opened.again({}).connector, first.cursors.at(-1));
    expect(rest.items.map((item) => item.metadata.title)).toEqual(
      Array.from({ length: 5 - taken }, (_, index) => `Synthetic lighthouse page ${taken + index}`),
    );
  });

  test('a file that changed or went missing stops the listing instead of reading other bytes', async () => {
    const { connector, file } = roamConnector('a.json', roamJson(roamPages(3)), { pageSize: 1 });
    const first = await listAll(connector, undefined, 1);
    expect(first.items).toHaveLength(1);
    appendFileSync(file.path, ' ');
    await expect(listAll(connector, first.cursors.at(-1))).rejects.toMatchObject({ code: 'file_changed', relPath: 'a.json' });
  });
});

describe('a Roam import through the runtime', () => {
  test('the pages are indexed once with Roam as their source, dated, counted, and held Private until judged', async () => {
    const f = importFixture(cleanups);
    const started = f.start('Roam-Export.json', readFileSync(MAIN_FIXTURE));
    expect(started.format).toBe('roam-json');
    await expect(pullNotes(f.runtime, started.archiveId, { pageSize: 1, maxItems: 1 })).resolves.toMatchObject({ continueSoon: true });
    const last = await importAllNotes(f.runtime, started.archiveId, { pageSize: 1, maxItems: 1 });
    expect(last.receipt.counts.traversal_complete).toBe(1);
    const record = f.runtime.state.get(started.archiveId)!;
    expect(record).toMatchObject({ status: 'imported', family: 'note', provider: 'roam', format: 'roam-json' });
    expect(record.findings.skipped).toEqual({ note_empty: 2 });
    expect(record.findings.gaps).toEqual({});
    expect(record.date_range).toEqual({ earliest: iso(1_717_000_000_000), latest: iso(1_717_100_000_000) });
    const rows = storedNotes(f.env, started.archiveId);
    expect(new Set(rows.map((row) => row.providerItemId)).size).toBe(2);
    expect(new Set(rows.map((row) => `${row.provider}/${row.family}`))).toEqual(new Set(['roam/note']));
    expect(f.runtime.lane('note').ledger.accountScopeCounts('roam', started.archiveId).items).toBe(2);
    // With no judge running, the content is in the Private store and nowhere else.
    const held = noteChunkTexts(f.env, 'secure_local', started.archiveId);
    expect(held.some((text) => text.includes('Top priority: ship the connector'))).toBe(true);
    for (const domain of ['internal', 'public_safe'] as const) {
      expect(noteChunkTexts(f.env, domain, started.archiveId)).toEqual([]);
      expect(noteEmbeddingCount(f.env, domain)).toBe(0);
    }
  });

  test('a zip import reads the JSON inside it and finishes', async () => {
    const f = importFixture(cleanups);
    const started = f.start('Roam-Export-1700000000000.zip', roamJsonZip(roamJson(roamPages(5)), { method: 'deflate' }));
    expect(started.format).toBe('roam-json');
    await importAllNotes(f.runtime, started.archiveId, { pageSize: 2, maxItems: 2 });
    expect(f.runtime.state.get(started.archiveId)).toMatchObject({ status: 'imported', date_range: { earliest: iso(Date.UTC(2024, 5, 1, 9)), latest: iso(Date.UTC(2024, 5, 5, 9)) } });
    expect(new Set(storedNotes(f.env, started.archiveId).map((row) => row.providerItemId)).size).toBe(5);
  });

  test('a changed file stops the import visibly', async () => {
    const f = importFixture(cleanups);
    const started = f.start('Changing.json', roamJson(roamPages(4)));
    await pullNotes(f.runtime, started.archiveId, { pageSize: 1, maxItems: 1 });
    appendFileSync(started.path, ' ');
    const outcome = await pullNotes(f.runtime, started.archiveId);
    expect(outcome.receipt.counts.import_stopped).toBe(1);
    expect(f.runtime.state.get(started.archiveId)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: 'Changing.json' } });
  });

  test('a Roam-only archive is cited as Roam although the notes stores carry the neutral name', async () => {
    const f = importFixture(cleanups);
    const started = f.start('Roam-Export.json', roamJson(roamPages(3)));
    await importAllNotes(f.runtime, started.archiveId);

    // Two note formats share the family, so its stores are named for the family and not for either app...
    const corpora = createSourceCorpusRegistry(withArchiveImportCorpora()).list().filter((corpus) => corpus.corpusId.includes('.archive.note'));
    expect(corpora.map((corpus) => corpus.provider)).toEqual([ARCHIVE_NEUTRAL_PROVIDER, ARCHIVE_NEUTRAL_PROVIDER, ARCHIVE_NEUTRAL_PROVIDER]);
    // ...while each item keeps its own format's provider...
    const rows = storedNotes(f.env, started.archiveId);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['roam']));
    // ...which is what names the source in an answer.
    expect(archiveFormatForProvider('roam')?.citationLabel).toBe('Roam');
    const row = rows.find((candidate) => candidate.domain === 'secure_local')!;
    const answer = {
      answer: 'The lighthouse log mentions entry 1.',
      evidence: [{
        corpus_id: archiveCorpusId('secure_local', 'note'),
        trust_domain: 'secure_local',
        family: row.family,
        provider: row.provider,
        provider_item_id: row.providerItemId,
        title: row.title ?? '',
        authored_at: row.authoredAt ?? undefined,
        citation_span: { chunk_index: 0, chunk_id: 'c0', char_start: 0, char_end: 5, item_char_start: 0, item_char_end: 5, chunk_chars: 5, lane: 'keyword' },
      }],
      secret_locations: [],
    } as unknown as SourceIndexAnswerResult;
    const output = remoteOperationOutput('source_answer', answer) as { citations?: Array<{ label: string }> };
    expect(output.citations?.map((citation) => citation.label)).toEqual(['Roam']);
  });

  test('removing one notes archive takes its pages and leaves another archive, Reflect or Roam, as it was', async () => {
    const f = importFixture(cleanups);
    const roam = f.start('Roam-Export.json', roamJson(roamPages(4)));
    const reflect = f.start('Reflect.json', reflectJson(reflectNotes(3)));
    const otherRoam = f.start('Roam-Export-2.json', roamJson(roamPages(2, 'beacon')));
    for (const archive of [roam, reflect, otherRoam]) await importAllNotes(f.runtime, archive.archiveId);
    const distinct = (archiveId: string) => new Set(storedNotes(f.env, archiveId).map((row) => row.providerItemId)).size;
    expect([distinct(roam.archiveId), distinct(reflect.archiveId), distinct(otherRoam.archiveId)]).toEqual([4, 3, 2]);
    // The same family, two apps: each archive's items name their own app.
    expect(new Set(storedNotes(f.env, reflect.archiveId).map((row) => row.provider))).toEqual(new Set(['reflect']));
    expect(new Set(storedNotes(f.env).map((row) => row.provider))).toEqual(new Set(['reflect', 'roam']));

    const lane = f.runtime.lane('note');
    requestArchiveRemoval(f.runtime.state, roam.archiveId);
    let removal = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: roam.archiveId });
    for (let run = 0; run < 50 && removal.kind === 'progress'; run += 1) {
      removal = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: roam.archiveId });
    }
    expect(removal.kind).toBe('removed');
    expect([distinct(roam.archiveId), distinct(reflect.archiveId), distinct(otherRoam.archiveId)]).toEqual([0, 3, 2]);
    expect(f.runtime.state.get(reflect.archiveId)?.status).toBe('imported');
    expect(f.runtime.state.get(otherRoam.archiveId)?.status).toBe('imported');
    expect(f.runtime.state.get(roam.archiveId)).toBeUndefined();
  });
});

describe('Reflect\'s daily note names are not Roam\'s', () => {
  test('a zip of Markdown pages named like Reflect\'s daily notes but called Roam is not Reflect\'s', () => {
    const files = [{ name: reflectDailyName(new Date(Date.UTC(2023, 2, 21))), text: '- a block' }];
    expect(formatOf(detectFile('Roam-Export-1700000000000.zip', reflectMarkdownZip(files)))).toBe('none');
  });
});

// --- Review round 1: told by structure, and what is said when a block is not read --------------

describe('a Roam JSON file is told by its structure', () => {
  test('one key of the kind is not a Roam export', () => {
    for (const [name, text] of [
      ['tree.json', '[{"children":[]}]'],
      ['titles.json', '[{"title":"Hello"}]'],
      ['sitemap.json', '[{"title":"Home","children":[{"string":"a"}]}]'],
      ['wrapped.json', '{"pages":[{"title":"Home","create-time":1}]}'],
      ['notes.json', '[{"content":"hello"}]'],
    ] as const) {
      expect({ name, format: formatOf(detectFile(name, text)) }).toEqual({ name, format: 'none' });
    }
    // A title with a page's times, or with blocks and an id, is a page.
    expect(formatOf(detectFile('times.json', '[{"title":"T","edit-time":1717300000000}]'))).toBe('roam-json');
    expect(formatOf(detectFile('blocks.json', '[{"title":"T","uid":"u1","children":[{"string":"a"}]}]'))).toBe('roam-json');
  });

  test('a zip is Roam JSON for the file that is, and its other JSON files are left out and reported', async () => {
    const zip = roamJsonZip(roamJson(roamPages(2)), {
      extra: [
        { name: 'sitemap.json', data: '[{"title":"Home","children":[{"string":"a page of a site"}]}]' },
        { name: 'package.json', data: '{"name": "x"}' },
      ],
    });
    expect(formatOf(detectFile('Roam-Export-1700000000000.zip', zip))).toBe('roam-json');
    const { connector, findings } = roamConnector('Roam-Export-1700000000000.zip', zip);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    expect(items.map((item) => textOf(item)).join('\n')).not.toContain('a page of a site');
    expect(kinds(findings)).toEqual(['gap:section_not_imported', 'gap:section_not_imported']);
  });
});

describe('the Roam connector says what it could not read', () => {
  test('blocks of a shape it has no rule for are a gap at their page: kept when the page has other text, left out when it has none', async () => {
    const pages = [
      { title: 'Only odd blocks', uid: 'a', 'create-time': Date.UTC(2024, 5, 1), children: [{ uid: 'x' }, 7] },
      { title: 'Text and an odd block', uid: 'b', 'create-time': Date.UTC(2024, 5, 2), children: [{ string: 'Kept words' }, { uid: 'y' }] },
      { title: 'Plain', uid: 'c', 'create-time': Date.UTC(2024, 5, 3), children: [{ string: 'Plain words' }] },
      { title: 'Blank', uid: 'd', 'create-time': Date.UTC(2024, 5, 4), children: [{ string: '' }] },
    ];
    const { connector, findings } = roamConnector('a.json', roamJson(pages));
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Text and an odd block', 'Plain']);
    expect(kinds(findings)).toEqual(['gap:note_content_unsupported', 'gap:note_content_unsupported', 'skipped:note_empty']);
  });

  test('the byte budget stops a listing at a page, and an import told to stop leaves a long page part-way', async () => {
    const opened = roamConnector('a.json', roamJson(roamPages(5)), { maxBytesPerListing: 50 });
    const first = await listAll(opened.connector);
    expect(first.items).toHaveLength(1);
    expect(first.done).toBe(false);
    const huge = { title: 'Big', uid: 'big', 'create-time': Date.UTC(2024, 5, 1), children: [{ string: 'word '.repeat(1_000_000) }] };
    let calls = 0;
    const stopped = roamConnector('b.json', roamJson([huge, ...roamPages(2)]), { shouldContinue: () => ++calls <= 3 });
    const part = await listAll(stopped.connector);
    expect(part).toMatchObject({ items: [], done: false });
    const all = await listAll(stopped.again({}).connector, part.cursors.at(-1));
    expect(all.items.map((item) => item.metadata.title)).toEqual(['Big', 'Synthetic lighthouse page 0', 'Synthetic lighthouse page 1']);
  });
});
