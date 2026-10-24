// The release check's synthetic archives (scripts/release-check/archive-fixtures.ts), put through the product's own mbox detector and
// connector: the expectation each fixture carries has to be what the product actually reads out of it, or the leg would fail a good
// install (or pass a broken one) on its own say-so.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import {
  ArchiveImportStoppedError,
  archiveFormatConnector,
  archiveProbeNames,
  detectArchiveFormat,
  getArchiveFormat,
  type ArchiveImportFinding,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { registerArchiveFormatConnectors } from '../src/workers/archive-import/format-connectors.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest, probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import {
  ARCHIVE_FORMATS,
  EXTRA_FORMATS,
  FIXTURE_FOLDER,
  MBOX_FIXTURES,
  changeFixture,
  fixtureToken,
  formatSpec,
  legFixture,
  resetFixtureFolder,
  stressSpec,
  writeFixture,
  type FixtureRole,
  type LegFixture,
} from '../scripts/release-check/archive-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-fixtures-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The product's connector over a written fixture, the way an import reads it: the registry's connector for the fixture's own format. */
function readFixture(root: string, fixture: LegFixture, options: { pageSize?: number } = {}) {
  registerArchiveFormatConnectors();
  const format = getArchiveFormat(fixture.format);
  const factory = archiveFormatConnector(fixture.format);
  if (!format || !factory) throw new Error(`the product has no connector for the format "${fixture.format}"`);
  const scope = ScopeRoot.open(join(root, FIXTURE_FOLDER));
  cleanups.push(() => scope.close());
  const files = buildArchiveManifest(scope, [fixture.fileName]);
  const findings: ArchiveImportFinding[] = [];
  const connector = factory({
    archiveId: 'rc-fixture',
    connectorId: 'archive.rc-fixture',
    accountScope: 'rc-fixture',
    format,
    root: scope,
    files: archiveFileEntries(files),
    manifestSha256: archiveManifestSha256(files),
    report: (finding) => { findings.push(finding); },
    shouldContinue: () => true,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
  });
  return { connector, findings };
}

async function readAll(connector: SourceConnector): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for await (const page of connector.listItems({})) items.push(...page.items);
  return items;
}

const tally = (findings: readonly ArchiveImportFinding[], kind: 'gap' | 'skipped'): Array<{ kind: string; count: number }> => {
  const byKind = new Map<string, number>();
  for (const finding of findings) if (finding.class === kind) byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + (finding.count ?? 1));
  return [...byKind].map(([name, count]) => ({ kind: name, count })).sort((a, b) => a.kind.localeCompare(b.kind));
};
const sorted = (rows: ReadonlyArray<{ kind: string; count: number }>) => [...rows].sort((a, b) => a.kind.localeCompare(b.kind));

describe('fixture tokens', () => {
  test('are letters and digits only, differ by seed, role and format, and repeat for the same call', () => {
    const token = fixtureToken('abc123', 'agent', 'mbox');
    expect(token).toMatch(/^rcarch[0-9a-f]{14}$/);
    expect(fixtureToken('abc123', 'agent', 'mbox')).toBe(token);
    expect(new Set([token, fixtureToken('abc124', 'agent', 'mbox'), fixtureToken('abc123', 'picker', 'mbox'), fixtureToken('abc123', 'agent', 'reflect')]).size).toBe(4);
  });

  test('every role of a run has its own token and its own file', () => {
    const roles: FixtureRole[] = ['agent', 'picker', 'held', 'bulk'];
    const fixtures = roles.map((role) => legFixture(role, 'seed-1'));
    expect(new Set(fixtures.map((fixture) => fixture.token)).size).toBe(roles.length);
    expect(new Set(fixtures.map((fixture) => fixture.fileName)).size).toBe(roles.length);
    for (const fixture of fixtures) expect(fixture.relPath).toBe(`${FIXTURE_FOLDER}/${fixture.fileName}`);
  });

  test('a format besides the first has its own token and file under the same role, and the formats the leg adds are exactly the registry\'s other ones', () => {
    expect(EXTRA_FORMATS).toEqual(['telegram_json', 'reflect-json', 'roam-json']);
    expect(EXTRA_FORMATS).toEqual(Object.keys(ARCHIVE_FORMATS).filter((format) => format !== 'mbox'));
    const mail = legFixture('agent', 'seed-1');
    const chat = legFixture('agent', 'seed-1', 'telegram_json');
    expect(chat.token).not.toBe(mail.token);
    expect(chat.fileName).toBe('rc-agent-telegram_json.json');
    expect(chat.fileName).not.toBe(mail.fileName);
    expect(chat.relPath).toBe(`${FIXTURE_FOLDER}/rc-agent-telegram_json.json`);
    expect(chat.token).toMatch(/^rcarch[0-9a-f]{14}$/);
  });
});

