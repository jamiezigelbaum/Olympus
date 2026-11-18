// The engine's SQLite files are mapped for reads on Linux (sqlite-mmap.ts),
// and the RSS restart then measures anonymous memory, so mapped file pages
// never read as the engine's own memory.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { configureSqliteMmap, SQLITE_MMAP_BYTES, sqliteMmapPolicy } from '../src/workers/connector-store/sqlite-mmap.ts';
import { readOnPool, releaseOffThreadReads } from '../src/workers/connector-store/off-thread-reads.ts';
import { engineMemoryRss } from '../src/workers/engine-split/rss-restart.ts';

describe('mapped SQLite reads', () => {
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;

  test.each([
    [undefined, 'linux', 'on', SQLITE_MMAP_BYTES],
    ['on', 'linux', 'on', SQLITE_MMAP_BYTES],
    ['off', 'linux', 'off', 0],
    ['bounded', 'linux', 'bounded', 128 * MiB],
    ['unknown', 'linux', 'on', SQLITE_MMAP_BYTES],
    [undefined, 'darwin', 'off', 0],
    ['on', 'darwin', 'off', 0],
    ['off', 'darwin', 'off', 0],
    ['bounded', 'darwin', 'off', 0],
  ] as const)('selects the policy for %s on %s', (value, platform, mode, perFileBytes) => {
    expect(sqliteMmapPolicy(value, platform, 8 * GiB, 8, 4096)).toMatchObject({ mode, perFileBytes });
  });

  test.each([
    [8 * GiB, 3, 65_536, GiB, 357_892_096],
    [64 * GiB, 3, 4096, 4 * GiB, 1_431_654_400],
    [64 * GiB, 1, 4096, 4 * GiB, SQLITE_MMAP_BYTES],
    [GiB, 8, 4096, 128 * MiB, 16 * MiB],
    [GiB, 9, 4096, 128 * MiB, 0],
    [GiB, 0, 4096, 128 * MiB, 0],
    [GiB, 1, 0, 128 * MiB, 0],
  ])('rounds the bounded share for %i bytes across %i files with %i-byte pages', (memory, files, page, budgetBytes, perFileBytes) => {
    expect(sqliteMmapPolicy('bounded', 'linux', memory, files, page)).toMatchObject({ files, budgetBytes, perFileBytes });
  });

  test('a store file uses the Linux ceiling by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-'));
    try {
      const store = new LocalConnectorStore({ dbPath: join(dir, 's.sqlite'), corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
      const mapped = ((store as unknown as { db: Database }).db.query('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size;
      store.close();
      expect(mapped).toBe(process.platform === 'linux' ? SQLITE_MMAP_BYTES : 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform !== 'linux')('a read-pool connection gets the same bounded limit as its parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-pool-'));
    const dbPath = join(dir, 's.sqlite');
    const before = process.env.OLYMPUS_SQLITE_MMAP;
    process.env.OLYMPUS_SQLITE_MMAP = 'bounded';
    try {
      const paths = [dbPath, join(dir, 'other.sqlite'), join(dir, 'third.sqlite')];
      const policy = configureSqliteMmap([...paths, dbPath, ':memory:']);
      expect(policy.files).toBe(3);
      expect(policy.perFileBytes).toBeGreaterThan(0);
      expect(policy.perFileBytes).toBeLessThan(SQLITE_MMAP_BYTES);
      const store = new LocalConnectorStore({ dbPath, corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
      try {
        const db = (store as unknown as { db: Database }).db;
        expect(db.query('PRAGMA mmap_size').get()).toEqual({ mmap_size: policy.perFileBytes });
        const read = { sql: 'PRAGMA mmap_size', params: [], mode: 'get' } as const;
        expect(await readOnPool(dbPath, read)).toEqual({ mmap_size: policy.perFileBytes });
      } finally {
        releaseOffThreadReads(dbPath);
        store.close();
      }
    } finally {
      if (before === undefined) delete process.env.OLYMPUS_SQLITE_MMAP;
      else process.env.OLYMPUS_SQLITE_MMAP = before;
      configureSqliteMmap([]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the restart's memory is anonymous RSS on Linux: never more than total RSS", () => {
    const anonymous = engineMemoryRss();
    expect(anonymous).toBeGreaterThan(0);
    expect(anonymous).toBeLessThanOrEqual(process.memoryUsage.rss());
  });
});
