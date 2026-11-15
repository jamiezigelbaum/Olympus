// The engine's SQLite files are mapped for reads on Linux (sqlite-mmap.ts),
// and the RSS restart then measures anonymous memory, so mapped file pages
// never read as the engine's own memory.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { SQLITE_MMAP_BYTES, sqliteMmapEnabled } from '../src/workers/connector-store/sqlite-mmap.ts';
import { engineMemoryRss } from '../src/workers/engine-split/rss-restart.ts';

describe('mapped SQLite reads', () => {
  test('a store file is mapped on Linux, and not when turned off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-'));
    try {
      const store = new LocalConnectorStore({ dbPath: join(dir, 's.sqlite'), corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
      const mapped = ((store as unknown as { db: Database }).db.query('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size;
      store.close();
      expect(mapped).toBe(process.platform === 'linux' ? SQLITE_MMAP_BYTES : 0);
      expect(sqliteMmapEnabled({ OLYMPUS_SQLITE_MMAP: 'off' })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the restart's memory is anonymous RSS on Linux: never more than total RSS", () => {
    const anonymous = engineMemoryRss();
    expect(anonymous).toBeGreaterThan(0);
    expect(anonymous).toBeLessThanOrEqual(process.memoryUsage.rss());
  });
});
