// The engine's SQLite mmap policy follows the role on Linux. RSS restarts
// measure anonymous memory so mapped file pages are excluded.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ENGINE_ROLE_ENV } from '../src/core/engine-split.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { SQLITE_MMAP_BYTES, sqliteMmapEnabled } from '../src/workers/connector-store/sqlite-mmap.ts';
import { engineMemoryRss } from '../src/workers/engine-split/rss-restart.ts';

describe('mapped SQLite reads', () => {
  const linux = process.platform === 'linux';

  for (const [role, setting, enabled] of [
    ['background', undefined, false],
    ['background', 'on', linux],
    ['background', 'off', false],
    ['front', undefined, linux],
    ['front', 'on', linux],
    ['front', 'off', false],
  ] as const) {
    test(`${role} role with mmap setting ${setting ?? 'unset'}`, () => {
      expect(sqliteMmapEnabled({ [ENGINE_ROLE_ENV]: role, OLYMPUS_SQLITE_MMAP: setting })).toBe(enabled);
    });
  }

  test('a store file opened outside the split is mapped on Linux by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-'));
    try {
      const store = new LocalConnectorStore({ dbPath: join(dir, 's.sqlite'), corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
      const mapped = ((store as unknown as { db: Database }).db.query('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size;
      store.close();
      expect(mapped).toBe(linux ? SQLITE_MMAP_BYTES : 0);
      expect(sqliteMmapEnabled({ OLYMPUS_SQLITE_MMAP: 'off' })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('read-pool connections use the mmap default of the process that started them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-pool-'));
    try {
      const path = join(dir, 'store.sqlite');
      const db = new Database(path);
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY)');
      db.close();
      const script = `
        import { readOnPool, shutdownReadPool } from './src/workers/connector-store/off-thread-reads.ts';
        try {
          const row = await readOnPool(process.argv[1], { sql: 'PRAGMA mmap_size', params: [], mode: 'get' });
          console.log(JSON.stringify(row));
        } finally {
          shutdownReadPool();
        }
      `;
      for (const role of ['background', 'front'] as const) {
        const child = Bun.spawnSync([process.execPath, '--eval', script, path], {
          cwd: join(import.meta.dir, '..'),
          env: { ...process.env, [ENGINE_ROLE_ENV]: role, OLYMPUS_SQLITE_MMAP: undefined },
          stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        expect(JSON.parse(child.stdout.toString()), role).toEqual({ mmap_size: role === 'front' && linux ? SQLITE_MMAP_BYTES : 0 });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test("the restart's memory is anonymous RSS on Linux: never more than total RSS", () => {
    const anonymous = engineMemoryRss();
    expect(anonymous).toBeGreaterThan(0);
    expect(anonymous).toBeLessThanOrEqual(process.memoryUsage.rss());
  });
});
