// Evernote exports (.enex) as archive imports: which files are Evernote's, a
// note's body (ENML) as plain lines, Evernote's own reading of an image put in
// reading order, each attachment a child item whose bytes are read later from
// its place in the file, paging and resuming (inside a note with many
// attachments too), what is reported, and a whole import through the runtime
// whose children the extraction source can read. Synthetic exports built in
// code, never a real one.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_COMMON_FINDINGS,
  EVERNOTE_ENEX_ARCHIVE_FORMAT,
  archiveProbeNames,
  detectArchiveFormat,
  looksLikeEnex,
  type ArchiveDetection,
} from '../src/core/archive-formats.ts';
import type { RawItem } from '../src/core/contracts.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { createEvernoteArchiveConnector, enexTime } from '../src/workers/archive-import/evernote/connector.ts';
import { enmlToText } from '../src/workers/archive-import/evernote/enml.ts';
import { RECOGNITION_MAX_ALTERNATIVES, RECOGNITION_MAX_PLACES, recognizedText } from '../src/workers/archive-import/evernote/recognition.ts';
import { archiveAccountConnector } from '../src/workers/archive-import/extraction-source.ts';
import { registerArchiveFormatConnectors } from '../src/workers/archive-import/format-connectors.ts';
import { probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import { NOTE_FINDINGS, NOTE_MAX_RECORD_BYTES } from '../src/workers/archive-import/notes/note.ts';
import { RECO_INDEX, enexExport, evernoteNotes, pngBytes, type EnexNote } from './support/archive-fixtures-evernote.ts';
import { importAllNotes, importFixture, listAll, openConnector, storedNotes, tempFolder, textOf, writeExport } from './support/archive-notes-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

registerArchiveFormatConnectors();

function detect(dir: string, name: string): ArchiveDetection {
  const root = ScopeRoot.open(dir);
  try {
    return detectArchiveFormat(probeArchivePath(root, name, { probeNames: archiveProbeNames() }));
  } finally {
    root.close();
  }
}

const formatOf = (detection: ArchiveDetection): string => (detection.kind === 'match' ? detection.format.id : detection.kind);

function connectorOver(name: string, content: string, options: Parameters<typeof openConnector>[5] = {}) {
  const file = writeExport(cleanups, name, content);
  const open = () => openConnector(cleanups, file.dir, [name], EVERNOTE_ENEX_ARCHIVE_FORMAT, createEvernoteArchiveConnector, options);
  return { file, ...open(), again: open };
}

const WITH_ATTACHMENTS: EnexNote[] = [
  { title: 'Plain', enml: '<div>Just words.</div>', created: '20240101T080000Z' },
  {
    title: 'Whiteboard',
    enml: '<div>See the photo:</div><en-media type="image/png" hash="0f"/><div>and the scan</div><en-media type="application/pdf" hash="1a"/>',
    tags: ['work'],
    created: '20240102T080000Z',
    resources: [
      { mime: 'image/png', fileName: 'board.png', bytes: pngBytes(1), recognition: RECO_INDEX },
      { mime: 'application/pdf', bytes: pngBytes(2, 1000) },
    ],
  },
  { title: 'Last', enml: '<p>The end.</p>', created: '20240103T080000Z' },
];

describe('which files are Evernote exports', () => {
  test('a .enex file, a file whose first bytes say so, and a folder of them; not other XML, not a zip', () => {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'Notebook.enex'), enexExport(evernoteNotes(2)));
    writeFileSync(join(dir, 'renamed.xml'), enexExport(evernoteNotes(1)));
    writeFileSync(join(dir, 'other.xml'), '<?xml version="1.0"?><rss><channel/></rss>');
    expect(formatOf(detect(dir, 'Notebook.enex'))).toBe('evernote-enex');
    expect(formatOf(detect(dir, 'renamed.xml'))).toBe('evernote-enex');
    expect(formatOf(detect(dir, 'other.xml'))).toBe('none');
    const folder = join(dir, 'Export');
    mkdirSync(folder);
    writeFileSync(join(folder, 'B.enex'), enexExport(evernoteNotes(1)));
    writeFileSync(join(folder, 'A.enex'), enexExport(evernoteNotes(1)));
    writeFileSync(join(folder, 'readme.txt'), 'not an export');
    const inFolder = detect(dir, 'Export');
    expect(inFolder.kind === 'match' ? [inFolder.format.id, inFolder.files] : inFolder.kind).toEqual(['evernote-enex', ['A.enex', 'B.enex']]);
    expect(looksLikeEnex(new TextEncoder().encode('﻿<?xml version="1.0"?>\n<!-- x --><en-export>'))).toBe(true);
    expect(looksLikeEnex(new TextEncoder().encode('<en-exports>'))).toBe(false);
  });

  test('ENEX times are read as UTC; anything else is no time', () => {
    expect(enexTime('20230401T153000Z')).toBe('2023-04-01T15:30:00.000Z');
    expect(enexTime('2023-04-01')).toBeUndefined();
  });
});

