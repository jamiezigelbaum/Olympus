// The upgrade copies every store itself, after the previous version stopped
// and before the new one starts, as files (cloned where the disk can): not
// with VACUUM INTO inside the new engine's boot, where it took 37 minutes at
// 39 GB and held the engine's only loop (gate7, 13 Nov). The boot then takes
// no copy of its own, and a failed upgrade puts the copies back.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeSchemaBackupsSince, restoreSchemaBackupsSince } from '../src/core/boot-progress.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { readSqliteSchemaVersion, runSqliteMigrations, type SqliteMigration } from '../src/core/sqlite-migrations.ts';
import { copyStoresBeforeUpgrade, olympusStoreFiles, upgradeCopyExists, upgradeCopyPath } from '../src/core/upgrade-store-copies.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'olympus-upgrade-copies-'));
  roots.push(home);
  const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') };
  const root = olympusDataRoot(env);
  mkdirSync(join(root, 'accounts', 'gmail', '1'), { recursive: true });
  mkdirSync(join(root, 'models'), { recursive: true });
  return { env, root };
}

const MIGRATIONS: SqliteMigration[] = [
  { version: 1, name: 'create', up(db) { db.exec('CREATE TABLE kept (value TEXT)'); } },
  { version: 2, name: 'rewrite', up(db) { db.exec('DELETE FROM kept; ALTER TABLE kept ADD COLUMN extra TEXT'); } },
];

function storeAtV1(path: string, rows: number, keepWal = false): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  runSqliteMigrations(db, 'fixture', [MIGRATIONS[0]!], { log: () => {} });
  for (let i = 0; i < rows; i += 1) db.query('INSERT INTO kept (value) VALUES (?)').run(`row ${i}`);
  if (!keepWal) db.close();
  return db;
}

describe('the upgrade copies the stores before the new version starts', () => {
  test('every store under the data root is copied whole, its WAL folded in first; models and copies are not stores', () => {
    const { env, root } = fixture();
    const top = join(root, 'tier-ledger.sqlite');
    const account = join(root, 'accounts', 'gmail', '1', 'connector-store.sqlite');
    storeAtV1(top, 3);
    // A store whose writer stopped without folding its WAL in.
    const open = storeAtV1(account, 5, true);
    expect(statSync(`${account}-wal`).size).toBeGreaterThan(0);
    open.close(false as never);
    Bun.write(join(root, 'models', 'model.sqlite'), 'not a store');
    expect(olympusStoreFiles(env)).toEqual([account, top]);
    const copied = copyStoresBeforeUpgrade(env, { bunBin: process.execPath });
    expect(copied.stores).toBe(2);
    for (const [path, rows] of [[top, 3], [account, 5]] as const) {
      const copy = new Database(upgradeCopyPath(path), { readonly: true });
      expect((copy.query('SELECT COUNT(*) AS n FROM kept').get() as { n: number }).n).toBe(rows);
      copy.close();
    }
    // A copy is not copied again by the next upgrade.
    expect(olympusStoreFiles(env)).toEqual([account, top]);
    expect(readdirSync(dirname(account)).filter((name) => name.endsWith('.partial'))).toEqual([]);
  });

  test('the boot takes no copy of its own for a file the upgrade copied, and a failed upgrade puts the copy back', () => {
    const { env, root } = fixture();
    const store = join(root, 'tier-ledger.sqlite');
    storeAtV1(store, 4);
    const since = Date.now() - 1;
    copyStoresBeforeUpgrade(env, { bunBin: process.execPath });
    const lines: string[] = [];
    const db = new Database(store);
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: (line) => lines.push(line) });
    db.close();
    expect(existsSync(`${store}.pre-schema-1.bak`)).toBe(false);
    expect(lines.at(-1)).toMatch(/copied by the upgrade, migrated in \d+ ms$/);
    expect(restoreSchemaBackupsSince(env, since)).toEqual(['tier-ledger.sqlite']);
    const back = new Database(store, { readonly: true });
    expect(readSqliteSchemaVersion(back, 'fixture')).toBe(1);
    expect((back.query('SELECT COUNT(*) AS n FROM kept').get() as { n: number }).n).toBe(4);
    back.close();
    expect(existsSync(upgradeCopyPath(store))).toBe(false);
  });

  test('a successful upgrade removes the copies', () => {
    const { env, root } = fixture();
    const store = join(root, 'tier-ledger.sqlite');
    storeAtV1(store, 1);
    const since = Date.now() - 1;
    copyStoresBeforeUpgrade(env, { bunBin: process.execPath });
    expect(removeSchemaBackupsSince(env, since)).toBe(1);
    expect(existsSync(upgradeCopyPath(store))).toBe(false);
  });

  test('a store a writer died inside is recovered before it is copied, not copied half written', () => {
    const { env, root } = fixture();
    const store = join(root, 'app-release-log.sqlite');
    const db = new Database(store, { create: true });
    db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE kept (value TEXT);');
    db.transaction(() => { for (let i = 0; i < 2000; i += 1) db.query('INSERT INTO kept (value) VALUES (?)').run('committed'); })();
    db.close();
    // A writer whose uncommitted update spills into the file, and that dies
    // without rolling back: its journal is left hot, the file half changed.
    const writer = Bun.spawnSync([process.execPath, '-e', `
      const { Database } = require('bun:sqlite');
      const db = new Database(${JSON.stringify(store)});
      db.exec("PRAGMA cache_size = 1; BEGIN; UPDATE kept SET value = 'uncommitted';");
      process.kill(process.pid, 'SIGKILL');
    `]);
    expect(writer.signalCode).toBe('SIGKILL');
    expect(existsSync(`${store}-journal`)).toBe(true);
    copyStoresBeforeUpgrade(env, { bunBin: process.execPath });
    const copy = new Database(upgradeCopyPath(store), { readonly: true });
    expect(copy.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(copy.query('SELECT value, COUNT(*) AS n FROM kept GROUP BY value').all()).toEqual([{ value: 'committed', n: 2000 }]);
    copy.close();
  }, 30_000);

  test('a copy an earlier upgrade left behind does not stand in for a new one', () => {
    const { env, root } = fixture();
    const store = join(root, 'tier-ledger.sqlite');
    storeAtV1(store, 2);
    copyStoresBeforeUpgrade(env, { bunBin: process.execPath });
    expect(upgradeCopyExists(store)).toBe(true);
    // The store has been written since: the copy protects nothing now.
    const old = new Date(Date.now() - 60_000);
    utimesSync(upgradeCopyPath(store), old, old);
    expect(upgradeCopyExists(store)).toBe(false);
    const db = new Database(store);
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    expect(existsSync(`${store}.pre-schema-1.bak`)).toBe(true);
  });

  test('without room for the copies the upgrade stops before it changes anything', () => {
    const { env, root } = fixture();
    const store = join(root, 'tier-ledger.sqlite');
    storeAtV1(store, 1);
    expect(() => copyStoresBeforeUpgrade(env, { bunBin: process.execPath, freeBytes: () => 1024 })).toThrow('The upgrade copies your stores before it updates them');
    expect(existsSync(upgradeCopyPath(store))).toBe(false);
  });
});
