import { Glob } from 'bun';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createXBookmarksConnectorStore,
  createXBookmarksSourceConnector,
} from '../src/workers/x-bookmarks/index.ts';

const repoRoot = join(import.meta.dir, '..');
const ACCOUNT = 'owner@example.com';

/**
 * Slice 2 deleted the pre-contract source indexes. Every remaining SQLite
 * owner is therefore enrolled in the deterministic-close requirement.
 */
const FROZEN_LEGACY_INDEXES: ReadonlySet<string> = new Set();

describe('deterministic sqlite store close', () => {
  test('a closed store hands over a fully checkpointed file, with no GC reap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-deterministic-close-'));
    const storePath = join(root, 'store.sqlite');

    let store: ReturnType<typeof createXBookmarksConnectorStore> | undefined =
      createXBookmarksConnectorStore(storePath);
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: Array.from({ length: 60 }, (_, index) => ({
        id: `handover-${index}`,
        text: `private handover fixture text ${index} `.repeat(40),
        sourceVersion: `handover-${index}-v1`,
      })),
    }), { fetchContent: true });
    store.close();
    store = undefined;

    // No Bun.gc(), no retry loop, no sleep: the assertion is that close()
    // itself left nothing for a later reap to checkpoint under an exclusive
    // lock. That reap window is what killed CLI subprocesses with SQLITE_BUSY
    // before their own busy_timeout could apply (2026-07-26 flake).
    expect(walBytes(storePath)).toBe(0);

    // The handover proof: another process opens the file the instant close()
    // returned and reads the complete seeded content out of the main database.
    const reader = Bun.spawnSync([process.execPath, '-e', READER_SCRIPT, storePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(new TextDecoder().decode(reader.stderr)).toBe('');
    expect(reader.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(reader.stdout))).toEqual({ items: 60 });
  }, 60_000);

  test('every sqlite store closes through the shared deterministic helper', () => {
    const offenders = [...new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })]
      .filter((relativePath) => relativePath !== 'src/core/sqlite-store.ts')
      .filter((relativePath) => !FROZEN_LEGACY_INDEXES.has(relativePath))
      .flatMap((relativePath) => {
        const source = readFileSync(join(repoRoot, relativePath), 'utf8');
        if (!source.includes("from 'bun:sqlite'")) return [];
        return source.split('\n')
          .map((line, index) => ({ line, number: index + 1 }))
          .filter((entry) => /^\s*(?:this\.)?db\.close\(\s*\)\s*;/.test(entry.line))
          .map((entry) => `${relativePath}:${entry.number}`);
      })
      .sort();

    // closeSqliteStore is the only sanctioned close: a bare db.close() leaves
    // an uncheckpointed WAL whenever bun:sqlite could not finalize every
    // cached statement, which makes the file unsafe to hand to another
    // process until GC happens to reap the connection.
    expect(offenders).toEqual([]);
  });
});

const READER_SCRIPT = `
import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1], { readonly: true });
// busy_timeout 0: fail immediately rather than papering over a lock still
// held by a store that did not finish closing.
db.exec('PRAGMA busy_timeout = 0;');
const row = db.query('SELECT COUNT(*) AS items FROM items').get();
process.stdout.write(JSON.stringify({ items: row.items }));
db.close();
`;

function walBytes(dbPath: string): number {
  return existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
}