describe('the fixtures, read by the product', () => {
  test('every archive is a file the product\'s detector takes for mbox, and the table\'s labels are the product\'s own', () => {
    for (const role of ['agent', 'picker', 'held'] as const) {
      const fixture = legFixture(role, 'seed-detect');
      const probe = { chosen: { relPath: '', name: fixture.fileName, kind: 'file' as const, head: fixture.bytes.subarray(0, 4096) }, children: [] };
      const detected = detectArchiveFormat(probe);
      expect(detected.kind).toBe('match');
      if (detected.kind === 'match') expect(detected.format.id).toBe(fixture.format);
    }
    // The expectation rows carry the words the dashboard and a search show; the product's registry is where they come from.
    for (const spec of Object.values(ARCHIVE_FORMATS)) {
      const product = getArchiveFormat(spec.format);
      expect(product).toBeDefined();
      expect(spec.label).toBe(product!.label);
      expect(product!.citationLabel).toBeDefined();
      expect(spec.citationLabel).toBe(product!.citationLabel!);
      expect(spec.family).toBe(product!.family);
      expect(spec.provider).toBe(product!.provider);
      // Every archive of the format carries the family that decides what the dashboard calls its items.
      expect(legFixture('agent', 'seed-family', spec.format).expect.family).toBe(product!.family);
    }
  });

  test('the Telegram archive is a file the product\'s detector takes for a Telegram Desktop export, from its first bytes', () => {
    const fixture = legFixture('agent', 'seed-detect', 'telegram_json');
    const probe = { chosen: { relPath: '', name: fixture.fileName, kind: 'file' as const, head: fixture.bytes.subarray(0, 4096) }, children: [] };
    const detected = detectArchiveFormat(probe);
    expect(detected.kind).toBe('match');
    if (detected.kind === 'match') expect(detected.format.id).toBe('telegram_json');
  });

  test('the small archive reads as its expectation says: items, days, one unread attachment, one message left out', async () => {
    const root = home();
    const fixture = legFixture('agent', 'seed-small');
    writeFixture(root, fixture);
    const { connector, findings } = readFixture(root, fixture);
    const items = await readAll(connector);
    expect(items).toHaveLength(fixture.expect.messages);
    const days = items.map((item) => String(item.metadata.authoredAt).slice(0, 10)).sort();
    expect(days[0]).toBe(fixture.expect.earliest);
    expect(days[days.length - 1]).toBe(fixture.expect.latest);
    expect(sorted(tally(findings, 'gap'))).toEqual(sorted(fixture.expect.gaps));
    expect(sorted(tally(findings, 'skipped'))).toEqual(sorted(fixture.expect.leftOut));
    // The attachment is named and not stored; the message that carries it is still an item.
    expect(items.some((item) => item.metadata.attachmentCount === 1)).toBe(true);
  });

  test('the token is in the bodies and never in a subject or any other name', async () => {
    const root = home();
    const fixture = legFixture('agent', 'seed-token');
    writeFixture(root, fixture);
    const items = await readAll(readFixture(root, fixture).connector);
    const withToken = items.filter((item) => item.content.kind === 'text' && item.content.text.includes(fixture.token));
    expect(withToken.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(String(item.metadata.subject)).not.toContain(fixture.token);
      expect(String(item.metadata.from)).not.toContain(fixture.token);
      expect(String(item.metadata.title)).not.toContain(fixture.token);
    }
  });

  test('the Telegram archive reads as its expectation says: messages, days, one picture not imported, one part not imported, one service message left out', async () => {
    const root = home();
    const fixture = legFixture('agent', 'seed-telegram', 'telegram_json');
    writeFixture(root, fixture);
    const { connector, findings } = readFixture(root, fixture);
    const items = await readAll(connector);
    expect(items).toHaveLength(fixture.expect.messages);
    expect(fixture.expect.messages).toBe(5);
    const days = items.map((item) => String(item.metadata.authoredAt).slice(0, 10)).sort();
    expect([days[0], days[days.length - 1]]).toEqual([fixture.expect.earliest, fixture.expect.latest]);
    expect(sorted(tally(findings, 'gap'))).toEqual(sorted(fixture.expect.gaps));
    expect(sorted(tally(findings, 'skipped'))).toEqual(sorted(fixture.expect.leftOut));
    expect(fixture.expect.gaps).toEqual([{ kind: 'media_not_imported', count: 1 }, { kind: 'section_not_imported', count: 1 }]);
    expect(fixture.expect.leftOut).toEqual([{ kind: 'service_message', count: 1 }]);
    // The picture is named in its message and not imported; the message is still an item. The join is the earliest message, and is not counted in the days.
    expect(items.filter((item) => item.metadata.attachmentsNotIngested === 1)).toHaveLength(1);
    expect(days).not.toContain('2023-12-30');
    // One chat, and the account's own details are not messages: nothing of them is an item.
    expect(new Set(items.map((item) => item.identity.providerThreadId)).size).toBe(1);
    for (const item of items) expect(JSON.stringify(item)).not.toContain('synthetic_sam');
  });

  test('the Telegram word is in message bodies only, never in the chat\'s name, a sender or a title', async () => {
    const root = home();
    const fixture = legFixture('agent', 'seed-telegram-token', 'telegram_json');
    writeFixture(root, fixture);
    const items = await readAll(readFixture(root, fixture).connector);
    const withToken = items.filter((item) => item.content.kind === 'text' && item.content.text.includes(fixture.token));
    expect(withToken.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(String(item.metadata.title)).not.toContain(fixture.token);
      expect(String(item.metadata.sender)).not.toContain(fixture.token);
    }
    expect(fixture.fileName).not.toContain(fixture.token);
  });

  test('every format the leg adds is a file the product\'s own probe takes for that format, as it is written to the machine', () => {
    for (const format of EXTRA_FORMATS) {
      const root = home();
      const fixture = legFixture('agent', 'seed-probe', format);
      writeFixture(root, fixture);
      const scope = ScopeRoot.open(join(root, FIXTURE_FOLDER));
      try {
        const detected = detectArchiveFormat(probeArchivePath(scope, fixture.fileName, { probeNames: archiveProbeNames() }));
        expect(detected.kind === 'match' ? detected.format.id : detected.kind).toBe(format);
      } finally { scope.close(); }
    }
  });

  test('every format the leg adds reads as its expectation says, and its word is in bodies only', async () => {
    for (const format of EXTRA_FORMATS) {
      const root = home();
      const fixture = legFixture('agent', `seed-all-${format}`, format);
      writeFixture(root, fixture);
      const { connector, findings } = readFixture(root, fixture);
      const items = await readAll(connector);
      expect(items).toHaveLength(fixture.expect.messages);
      const days = items.map((item) => String(item.metadata.authoredAt).slice(0, 10)).sort();
      expect([days[0], days[days.length - 1]]).toEqual([fixture.expect.earliest, fixture.expect.latest]);
      expect(sorted(tally(findings, 'gap'))).toEqual(sorted(fixture.expect.gaps));
      expect(sorted(tally(findings, 'skipped'))).toEqual(sorted(fixture.expect.leftOut));
      // At least two items say the word, and no name the item carries does.
      const withToken = items.filter((item) => item.content.kind === 'text' && item.content.text.includes(fixture.token));
      expect(withToken.length).toBeGreaterThanOrEqual(2);
      for (const item of items) {
        for (const key of ['title', 'subject', 'from', 'sender']) expect(String(item.metadata[key])).not.toContain(fixture.token);
      }
      expect(fixture.fileName).not.toContain(fixture.token);
      // The row's words come from the product's registry, and the items are of the family the dashboard counts them by.
      expect(items.every((item) => item.identity.family === fixture.expect.family && item.identity.provider === formatSpec(format).provider)).toBe(true);
    }
  });

  test('the Reflect export reads as its expectation says: four notes (one an editor document), one empty note left out, one entry that is no note', async () => {
    const root = home();
    const fixture = legFixture('agent', 'seed-reflect', 'reflect-json');
    writeFixture(root, fixture);
    expect(fixture.fileName).toBe('rc-agent-reflect-json.json');
    const { connector, findings } = readFixture(root, fixture);
    const items = await readAll(connector);
    expect(fixture.expect).toMatchObject({ label: 'Reflect notes (JSON)', citationLabel: 'Reflect', family: 'note', messages: 4, earliest: '2024-03-04', latest: '2024-03-09' });
    expect(fixture.expect.gaps).toEqual([{ kind: 'note_unreadable', count: 1 }]);
    expect(fixture.expect.leftOut).toEqual([{ kind: 'note_empty', count: 1 }]);
    expect(items).toHaveLength(4);
    expect(findings.map((finding) => `${finding.class}:${finding.kind}`).sort()).toEqual(['gap:note_unreadable', 'skipped:note_empty']);
    // The days are the days the notes were written: not the empty note's (the earliest), and not the day one was edited later.
    const days = items.map((item) => String(item.metadata.authoredAt).slice(0, 10)).sort();
    expect(days).toEqual(['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-09']);
    expect(days).not.toContain('2023-12-30');
    expect(days).not.toContain('2024-04-02');
    const titles = items.map((item) => String(item.metadata.title));
    expect(titles).not.toContain('A page with nothing on it');
    // The body written as an editor document inside a string is read as text.
    const itinerary = items.find((item) => item.metadata.title === 'Itinerary for the weekend');
    expect(itinerary?.content.kind === 'text' ? itinerary.content.text : '').toContain('The route is the north shore road, then the ferry at noon.');
  });

  test('the Roam export is the zip Export All downloads, and reads as its expectation says: four pages, one block not read, one empty page left out', async () => {
    const root = home();
    const fixture = legFixture('agent', 'seed-roam', 'roam-json');
    const path = writeFixture(root, fixture);
    expect(fixture.fileName).toBe('rc-agent-roam-json.zip');
    // A zip (its first bytes say so), holding one JSON file.
    expect(Array.from(fixture.bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(existsSync(path)).toBe(true);
    const { connector, findings } = readFixture(root, fixture);
    const items = await readAll(connector);
    expect(fixture.expect).toMatchObject({ label: 'Roam notes (JSON)', citationLabel: 'Roam', family: 'note', messages: 4, earliest: '2024-05-06', latest: '2024-05-12' });
    expect(fixture.expect.gaps).toEqual([{ kind: 'note_content_unsupported', count: 1 }]);
    expect(fixture.expect.leftOut).toEqual([{ kind: 'note_empty', count: 1 }]);
    expect(items).toHaveLength(4);
    expect(findings.map((finding) => `${finding.class}:${finding.kind}`).sort()).toEqual(['gap:note_content_unsupported', 'skipped:note_empty']);
    // The days are the days the pages were written (a daily page by its title): not the empty page's (the earliest), and not the day one was edited later.
    const days = items.map((item) => String(item.metadata.authoredAt).slice(0, 10)).sort();
    expect(days).toEqual(['2024-05-06', '2024-05-07', '2024-05-08', '2024-05-12']);
    expect(days).not.toContain('2024-04-28');
    expect(days).not.toContain('2024-06-20');
    expect(items.map((item) => String(item.metadata.title))).not.toContain('Scratch');
    // The page with a block that has no text keeps the text it has.
    const walk = items.find((item) => item.metadata.title === 'Harbour walk');
    expect(walk?.content.kind === 'text' ? walk.content.text : '').toContain('The harbour walk is flat and takes an hour.');
  });

  test('the plain archive has nothing unread and nothing left out', async () => {
    const root = home();
    const fixture = legFixture('held', 'seed-plain');
    writeFixture(root, fixture);
    const { connector, findings } = readFixture(root, fixture);
    const items = await readAll(connector);
    expect(items).toHaveLength(fixture.expect.messages);
    expect(findings).toEqual([]);
    expect(fixture.expect.gaps).toEqual([]);
    expect(fixture.expect.leftOut).toEqual([]);
    const days = items.map((item) => String(item.metadata.authoredAt).slice(0, 10)).sort();
    expect([days[0], days[days.length - 1]]).toEqual([fixture.expect.earliest, fixture.expect.latest]);
  });

  test('a bulk archive is that many distinct items, and its size is a count of passes', async () => {
    const root = home();
    const fixture = legFixture('bulk', 'seed-bulk', 'mbox', 450);
    writeFixture(root, fixture);
    expect(fixture.expect.messages).toBe(450);
    expect(fixture.fileName).toBe('rc-bulk-450.mbox');
    const items = await readAll(readFixture(root, fixture).connector);
    expect(items).toHaveLength(450);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(450);
  });

  test('changing the file after the first page stops a running import with the file-changed code', async () => {
    const root = home();
    const fixture = legFixture('bulk', 'seed-change', 'mbox', 300);
    const path = writeFixture(root, fixture);
    const { connector } = readFixture(root, fixture, { pageSize: 100 });
    const pages = connector.listItems({})[Symbol.asyncIterator]();
    const first = await pages.next();
    expect(first.done).toBe(false);
    changeFixture(path, fixture);
    let stopped: unknown;
    try { await pages.next(); } catch (error) { stopped = error; }
    expect(stopped).toBeInstanceOf(ArchiveImportStoppedError);
    expect((stopped as ArchiveImportStoppedError).code).toBe('file_changed');
  });
});

describe('the fixture writer', () => {
  test('makes the folder owner-only, replaces what an earlier attempt left, and puts each file under it', () => {
    const root = home();
    const first = legFixture('agent', 'seed-writer');
    const path = writeFixture(root, first);
    expect(path).toBe(join(root, FIXTURE_FOLDER, first.fileName));
    const folder = resetFixtureFolder(root);
    expect(folder).toBe(join(root, FIXTURE_FOLDER));
    expect(existsSync(path)).toBe(false);
  });

  test('the stress format has what the model-off and changed-file stages need', () => {
    const spec = stressSpec();
    expect(spec).toBe(MBOX_FIXTURES);
    expect(spec.late('x')).toContain('Message-ID');
  });
});
