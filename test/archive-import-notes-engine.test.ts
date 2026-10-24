// The notes archive engine that Reflect and Roam share: what a zip's JSON
// members are asked before they are read (an empty list is empty, not another
// file; the questions are charged to the listing's limits), and a stored
// member's checksum kept across a stop in the middle of a record. Synthetic
// exports built in code, never a real one.

import { afterEach, describe, expect, test } from 'bun:test';
import { ROAM_JSON_ARCHIVE_FORMAT, REFLECT_JSON_ARCHIVE_FORMAT } from '../src/core/archive-formats.ts';
import { archiveContinuations } from '../src/workers/archive-import/continuation-cache.ts';
import { NOTES_MAX_UNITS_PER_PAGE } from '../src/workers/archive-import/notes/archive.ts';
import { createReflectJsonArchiveConnector } from '../src/workers/archive-import/reflect/connector.ts';
import { createRoamArchiveConnector } from '../src/workers/archive-import/roam/connector.ts';
import { buildZip } from './helpers/zip-fixture.ts';
import { reflectJson, reflectNotes } from './support/archive-fixtures-reflect.ts';
import { roamJson, roamPages } from './support/archive-fixtures-roam.ts';
import { listAll, openConnector, writeExport } from './support/archive-notes-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  archiveContinuations.clear();
  while (cleanups.length) cleanups.pop()!();
});

type OpenOptions = Parameters<typeof openConnector>[5];

function reflectZip(name: string, content: Uint8Array, options: OpenOptions = {}) {
  const file = writeExport(cleanups, name, content);
  const open = (opened: OpenOptions) => openConnector(cleanups, file.dir, [name], REFLECT_JSON_ARCHIVE_FORMAT, createReflectJsonArchiveConnector, opened);
  return { file, ...open(options), again: (opened: OpenOptions = options) => open(opened) };
}

function roamZip(name: string, content: Uint8Array, options: OpenOptions = {}) {
  const file = writeExport(cleanups, name, content);
  const open = (opened: OpenOptions) => openConnector(cleanups, file.dir, [name], ROAM_JSON_ARCHIVE_FORMAT, createRoamArchiveConnector, opened);
  return { file, ...open(options), again: (opened: OpenOptions = options) => open(opened) };
}

const kinds = (findings: ReadonlyArray<{ kind: string; class: string }>) => findings.map((finding) => `${finding.class}:${finding.kind}`);
const count = (findings: ReadonlyArray<{ kind: string }>, kind: string) => findings.filter((finding) => finding.kind === kind).length;

describe('an empty list of notes in a zip is an export with no notes, not another file', () => {
  test('Reflect: [] and {"notes": []} are empty, and a list of anything else is reported', async () => {
    const zip = buildZip([
      { name: 'notes.json', data: reflectJson(reflectNotes(2)), method: 'deflate' },
      { name: 'empty-a.json', data: '[]' },
      { name: 'empty-b.json', data: '{"notes": []}' },
      { name: 'empty-c.json', data: ' [ ]\n' },
      { name: 'empty-d.json', data: '{"version": 2, "notes": [ ], "tags": []}' },
      { name: 'numbers.json', data: '[1, 2, 3]' },
      { name: 'one.json', data: '{"notes": [1]}' },
    ]);
    const { connector, findings } = reflectZip('Reflect.zip', zip);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    expect(kinds(findings)).toEqual(['gap:section_not_imported', 'gap:section_not_imported']);
  });

  test('Roam: [] is empty, and an object with a list under notes is not a Roam export', async () => {
    const zip = buildZip([
      { name: 'pages.json', data: roamJson(roamPages(2)), method: 'deflate' },
      { name: 'empty-a.json', data: '[]' },
      { name: 'empty-b.json', data: '[ \n ]' },
      { name: 'wrapped.json', data: '{"notes": []}' },
      { name: 'numbers.json', data: '[1, 2, 3]' },
    ]);
    const { connector, findings } = roamZip('Roam-Export-1700000000000.zip', zip);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    expect(kinds(findings)).toEqual(['gap:section_not_imported', 'gap:section_not_imported']);
  });
});

