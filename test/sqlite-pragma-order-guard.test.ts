import { Glob } from 'bun';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSqliteBusyTimeoutOpens, scanSqlitePragmaOrder } from './helpers/sqlite-pragma-audit.ts';

const repoRoot = join(import.meta.dir, '..');

// Files that still open a connection with no busy_timeout at all. The debt is
// now ZERO, and the list may only shrink: set the pragma at the site and delete
// its entry rather than adding one, because a connection with timeout 0 does
// not retry SQLITE_BUSY. An empty list is the point — it turns the assertion
// below into "no connection anywhere opens without a timeout".
const FILES_PENDING_BUSY_TIMEOUT: string[] = [];

// Both roots that open live stores. scripts/ is in scope because an operator
// tool opens the very databases the workers are writing — the WhatsApp identity
// backfill takes the same connector store the live-drain unit holds — so a
// guard that stopped at src/ reported green about half the openers it claims to
// cover, which is the failure mode a guard exists to prevent.
const SCANNED_GLOBS = ['src/**/*.ts', 'scripts/**/*.ts'];

function scanOpeners(scan: (path: string, source: string) => { line: number; reason: string }[]): string[] {
  return SCANNED_GLOBS
    .flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: repoRoot })])
    .flatMap((relativePath) => {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      return scan(relativePath, source).map((entry) => `${relativePath}:${entry.line}: ${entry.reason}`);
    })
    .sort();
}

test('every sqlite connection sets busy_timeout before any lock-taking pragma', () => {
  expect(scanOpeners(scanSqlitePragmaOrder)).toEqual([]);
});

test('every sqlite connection sets busy_timeout at all', () => {
  const files = [...new Set(scanOpeners(scanSqliteBusyTimeoutOpens)
    .map((entry) => entry.split(':')[0]!))].sort();

  expect(files).toEqual([...FILES_PENDING_BUSY_TIMEOUT].sort());
});

test('pragma audit flags late busy_timeout and missing busy_timeout, ignoring introspection pragmas', () => {
  const source = [
    `db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');`,
    `db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');`,
    `db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');`,
    'db.query(`PRAGMA table_info(${table})`).all();',
    `db.query('PRAGMA foreign_key_check').get();`,
  ].join('\n');

  expect(scanSqlitePragmaOrder('src/fixture.ts', source).map((entry) => ({ line: entry.line, reason: entry.reason })))
    .toEqual([
      { line: 1, reason: 'busy_timeout must be the first pragma, but "PRAGMA foreign_keys = ON" runs first with timeout 0' },
      { line: 3, reason: 'sets journal_mode without ever setting busy_timeout on the connection' },
    ]);
});

test('pragma audit judges multi-line template literals and literals mixed with DDL', () => {
  const source = [
    'db.exec(`',
    '  PRAGMA journal_mode = WAL;',
    '  PRAGMA busy_timeout = 10000;',
    '`);',
    `db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS meta(id INTEGER);');`,
    'other.exec(`',
    '  PRAGMA busy_timeout = 10000;',
    '  PRAGMA journal_mode = WAL;',
    '  CREATE TABLE IF NOT EXISTS ok(id INTEGER);',
    '`);',
  ].join('\n');

  expect(scanSqlitePragmaOrder('src/fixture.ts', source).map((entry) => ({ line: entry.line, reason: entry.reason })))
    .toEqual([
      { line: 1, reason: 'busy_timeout must be the first pragma, but "PRAGMA journal_mode = WAL" runs first with timeout 0' },
      { line: 5, reason: 'sets journal_mode without ever setting busy_timeout on the connection' },
    ]);
});

test('open-site audit flags a connection that executes no pragma at all', () => {
  const source = [
    'const reader = new Database(path, { readonly: true });',
    'reader.query(`SELECT 1`).get();',
    'const writer = new Database(path, { create: true });',
    `writer.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');`,
  ].join('\n');

  expect(scanSqliteBusyTimeoutOpens('src/fixture.ts', source))
    .toEqual([{ line: 1, reason: 'opens a connection that never sets busy_timeout' }]);
});