describe('a note\'s body as plain lines', () => {
  test('blocks, to-dos, lists, tables, attachments, entities; encrypted text never read', () => {
    const body = enmlToText([
      '<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "x"><en-note style="a">',
      '<h1>Plan</h1><div>Café&nbsp;&amp;   more<br/>next line</div>',
      '<div><en-todo checked="true"/>bought milk</div><div><en-todo/>call Sam</div>',
      '<ol><li>first</li><li>second</li></ol>',
      '<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d</td></tr></table>',
      '<en-media type="image/jpeg" hash="00ff"/>',
      '<en-crypt hint="pw" cipher="AES">U2VjcmV0Q2lwaGVydGV4dA==</en-crypt>',
      '<script>alert(1)</script><pre>  keep   spacing</pre>',
      '</en-note>',
    ].join(''));
    expect(body.text).toBe([
      'Plan',
      'Café & more',
      'next line',
      '[x] bought milk',
      '[ ] call Sam',
      '- first',
      '- second',
      'a | b',
      'c | d',
      '[Attachment: image/jpeg] [Encrypted text, not read]',
      '  keep   spacing',
    ].join('\n'));
    expect(body.text).not.toContain('U2VjcmV0');
    expect(body.text).not.toContain('alert');
    expect(body.unsupported).toBe(1);
    expect(body.media).toBe(1);
  });
});

describe('Evernote\'s own reading of an image', () => {
  test('the likeliest word of each place, line by line, left to right; the others as search terms only', () => {
    const read = recognizedText(RECO_INDEX);
    expect(read.text).toBe('meet Sam\nat noon');
    expect(read.words).toBe(4);
    expect(read.alternatives.sort()).toEqual(['Sarn', 'moon', 'rneet']);
    expect(recognizedText('<recoIndex/>')).toEqual({ text: '', words: 0, alternatives: [] });
  });
});

