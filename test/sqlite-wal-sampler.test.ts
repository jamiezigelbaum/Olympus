// The loop-stall receipt's SQLite side (16 Nov 2026): settings once per file,
// then WAL size and the longest-open read snapshot whenever either is large.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLITE_WAL_NOTABLE_BYTES, sampleSqliteFiles } from '../src/workers/engine/sqlite-wal-sampler.ts';

test('settings are logged once per file, and a WAL past the mark is named with its size, never its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-wal-sampler-'));
  try {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(`${dbPath}-wal`, '');
    const lines: string[] = [];
    const seen = new Set<string>();
    const files = [{ label: 'telegram-internal', dbPath, settings: () => ({ journal_mode: 'wal', synchronous: 2, wal_autocheckpoint: 1000 }) }];
    sampleSqliteFiles(files, seen, (line) => lines.push(line));
    expect(lines).toEqual(['[olympus] sqlite settings: telegram-internal journal_mode=wal synchronous=2 wal_autocheckpoint=1000']);
    truncateSync(`${dbPath}-wal`, SQLITE_WAL_NOTABLE_BYTES);
    sampleSqliteFiles(files, seen, (line) => lines.push(line));
    expect(lines.slice(1)).toEqual([`[olympus] sqlite wal: telegram-internal wal_bytes=${SQLITE_WAL_NOTABLE_BYTES} oldest_read_ms=0`]);
    expect(lines.join('\n')).not.toContain(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
