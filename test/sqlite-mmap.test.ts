// SQLite mmap is opt-in on Linux for every engine role. RSS restarts
// measure anonymous memory so mapped file pages are excluded.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ENGINE_ROLE_ENV } from '../src/core/engine-split.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { SQLITE_MMAP_BYTES, sqliteMmapPolicy } from '../src/workers/connector-store/sqlite-mmap.ts';
import { engineMemoryRss } from '../src/workers/engine-split/rss-restart.ts';

describe('mapped SQLite reads', () => {
  const linux = process.platform === 'linux';

  for (const [role, setting, enabled] of [
    ['background', undefined, false],
    ['background', 'on', linux],
    ['background', 'off', false],
    ['front', undefined, false],
    ['front', 'on', linux],
    ['front', 'off', false],
    [undefined, undefined, false],
    [undefined, 'on', linux],
    [undefined, 'off', false],
  ] as const) {
    test(`${role ?? 'unset'} role with mmap setting ${setting ?? 'unset'}`, () => {
      const reason = setting === 'off' ? 'OLYMPUS_SQLITE_MMAP=off'
        : !linux ? 'Linux only'
        : setting === 'on' ? 'OLYMPUS_SQLITE_MMAP=on' : 'default';
      expect(sqliteMmapPolicy({ [ENGINE_ROLE_ENV]: role, OLYMPUS_SQLITE_MMAP: setting })).toEqual({ enabled, reason });
    });
  }

  test('a store file opened outside the split is unmapped by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-'));
    const previousSetting = process.env.OLYMPUS_SQLITE_MMAP;
    delete process.env.OLYMPUS_SQLITE_MMAP;
    try {
      const store = new LocalConnectorStore({ dbPath: join(dir, 's.sqlite'), corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
      const mapped = ((store as unknown as { db: Database }).db.query('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size;
      store.close();
      expect(mapped).toBe(0);
    } finally {
      if (previousSetting !== undefined) process.env.OLYMPUS_SQLITE_MMAP = previousSetting;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('read-pool connections inherit the mmap setting of the process that started them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mmap-pool-'));
    try {
      const path = join(dir, 'store.sqlite');
      const db = new Database(path);
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY)');
      db.close();
      const script = `
        import { readOnPool, shutdownReadPool } from './src/workers/connector-store/off-thread-reads.ts';
        import { sqliteMmapWorkerSource } from './src/workers/connector-store/sqlite-mmap.ts';
        try {
          const row = await readOnPool(process.argv[1], { sql: 'PRAGMA mmap_size', params: [], mode: 'get' });
          const pragma = sqliteMmapWorkerSource('/*olympus-mmap-pragma*/');
          console.log(JSON.stringify({ row, pragma }));
        } finally {
          shutdownReadPool();
        }
      `;
      for (const [role, setting] of [
        ['background', undefined], ['front', undefined], ['front', 'on'],
      ] as const) {
        const child = Bun.spawnSync([process.execPath, '--eval', script, path], {
          cwd: join(import.meta.dir, '..'),
          env: { ...process.env, [ENGINE_ROLE_ENV]: role, OLYMPUS_SQLITE_MMAP: setting },
          stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        const { row, pragma } = JSON.parse(child.stdout.toString());
        const enabled = linux && setting === 'on';
        expect(row, role).toEqual({ mmap_size: enabled ? SQLITE_MMAP_BYTES : 0 });
        if (enabled) expect(pragma).toContain(`PRAGMA mmap_size = ${SQLITE_MMAP_BYTES}`);
        else expect(pragma).toBe('');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test("the restart's memory is anonymous RSS on Linux: never more than total RSS", () => {
    const anonymous = engineMemoryRss();
    expect(anonymous).toBeGreaterThan(0);
    expect(anonymous).toBeLessThanOrEqual(process.memoryUsage.rss());
  });
});