describe('listing', () => {
  test('a note, then each of its attachments as a child listed by name with the means to read it later', async () => {
    const { connector, findings } = connectorOver('Notebook.enex', enexExport(WITH_ATTACHMENTS));
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata['title'])).toEqual(['Plain', 'Whiteboard', 'board.png', 'Attachment 2 (application/pdf)', 'Last']);
    const [, board, photo, scan] = items as [RawItem, RawItem, RawItem, RawItem];
    expect(textOf(board)).toContain('See the photo:\n [Attachment: image/png]'.replace('\n ', '\n'));
    expect(textOf(board)).toContain('Tags: work');
    for (const child of [photo, scan]) {
      expect(child.identity.parent).toEqual({ providerItemId: board.identity.providerItemId, localItemId: board.identity.localItemId });
      // The child's id names its parent, so the shared readers find the parent from the child alone.
      expect(child.identity.providerItemId.startsWith(`${board.identity.providerItemId}#child:`)).toBe(true);
      expect(child.content).toEqual({ kind: 'metadata_only' });
      expect(child.deferredBytes?.available).toBe(true);
      expect(child.identity.provider).toBe('evernote');
      expect(child.holdContentUntilJudged).toBeUndefined();
    }
    expect(photo.mimeType).toBe('image/png');
    // What Evernote read is never in an item's metadata, which is not judged as content: it comes with the bytes.
    expect(JSON.stringify(items.map((item) => item.metadata))).not.toContain('noon');
    expect(findings).toEqual([]);
  });

  test('an attachment\'s bytes, read from its place: whole, within a ceiling, and refused for other files', async () => {
    const opened = connectorOver('Notebook.enex', enexExport(WITH_ATTACHMENTS));
    const { items } = await listAll(opened.connector);
    const photo = items[2]!;
    const scan = items[3]!;
    const locator = photo.deferredBytes!.locator;
    const read = await opened.connector.fetchItem(photo.identity.localItemId, { deferredBytes: { locator } });
    expect(read.content.kind === 'bytes' ? Array.from(read.content.bytes) : []).toEqual(Array.from(pngBytes(1)));
    expect(read.mimeType).toBe('image/png');
    // Evernote's reading of the picture comes with its bytes, as provider text: the likeliest word of each place.
    expect(read.providerText).toEqual({ text: 'meet Sam\nat noon', form: 'recognized_words', label: 'Evernote', terms: expect.arrayContaining(['Sarn', 'moon', 'rneet']) });
    const pdf = await opened.connector.fetchItem(scan.identity.localItemId, { deferredBytes: { locator: scan.deferredBytes!.locator } });
    expect(pdf.content.kind === 'bytes' ? pdf.content.bytes.length : 0).toBe(1000);
    const within = await (opened.connector as unknown as { fetchItemWithin: (id: string, o: object) => Promise<RawItem> })
      .fetchItemWithin(photo.identity.localItemId, { maxBytes: 10, deferredBytes: { locator } });
    expect(within.content.kind === 'bytes' ? within.content.bytes.length : 0).toBe(11);
    // A locator of other files is not read.
    const other = openConnector(cleanups, opened.file.dir, ['Notebook.enex'], EVERNOTE_ENEX_ARCHIVE_FORMAT, createEvernoteArchiveConnector, { manifestSha256: 'f'.repeat(64) });
    await expect(other.connector.fetchItem(photo.identity.localItemId, { deferredBytes: { locator } })).rejects.toThrow();
    // A file that changed since is not read either.
    appendFileSync(opened.file.path, ' ');
    await expect(opened.connector.fetchItem(photo.identity.localItemId, { deferredBytes: { locator } })).rejects.toThrow();
  });

  test('paging and resuming from every cursor gives the same items, a note with many attachments cut inside it', async () => {
    const notes: EnexNote[] = [
      ...evernoteNotes(3),
      { title: 'Album', enml: '<div>photos</div>', resources: Array.from({ length: 5 }, (_, index) => ({ mime: 'image/png', fileName: `p${index}.png`, bytes: pngBytes(index) })) },
      ...evernoteNotes(2, 'meadow'),
    ];
    const content = enexExport(notes);
    const whole = await listAll(connectorOver('All.enex', content).connector);
    const ids = whole.items.map((item) => item.identity.providerItemId);
    expect(ids.length).toBe(3 + 6 + 2);
    const paged = connectorOver('Paged.enex', content, { pageSize: 2 });
    const pages = await listAll(paged.connector);
    expect(pages.pages.every((count) => count <= 2)).toBe(true);
    expect(pages.items.map((item) => item.metadata['title'])).toEqual(whole.items.map((item) => item.metadata['title']));
    // From each cursor a new connector (a restart) goes on with exactly what follows.
    let cursor: string | undefined;
    const resumed: RawItem[] = [];
    for (let guard = 0; guard < 50; guard += 1) {
      const next = paged.again();
      let page;
      for await (page of next.connector.listItems({ ...(cursor ? { cursor } : {}), limit: 2 })) break;
      resumed.push(...page!.items);
      cursor = page!.nextCursor;
      if (page!.done) break;
    }
    expect(resumed.map((item) => item.metadata['title'])).toEqual(whole.items.map((item) => item.metadata['title']));
  });

  test('a stop asked for mid-listing hands out what was whole, and the cursor goes on from there', async () => {
    let reads = 0;
    const content = enexExport(evernoteNotes(6));
    const opened = connectorOver('Stop.enex', content, { shouldContinue: () => reads++ < 1, maxBytesPerListing: 1 << 30 });
    const first = await listAll(opened.connector);
    expect(first.done).toBe(false);
    const rest = await listAll(opened.again().connector, first.cursors[first.cursors.length - 1]);
    expect([...first.items, ...rest.items].map((item) => item.metadata['title'])).toEqual(evernoteNotes(6).map((note) => note.title));
  });

  test('what is reported: an empty note, encrypted text, an attachment not in the file, damage, a file that is not an export', async () => {
    const notes: EnexNote[] = [
      { title: '', enml: '' },
      { title: 'Secret', enml: '<div>before</div><en-crypt cipher="AES">QUJDREVG</en-crypt>' },
      { title: 'No bytes', enml: '<div>x</div>', resources: [{ mime: 'image/png', bytes: pngBytes(3), noData: true }, { mime: 'image/png', bytes: pngBytes(4), encoding: 'hex' }] },
      { title: 'Kept', enml: '<div>kept</div>' },
    ];
    const content = enexExport(notes);
    const cut = content.slice(0, content.indexOf('<title>Kept</title>') + 30);
    const opened = connectorOver('Cut.enex', cut);
    const { items, done } = await listAll(opened.connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.metadata['title'])).toEqual(['Secret', 'No bytes', 'Attachment 1 (image/png)', 'Attachment 2 (image/png)']);
    expect(items.slice(2).map((item) => item.deferredBytes?.available)).toEqual([false, false]);
    expect(textOf(items[0]!)).not.toContain('QUJD');
    const kinds = opened.findings.map((finding) => finding.kind).sort();
    expect(kinds).toEqual([
      ARCHIVE_COMMON_FINDINGS.fileDamaged,
      ARCHIVE_COMMON_FINDINGS.mediaNotImported,
      ARCHIVE_COMMON_FINDINGS.mediaNotImported,
      NOTE_FINDINGS.empty,
      NOTE_FINDINGS.unsupported,
      // Neither note gives a created or updated time: the file's own day is used, and said.
      NOTE_FINDINGS.dateAssumed,
      NOTE_FINDINGS.dateAssumed,
    ].sort());
    // Read again after a restart, the findings are at the same places.
    const again = opened.again();
    await listAll(again.connector);
    expect(again.findings.map((finding) => `${finding.kind}@${finding.offset}`)).toEqual(opened.findings.map((finding) => `${finding.kind}@${finding.offset}`));

    const notExport = connectorOver('Feed.enex', '<?xml version="1.0"?><rss/>');
    expect((await listAll(notExport.connector)).items).toEqual([]);
    expect(notExport.findings.map((finding) => finding.kind)).toEqual([ARCHIVE_COMMON_FINDINGS.sectionNotImported]);
  });

  test('a note too big to read is passed over and reported; its attachments\' bytes do not count toward it', async () => {
    const huge: EnexNote = { title: 'Huge', enml: `<div>${'w '.repeat(Math.ceil(NOTE_MAX_RECORD_BYTES / 2) + 10)}</div>` };
    const big: EnexNote = { title: 'Big attachment', enml: '<div>ok</div>', resources: [{ mime: 'application/octet-stream', bytes: new Uint8Array(NOTE_MAX_RECORD_BYTES + 1024) }] };
    const opened = connectorOver('Big.enex', enexExport([huge, big, { title: 'After', enml: '<div>after</div>' }]));
    const { items } = await listAll(opened.connector);
    expect(items.map((item) => item.metadata['title'])).toEqual(['Big attachment', 'Attachment 1 (application/octet-stream)', 'After']);
    expect(opened.findings.map((finding) => finding.kind).filter((kind) => kind !== NOTE_FINDINGS.dateAssumed)).toEqual([NOTE_FINDINGS.tooLarge]);
  });
});

