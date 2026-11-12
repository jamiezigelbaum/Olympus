// OLYMPUS_TEST_LANE: deploy
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveFormatConnector, getArchiveFormat, type ArchiveImportFinding } from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { registerArchiveFormatConnectors } from '../src/workers/archive-import/format-connectors.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest, probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import { detectArchiveFormat } from '../src/core/archive-formats.ts';
import { FIXTURE_FOLDER, writeFixture } from '../scripts/release-check/archive-fixtures.ts';
import { SCALE_ENCODINGS, SCALE_FIRST, SCALE_LAST, scaleFixture, scaleReadwise } from '../scripts/release-check/archive-scale-fixtures.ts';
import { startFakeReadwise, type FakeReadwise } from '../scripts/release-check/readwise-fake.ts';
import { ReadwiseApiClient, ReadwiseApiError } from '../src/workers/readwise/api.ts';

const dirs: string[] = [];
let fake: FakeReadwise | undefined;
afterEach(() => { fake?.stop(); fake = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

for (const format of ['mbox', 'roam', 'reflect-json', 'reflect-markdown'] as const) {
  test(`scale ${format}: real parser counts, dates, exact gaps and seeded bytes without a VM`, async () => {
    const fx = scaleFixture(format, 'seed-one');
    expect(digest(scaleFixture(format, 'seed-one').bytes)).toBe(digest(fx.bytes));
    expect(digest(scaleFixture(format, 'seed-two').bytes)).not.toBe(digest(fx.bytes));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'rc-scale-'))); dirs.push(home);
    writeFixture(home, fx);
    registerArchiveFormatConnectors();
    const root = ScopeRoot.open(join(home, FIXTURE_FOLDER));
    try {
      const detected = detectArchiveFormat(probeArchivePath(root, fx.fileName));
      expect(detected.kind).toBe('match');
      if (detected.kind === 'match') expect(detected.format.id).toBe(fx.format);
      const files = buildArchiveManifest(root, [fx.fileName]);
      const findings: ArchiveImportFinding[] = [];
      const connector = archiveFormatConnector(fx.format)!({ archiveId: 'scale-test', connectorId: 'archive.scale-test', accountScope: 'scale-test',
        format: getArchiveFormat(fx.format)!, root, files: archiveFileEntries(files), manifestSha256: archiveManifestSha256(files),
        report: finding => findings.push(finding), shouldContinue: () => true });
      const ids = new Set<string>();
      const days: string[] = [];
      let count = 0;
      let undated = 0;
      let noId = 0;
      const messageIds = new Map<string, number>();
      const decoded = new Set<string>();
      for await (const page of connector.listItems({})) for (const item of page.items) {
        count++;
        ids.add(item.identity.providerItemId);
        const date = item.metadata.authoredAt;
        if (typeof date === 'string') days.push(date.slice(0, 10)); else undated++;
        if (format === 'mbox') {
          if (!item.metadata.messageId) noId++;
          else messageIds.set(String(item.metadata.messageId), (messageIds.get(String(item.metadata.messageId)) ?? 0) + 1);
          const text = item.content.kind === 'text' ? item.content.text : '';
          for (const encoding of SCALE_ENCODINGS) if (text.includes(encoding.decoded)) decoded.add(encoding.charset);
        }
      }
      expect(count).toBe(fx.expect.messages);
      expect(ids.size).toBe(count);
      days.sort();
      expect(days[0]).toBe(SCALE_FIRST);
      expect(days.at(-1)).toBe(SCALE_LAST);
      const gaps: Record<string, number> = {};
      for (const finding of findings) gaps[finding.kind] = (gaps[finding.kind] ?? 0) + (finding.count ?? 1);
      expect(gaps).toEqual(format === 'mbox' ? { message_unreadable: 5 } : {});
      if (format === 'mbox') {
        expect(undated).toBe(5);
        expect(noId).toBe(20);
        expect([...messageIds.values()].filter(n => n === 2)).toHaveLength(10);
        expect(decoded.size).toBe(SCALE_ENCODINGS.length);
        const raw = Buffer.from(fx.bytes).toString('utf8');
        for (const text of ['quoted-printable', 'base64', 'Shift_JIS', 'ISO-8859-1', 'windows-1252', 'UTF-8', '>From ', '>>From ', '\r\n', ' EST', ' GMT', ' -0000']) expect(raw).toContain(text);
        expect(raw).toMatch(/Date: [^\n]* 94 12:00:00/);
      }
    } finally { root.close(); }
  }, 120_000);
}

test('scaled Readwise serves every book and document across real API cursors, with one retry-after refusal', async () => {
  const scaled = scaleReadwise('seed-one');
  expect(scaleReadwise('seed-one')).toEqual(scaled);
  expect(scaleReadwise('seed-two').token).not.toBe(scaled.token);
  expect(scaled.books).toHaveLength(1_500);
  expect(scaled.documents).toHaveLength(800);
  expect(scaled.items).toBe(3_800);
  fake = startFakeReadwise({ port: 0, token: 'scale-token', ...scaled, pageSize: 100, retryOnce: true });
  const base = `http://127.0.0.1:${fake.port}`;
  const api = new ReadwiseApiClient({ token: 'scale-token', apiV2BaseUrl: `${base}/api/v2/`, readerApiV3BaseUrl: `${base}/api/v3/` });
  const documents = await api.fetchReaderDocuments({});
  expect(documents.documents).toEqual(scaled.documents);
  expect(documents.requestCount).toBeGreaterThan(1);
  try { await api.fetchExportBooks({}); throw new Error('expected 429'); }
  catch (error) {
    expect(error).toBeInstanceOf(ReadwiseApiError);
    expect((error as ReadwiseApiError).status).toBe(429);
    expect((error as ReadwiseApiError).retryAfter).toBe('1');
  }
  const books = await api.fetchExportBooks({});
  expect(books.books).toEqual(scaled.books);
  expect(books.requestCount).toBe(15);
  const second = await api.fetchExportBooks({});
  expect(second.books).toEqual(scaled.books);
});
