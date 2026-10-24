// How the archive import counts findings across a replay: a finding is counted
// once however the pages of a later pass are cut. A connector that tallies a
// kind per page tells where each occurrence is, so the store counts only those
// past what it counted before; a tally told at its first occurrence alone
// would drop the occurrences a longer replay page adds. Synthetic files only.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVE_COMMON_FINDINGS, type ArchiveImportFinding } from '../src/core/archive-formats.ts';
import { startArchiveImport } from '../src/workers/archive-import/start.ts';
import { ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const MBOX_TEXT = [
  'From sender@example.invalid Mon Jan  5 10:00:00 2015',
  'From: Sam Example <sam@example.invalid>',
  'Subject: Synthetic harbour note',
  'Message-ID: <one@example.invalid>',
  '',
  'The synthetic harbour opens at dawn.',
  '',
].join('\n');

function recorded() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-findings-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const state = new ArchiveImportStateStore({ path: join(base, 'data', 'archive-imports.json') });
  const exports = join(base, 'exports');
  mkdirSync(exports);
  writeFileSync(join(exports, 'mail.mbox'), MBOX_TEXT);
  const started = startArchiveImport({ state, path: join(exports, 'mail.mbox') });
  if (started.kind !== 'started') throw new Error(`expected a start, got ${started.kind}`);
  const archiveId = started.archive.archive_id;
  return { state, archiveId, findings: () => state.get(archiveId)!.findings };
}

const NOTICE = 'system_message';
const tally = (offsets: readonly number[], extra: Partial<ArchiveImportFinding> = {}): ArchiveImportFinding => ({
  kind: NOTICE,
  class: 'skipped',
  fileIndex: 0,
  offset: offsets[0]!,
  count: offsets.length,
  at: offsets,
  ...extra,
});

describe('a finding tallied per page is counted once, whatever pages a replay is cut into', () => {
  test('a replay page that holds counted occurrences and new ones counts only the new ones', () => {
    const f = recorded();
    // The first pass told notices 1 and 2 as one tally, then died before its cursor was kept.
    f.state.recordFindings(f.archiveId, [tally([100, 200])]);
    expect(f.findings().skipped).toEqual({ [NOTICE]: 2 });
    // The replay reads one longer page: notices 1, 2 and 3 as one tally, at notice 1.
    f.state.recordFindings(f.archiveId, [tally([100, 200, 300])]);
    expect(f.findings().skipped).toEqual({ [NOTICE]: 3 });
    expect(f.findings().through).toEqual({ file_index: 0, offset: 300 });
    // Told again, once more, changes nothing.
    f.state.recordFindings(f.archiveId, [tally([100, 200, 300])]);
    f.state.recordFindings(f.archiveId, [tally([200]), tally([300])]);
    expect(f.findings().skipped).toEqual({ [NOTICE]: 3 });
  });

  test('replay pages cut shorter count each occurrence once as well', () => {
    const f = recorded();
    f.state.recordFindings(f.archiveId, [tally([100, 200, 300, 400])]);
    f.state.recordFindings(f.archiveId, [tally([100, 200])]);
    f.state.recordFindings(f.archiveId, [tally([300, 400, 500])]);
    expect(f.findings().skipped).toEqual({ [NOTICE]: 5 });
  });

  test('several kinds told by one page count by their own occurrences, however they interleave', () => {
    const f = recorded();
    const gap = (offsets: readonly number[]): ArchiveImportFinding => tally(offsets, { kind: ARCHIVE_COMMON_FINDINGS.assumption, class: 'gap' });
    f.state.recordFindings(f.archiveId, [tally([100, 300]), gap([200, 400])]);
    f.state.recordFindings(f.archiveId, [tally([100, 300, 500]), gap([200, 400, 600])]);
    expect(f.findings().skipped).toEqual({ [NOTICE]: 3 });
    expect(f.findings().gaps).toEqual({ [ARCHIVE_COMMON_FINDINGS.assumption]: 3 });
    expect(f.findings().gaps_by_file).toEqual({ '0': { [ARCHIVE_COMMON_FINDINGS.assumption]: 3 } });
    expect(f.findings().through).toEqual({ file_index: 0, offset: 600 });
  });

  test('a gap sample names the first occurrence that was counted, not one counted before', () => {
    const f = recorded();
    f.state.recordFindings(f.archiveId, [tally([100, 200], { kind: ARCHIVE_COMMON_FINDINGS.assumption, class: 'gap' })]);
    f.state.recordFindings(f.archiveId, [tally([100, 200, 300], { kind: ARCHIVE_COMMON_FINDINGS.assumption, class: 'gap' })]);
    expect(f.findings().samples).toEqual([
      { kind: ARCHIVE_COMMON_FINDINGS.assumption, file_index: 0, offset: 100 },
      { kind: ARCHIVE_COMMON_FINDINGS.assumption, file_index: 0, offset: 300 },
    ]);
  });

  test('occurrences are placed in the file they are in', () => {
    const f = recorded();
    f.state.recordFindings(f.archiveId, [tally([900], { fileIndex: 0 })]);
    // Another file's offset 100 is not before this file's offset 900.
    f.state.recordFindings(f.archiveId, [tally([100, 200], { fileIndex: 1 })]);
    expect(f.findings().skipped).toEqual({ [NOTICE]: 3 });
    expect(f.findings().through).toEqual({ file_index: 1, offset: 200 });
  });

  test('a finding with no occurrences listed is counted as before: all of its count at its one position', () => {
    const f = recorded();
    const media: ArchiveImportFinding = { kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap', fileIndex: 0, offset: 100, count: 4 };
    f.state.recordFindings(f.archiveId, [media]);
    f.state.recordFindings(f.archiveId, [media]);
    expect(f.findings().gaps).toEqual({ [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 4 });
    // Findings at one position, in one call, all count.
    f.state.recordFindings(f.archiveId, [
      { kind: 'a', class: 'skipped', fileIndex: 0, offset: 500 },
      { kind: 'b', class: 'skipped', fileIndex: 0, offset: 500 },
    ]);
    expect(f.findings().skipped).toEqual({ a: 1, b: 1 });
  });
});