describe('a zip member that is asked about is charged to the listing', () => {
  test('rejected members stop at the unit limit, like records do', async () => {
    const junk = Array.from({ length: NOTES_MAX_UNITS_PER_PAGE + 200 }, (_, index) => ({ name: `junk-${index}.json`, data: '{"name":"x"}' }));
    const zip = buildZip([{ name: 'notes.json', data: reflectJson(reflectNotes(2)), method: 'deflate' }, ...junk]);
    const { connector, findings } = reflectZip('Reflect.zip', zip);
    const { items, pages, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    // The first pass ended at the limit; the rest was read after it.
    expect(pages.length).toBeGreaterThan(1);
    expect(count(findings, 'section_not_imported')).toBe(junk.length);
  });

  test('the bytes read to turn a member away count against the byte budget', async () => {
    const pad = JSON.stringify({ pad: 'x'.repeat(3000) });
    const junk = Array.from({ length: 6 }, (_, index) => ({ name: `junk-${index}.json`, data: pad }));
    const zip = buildZip([...junk, { name: 'notes.json', data: reflectJson(reflectNotes(2)), method: 'deflate' }]);
    const opened = reflectZip('Reflect.zip', zip, { maxBytesPerListing: 5000 });
    const titles: unknown[] = [];
    const findings: Array<{ kind: string; class: string }> = [];
    let result = await listAll(opened.connector);
    findings.push(...opened.findings);
    let listings = 1;
    expect(result.done).toBe(false);
    titles.push(...result.items.map((item) => item.metadata.title));
    while (!result.done && listings < 20) {
      const next = opened.again();
      result = await listAll(next.connector, result.cursors.at(-1));
      findings.push(...next.findings);
      titles.push(...result.items.map((item) => item.metadata.title));
      listings += 1;
    }
    expect(result.done).toBe(true);
    expect(listings).toBeGreaterThan(2);
    expect(titles).toEqual(['Synthetic harbour note 0', 'Synthetic harbour note 1']);
    expect(count(findings, 'section_not_imported')).toBe(6);
  });

  test('a stop while a member is read to tell what it is leaves it to be asked again, whenever the stop comes', async () => {
    const LONG = 'word '.repeat(40_000);
    const late = (id: string) => ({ id, content: LONG, subject: `Late ${id}`, created_at: '2023-01-01T00:00:00Z' });
    const zip = buildZip([
      { name: 'one.json', data: reflectJson(reflectNotes(1)), method: 'deflate' },
      { name: 'two.json', data: JSON.stringify([late('a'), late('b')]), method: 'deflate' },
      { name: 'three.json', data: JSON.stringify({ notes: [late('c')] }), method: 'stored' },
    ]);
    const whole = reflectZip('Reflect.zip', zip);
    const expected = (await listAll(whole.connector)).items.map((item) => item.metadata.title);
    expect(expected).toEqual(['Synthetic harbour note 0', 'Late a', 'Late b', 'Late c']);
    expect(whole.findings).toEqual([]);
    for (let limit = 1; limit <= 14; limit += 1) {
      let calls = 0;
      const first = reflectZip('Reflect.zip', zip, { shouldContinue: () => ++calls <= limit });
      const part = await listAll(first.connector);
      const rest = first.again({});
      const all = await listAll(rest.connector, part.cursors.at(-1));
      expect({ limit, titles: [...part.items, ...all.items].map((item) => item.metadata.title) }).toEqual({ limit, titles: expected });
      expect({ limit, findings: [...first.findings, ...rest.findings].map((finding) => finding.kind) }).toEqual({ limit, findings: [] });
    }
  });
});

describe('a stored member\'s checksum survives a stop in the middle of a record', () => {
  const BIG = 'word '.repeat(700_000);
  const records = [
    { id: 'n0', subject: 'First', created_at: '2023-01-01T00:00:00Z', content: 'Small one.' },
    { id: 'n1', subject: 'Big', created_at: '2023-01-02T00:00:00Z', content: BIG },
    { id: 'n2', subject: 'Last', created_at: '2023-01-03T00:00:00Z', content: 'Small two.' },
  ];
  const json = JSON.stringify(records);
  const expectedTitles = ['First', 'Big', 'Last'];
  const badZip = buildZip([{ name: 'reflect-export.json', data: json, method: 'stored', badCrc: 0x12345678 }]);
  const goodZip = buildZip([{ name: 'reflect-export.json', data: json, method: 'stored' }]);

  async function stoppedThenResumed(zip: Uint8Array, limit: number, edit?: (cursor: string) => string) {
    let calls = 0;
    const first = reflectZip('Reflect.zip', zip, { shouldContinue: () => ++calls <= limit });
    const part = await listAll(first.connector);
    const cursor = part.cursors.at(-1);
    const rest = first.again({});
    const all = await listAll(rest.connector, cursor !== undefined && edit ? edit(cursor) : cursor);
    return {
      cursor,
      titles: [...part.items, ...all.items].map((item) => String(item.metadata.title)),
      findings: [...first.findings, ...rest.findings],
    };
  }

  test('a bad checksum is found whatever record the stop came in', async () => {
    for (let limit = 2; limit <= 12; limit += 1) {
      const result = await stoppedThenResumed(badZip, limit);
      expect({ limit, titles: result.titles }).toEqual({ limit, titles: expectedTitles });
      expect({ limit, damaged: count(result.findings, 'file_damaged') }).toEqual({ limit, damaged: 1 });
    }
  });

  test('a stop after chunks of a long record carries the checksum in the resume point', async () => {
    // Stopped while the long record is read, more than a chunk past the end of the first.
    const result = await stoppedThenResumed(goodZip, 5);
    expect(result.cursor).toBeDefined();
    const parts = result.cursor!.split(':');
    expect(parts[5]).not.toBe('');
    expect(result.titles).toEqual(expectedTitles);
    expect(count(result.findings, 'file_damaged')).toBe(0);
  });

  test('a resume point that carries no checksum is replayed from the member\'s start, never taken for a pass', async () => {
    const blank = (cursor: string) => {
      const parts = cursor.split(':');
      parts[5] = '';
      return parts.join(':');
    };
    const bad = await stoppedThenResumed(badZip, 5, blank);
    expect(bad.titles).toEqual(expectedTitles);
    expect(count(bad.findings, 'file_damaged')).toBe(1);
    const good = await stoppedThenResumed(goodZip, 5, blank);
    expect(good.titles).toEqual(expectedTitles);
    expect(count(good.findings, 'file_damaged')).toBe(0);
  });
});