describe('a whole import under Archives', () => {
  test('notes and their attachments are stored, held until judged, and the extraction source reads an attachment', async () => {
    const f = importFixture(cleanups);
    const started = f.start('Notebook.enex', enexExport(WITH_ATTACHMENTS));
    expect(started.format).toBe('evernote-enex');
    const last = await importAllNotes(f.runtime, started.archiveId, { pageSize: 2, maxItems: 2 });
    expect(last.receipt.counts.traversal_complete).toBe(1);
    expect(f.runtime.state.get(started.archiveId)).toMatchObject({ status: 'imported', family: 'note', provider: 'evernote' });
    const rows = storedNotes(f.env, started.archiveId);
    expect(new Set(rows.map((row) => row.providerItemId)).size).toBe(5);
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['evernote']));

    const listed = await listAll(openConnector(cleanups, f.exports, ['Notebook.enex'], EVERNOTE_ENEX_ARCHIVE_FORMAT, createEvernoteArchiveConnector, {
      manifestSha256: f.runtime.state.get(started.archiveId)!.manifest_sha256,
    }).connector);
    const photo = listed.items[2]!;
    const reading = archiveAccountConnector({ state: f.runtime.state, archiveId: started.archiveId, family: 'note' })!;
    const bytes = await (reading as unknown as { fetchItemWithin: (id: string, o: object) => Promise<RawItem> })
      .fetchItemWithin(`${started.archiveId}:${photo.identity.providerItemId}`, { maxBytes: 1_000_000, deferredBytes: { locator: photo.deferredBytes!.locator } });
    expect(bytes.content.kind === 'bytes' ? Array.from(bytes.content.bytes) : []).toEqual(Array.from(pngBytes(1)));
  });
});

describe('Evernote\'s reading of a large attachment', () => {
  test('a 4.8 MB reading on one line is read in one pass, and stops at its cap of words', () => {
    const items = Array.from({ length: 60_000 }, (_, index) => `<item x="${index * 10}" y="5" w="9" h="10"><t w="90">word${index}</t><t w="10">alt${index}</t></item>`).join('');
    const reco = `<recoIndex>${items}</recoIndex>`;
    expect(reco.length).toBeGreaterThan(4_800_000);
    const started = Date.now();
    const read = recognizedText(reco);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(read.words).toBe(RECOGNITION_MAX_PLACES);
    expect(read.text.split('\n')).toHaveLength(1);
    expect(read.text.startsWith('word0 word1 word2')).toBe(true);
    expect(read.alternatives.length).toBeLessThanOrEqual(RECOGNITION_MAX_ALTERNATIVES);
  });

  test('items that never close are not looked at again and again', () => {
    const reco = `<recoIndex>${'<item x="1" y="1" h="1"><t w="5">open'.repeat(200_000)}</recoIndex>`;
    const started = Date.now();
    expect(recognizedText(reco)).toEqual({ text: '', words: 0, alternatives: [] });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
