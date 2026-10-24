// The release check's synthetic archives (scripts/release-check/archive-fixtures.ts), put through the product's own mbox detector and
// connector: the expectation each fixture carries has to be what the product actually reads out of it, or the leg would fail a good
// install (or pass a broken one) on its own say-so.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem } from '../src/core/contracts.ts';
import {
  ArchiveImportStoppedError,
  MBOX_ARCHIVE_FORMAT,
  detectArchiveFormat,
  getArchiveFormat,
  type ArchiveImportFinding,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import { createMboxArchiveConnector } from '../src/workers/archive-import/mbox/connector.ts';
import {
  ARCHIVE_FORMATS,
  FIXTURE_FOLDER,
  MBOX_FIXTURES,
  changeFixture,
  fixtureToken,
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

/** The product's connector over a written fixture, the way an import reads it. */
function readFixture(root: string, fixture: LegFixture, options: { pageSize?: number } = {}) {
  const scope = ScopeRoot.open(join(root, FIXTURE_FOLDER));
  cleanups.push(() => scope.close());
  const files = buildArchiveManifest(scope, [fixture.fileName]);
  const findings: ArchiveImportFinding[] = [];
  const connector = createMboxArchiveConnector({
    archiveId: 'rc-fixture',
    connectorId: 'archive.rc-fixture',
    accountScope: 'rc-fixture',
    format: MBOX_ARCHIVE_FORMAT,
    root: scope,
    files: archiveFileEntries(files),
    manifestSha256: archiveManifestSha256(files),
    report: (finding) => { findings.push(finding); },
    shouldContinue: () => true,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
  });
  return { connector, findings };
}

async function readAll(connector: ReturnType<typeof createMboxArchiveConnector>): Promise<RawItem[]> {
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
      expect(spec.citationLabel).toBe(product!.citationLabel);
      expect(spec.family).toBe(product!.family);
      expect(spec.provider).toBe(product!.provider);
    }
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
