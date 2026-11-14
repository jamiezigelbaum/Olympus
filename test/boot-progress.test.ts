// #1494: an upgrade from 1.4.4 spent minutes per tier ledger in schema updates,
// the fixed 180 s waits gave up while the work was progressing, and the
// rollback started the previous version on ledgers already at the new schema.
// The waits now follow the worker's boot progress, and each store is copied
// before its schema update so a failed upgrade can put it back.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOT_PROGRESS_SCHEMA,
  beginBootProgress,
  finishBootProgress,
  readBootProgress,
  reportBootStep,
  preSchemaBackupsOf,
  recordSchemaBackup,
  removeAllSchemaBackups,
  removeRecordedSchemaBackups,
  removeSchemaBackupsSince,
  removeAbandonedBackupCopies,
  restoreSchemaBackupsSince,
  retiredStateBackupPath,
  retireStatePath,
  UPGRADE_COPY_SUFFIX,
  type BootProgress,
  type BootStepEvent,
} from '../src/core/boot-progress.ts';
import { upgradeInFlight } from './helpers/upgrade-in-flight.ts';
import { createNativeProcessService } from '../src/core/native-process-service.ts';
import { readSqliteSchemaVersion, runSqliteMigrations, type SqliteMigration } from '../src/core/sqlite-migrations.ts';

const roots: string[] = [];
afterEach(() => {
  finishBootProgress();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A home with a worker upgrade in flight unless `upgrade: false`: the boot
 * copies a store, and moves retired state aside, only then. The upgrade's own
 * copy is of a file outside the tests' view, made an hour ago.
 */
function home(options: { upgrade?: boolean } = {}): Record<string, string> {
  // HOME is the data root itself, where the store copies live (boot-progress.ts ownedBackup).
  const base = mkdtempSync(join(tmpdir(), 'olympus-boot-progress-'));
  roots.push(base);
  const root = join(base, 'openclaw', 'olympus');
  mkdirSync(root, { recursive: true });
  const env = { HOME: root, XDG_DATA_HOME: base, XDG_CONFIG_HOME: join(base, 'config'), XDG_STATE_HOME: join(base, 'state'), XDG_CACHE_HOME: join(base, 'cache') };
  if (options.upgrade !== false) upgradeInFlight(env);
  return env;
}

const HOUR = 60 * 60 * 1000;
function progress(phase: BootProgress['phase'], ages: { startedMs: number; updatedMs: number }, now: number, pid = process.pid): BootProgress {
  return {
    schema: BOOT_PROGRESS_SCHEMA, pid, phase, completedStores: 0,
    startedAt: new Date(now - ages.startedMs).toISOString(), updatedAt: new Date(now - ages.updatedMs).toISOString(),
  };
}

const MIGRATIONS: SqliteMigration[] = [
  { version: 1, name: 'create', up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)') },
  { version: 2, name: 'add_column', up: (db) => db.exec('ALTER TABLE items ADD COLUMN tier TEXT') },
];

function storeAtVersion1(env: Record<string, string>): { path: string; db: Database } {
  const path = join(env.HOME!, 'store.sqlite');
  const db = new Database(path, { create: true });
  runSqliteMigrations(db, 'fixture', [MIGRATIONS[0]!], { env, log: () => {} });
  db.query('INSERT INTO items (body) VALUES (?)').run('kept');
  return { path, db };
}

describe('schema updates back up the store first', () => {
  test('a backup holding the old version is written before a pending update', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    const events: BootStepEvent[] = [];
    const lines: string[] = [];
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: (line) => lines.push(line), report: (event) => events.push(event) });
    db.close();
    const backup = `${path}.pre-schema-1.bak`;
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    const copy = new Database(backup, { readonly: true });
    expect(readSqliteSchemaVersion(copy, 'fixture')).toBe(1);
    expect(copy.query('SELECT body FROM items').get()).toEqual({ body: 'kept' });
    copy.close();
    expect(events.map((event) => event.phase)).toEqual(['starting', 'backing_up', 'migrating', 'starting']);
    expect(events.at(-1)).toMatchObject({ storeId: 'fixture', completedStore: true });
    expect(lines[0]).toBe('[storage] fixture schema 1 to 2: updating');
    expect(lines[1]).toMatch(/^\[storage\] fixture schema 1 to 2: backed up in \d+ ms, migrated in \d+ ms$/);
    expect(lines.join('\n')).not.toContain(env.HOME!);
  });

  test('a store that updates inside its own transaction is still backed up', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    db.transaction(() => {
      runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    }).immediate();
    expect(readSqliteSchemaVersion(db, 'fixture')).toBe(2);
    db.close();
    const copy = new Database(`${path}.pre-schema-1.bak`, { readonly: true });
    expect(readSqliteSchemaVersion(copy, 'fixture')).toBe(1);
    expect(copy.query('SELECT body FROM items').get()).toEqual({ body: 'kept' });
    copy.close();
  });

  test('a new store has nothing to back up', () => {
    const env = home();
    const path = join(env.HOME!, 'new.sqlite');
    const db = new Database(path, { create: true });
    const events: BootStepEvent[] = [];
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {}, report: (event) => events.push(event) });
    db.close();
    expect(existsSync(`${path}.pre-schema-0.bak`)).toBe(false);
    expect(events.map((event) => event.phase)).toEqual(['starting', 'migrating', 'starting']);
  });

  test('without room for the update, nothing is migrated', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    expect(() => runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {}, freeBytes: () => 100 * 1024 * 1024 }))
      .toThrow(/Updating the "fixture" store needs \d+ MB free on its disk/);
    expect(readSqliteSchemaVersion(db, 'fixture')).toBe(1);
    expect(existsSync(`${path}.pre-schema-1.bak`)).toBe(false);
    db.close();
  });

  test('a killed backup\'s part-way copy is gone before the free space is measured', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    const gone = Bun.spawnSync([process.execPath, '-e', '0']).pid;
    const abandoned = `${path}.pre-schema-1.bak.${gone}.partial`;
    writeFileSync(abandoned, 'part of a copy');
    let seenAtMeasure: boolean | undefined;
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {}, freeBytes: () => {
      seenAtMeasure = existsSync(abandoned);
      return Number.MAX_SAFE_INTEGER;
    } });
    db.close();
    expect(seenAtMeasure).toBe(false);
  }, 30_000);

  test('a backup left by an earlier attempt is replaced, since the store may have changed since', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    const backup = `${path}.pre-schema-1.bak`;
    writeFileSync(backup, 'earlier attempt');
    const events: BootStepEvent[] = [];
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {}, report: (event) => events.push(event) });
    db.close();
    expect(events.map((event) => event.phase)).toContain('backing_up');
    const copy = new Database(backup, { readonly: true });
    expect(readSqliteSchemaVersion(copy, 'fixture')).toBe(1);
    expect(copy.query('SELECT body FROM items').get()).toEqual({ body: 'kept' });
    copy.close();
  });

  test('a delete finds every copy of a store, and a forget removes the recorded copies', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    writeFileSync(join(env.HOME!, 'store.sqlite.pre-schema-x.bak'), 'not a copy');
    expect(preSchemaBackupsOf(path)).toEqual([`${path}.pre-schema-1.bak`]);
    // This store's copy and the in-flight upgrade's own.
    expect(removeSchemaBackupsSince(env, 0)).toBe(2);
    expect(preSchemaBackupsOf(path)).toEqual([]);
  });

  test('a second opener that copies after the first finished the update keeps the first backup', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    // The second opener read version 1; before its copy, the first opener updates the store.
    const freeBytes = () => {
      const first = new Database(path);
      runSqliteMigrations(first, 'fixture', MIGRATIONS, { env, log: () => {} });
      first.close();
      return Number.MAX_SAFE_INTEGER;
    };
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {}, freeBytes });
    db.close();
    const copy = new Database(`${path}.pre-schema-1.bak`, { readonly: true });
    expect(readSqliteSchemaVersion(copy, 'fixture')).toBe(1);
    copy.close();
  });

  test('a copy a crash left part way is found by a delete and removed by a forget', () => {
    const env = home({ upgrade: false });
    const path = join(env.HOME!, 'shared.sqlite');
    writeFileSync(path, '');
    const partial = `${path}.pre-schema-4.bak.12345.partial`;
    writeFileSync(partial, 'rows');
    recordSchemaBackup(env, { storeId: 'shared', dbPath: path, backupPath: `${path}.pre-schema-4.bak` });
    expect(preSchemaBackupsOf(path)).toEqual([partial]);
    expect(removeAllSchemaBackups(env, true)).toBe(1);
    expect(existsSync(partial)).toBe(true);
    expect(removeAllSchemaBackups(env, false)).toBe(1);
    expect(existsSync(partial)).toBe(false);
  });

  test('a restore puts the copy back and removes the -wal and -shm', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    const since = Date.now() - 1;
    db.exec('PRAGMA journal_mode = WAL');
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    writeFileSync(`${path}-wal`, 'x');
    writeFileSync(`${path}-shm`, 'x');
    expect(restoreSchemaBackupsSince(env, since)).toEqual(['fixture']);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${path}.pre-schema-1.bak`)).toBe(false);
    const restored = new Database(path, { readonly: true });
    expect(readSqliteSchemaVersion(restored, 'fixture')).toBe(1);
    restored.close();
  });
});

// rc.13's success leg (14 Nov): stores the new engine first opened after the
// upgrade committed (the sniffers, the retired pre-filter) each left a copy
// that nothing would ever restore or remove. Whatever store it is, the boot
// copies only while a worker upgrade is in flight.
describe('with no worker upgrade in flight the boot leaves no copy', () => {
  test('a pending schema update takes no copy', () => {
    const env = home({ upgrade: false });
    const { path, db } = storeAtVersion1(env);
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    expect(readSqliteSchemaVersion(db, 'fixture')).toBe(2);
    db.close();
    expect(preSchemaBackupsOf(path)).toEqual([]);
  });

  test('retired state is removed, not moved aside', () => {
    const env = home({ upgrade: false });
    const ledger = join(env.HOME!, 'retired.sqlite');
    writeFileSync(ledger, 'old');
    expect(retireStatePath(env, 'retired', ledger)).toBe(true);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(retiredStateBackupPath(ledger))).toBe(false);
  });

  test('a commit removes every recorded copy, one an earlier version left included', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    const left = join(env.HOME!, 'left.sqlite');
    writeFileSync(left, '');
    writeFileSync(`${left}.pre-schema-6.bak`, 'old');
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    utimesSync(`${left}.pre-schema-6.bak`, weekAgo, weekAgo);
    recordSchemaBackup(env, { storeId: 'left', dbPath: left, backupPath: `${left}.pre-schema-6.bak` });
    expect(removeRecordedSchemaBackups(env)).toBe(3);
    expect(preSchemaBackupsOf(path)).toEqual([]);
    expect(preSchemaBackupsOf(left)).toEqual([]);
    expect(existsSync(join(env.HOME!, 'other', `upgraded.sqlite${UPGRADE_COPY_SUFFIX}`))).toBe(false);
  });
});

describe('a commit and a restore touch only the product\'s own copies in the live data root', () => {
  test('a recorded line naming a kept whole-root backup, or a file not named as a copy, is left alone', () => {
    const env = home();
    // A whole-root backup kept beside the live root, as an owner keeps one before an install.
    const kept = join(env.XDG_DATA_HOME!, 'openclaw', 'olympus.pre-06f7f555');
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, 'store.sqlite'), 'kept');
    writeFileSync(join(kept, 'store.sqlite.pre-schema-7.bak'), 'kept copy');
    recordSchemaBackup(env, { storeId: 'kept', dbPath: join(kept, 'store.sqlite'), backupPath: join(kept, 'store.sqlite.pre-schema-7.bak') });
    // Inside the root, but not a copy's name.
    writeFileSync(join(env.HOME!, 'notes.sqlite'), 'live');
    recordSchemaBackup(env, { storeId: 'odd', dbPath: join(env.HOME!, 'notes'), backupPath: join(env.HOME!, 'notes.sqlite') });
    expect(removeRecordedSchemaBackups(env)).toBe(1);
    expect(restoreSchemaBackupsSince(env, 0)).toEqual([]);
    expect(readFileSync(join(kept, 'store.sqlite.pre-schema-7.bak'), 'utf8')).toBe('kept copy');
    expect(readFileSync(join(kept, 'store.sqlite'), 'utf8')).toBe('kept');
    expect(readFileSync(join(env.HOME!, 'notes.sqlite'), 'utf8')).toBe('live');
  });
});

describe('a rollback or a commit leaves no copy behind (the gate7 forced leg, 2026-11-13)', () => {
  function migratedWithLeftovers(env: Record<string, string>): { path: string; since: number; gone: number } {
    const { path, db } = storeAtVersion1(env);
    const since = Date.now() - 1;
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    // A process stopped inside a transaction leaves its hot journal, and one
    // stopped inside a backup leaves its part-way copy.
    const gone = Bun.spawnSync([process.execPath, '-e', '0']).pid;
    writeFileSync(`${path}-journal`, 'a hot journal of the updated file');
    for (const suffix of ['partial', 'partial-journal']) writeFileSync(`${path}.pre-schema-1.bak.${gone}.${suffix}`, 'x');
    return { path, since, gone };
  }

  test('a restore removes the -journal written for the file it replaces, and every part-way copy', () => {
    const env = home();
    const { path, since, gone } = migratedWithLeftovers(env);
    expect(restoreSchemaBackupsSince(env, since)).toEqual(['fixture']);
    expect(existsSync(`${path}-journal`)).toBe(false);
    expect(existsSync(`${path}.pre-schema-1.bak.${gone}.partial`)).toBe(false);
    expect(existsSync(`${path}.pre-schema-1.bak.${gone}.partial-journal`)).toBe(false);
    expect(preSchemaBackupsOf(path)).toEqual([]);
    const restored = new Database(path, { readonly: true });
    expect(readSqliteSchemaVersion(restored, 'fixture')).toBe(1);
    restored.close();
  }, 30_000);

  test('a commit removes the part-way copies with the backups', () => {
    const env = home();
    const { path, since, gone } = migratedWithLeftovers(env);
    expect(removeSchemaBackupsSince(env, since)).toBe(1);
    expect(existsSync(`${path}.pre-schema-1.bak.${gone}.partial`)).toBe(false);
    expect(preSchemaBackupsOf(path)).toEqual([]);
  }, 30_000);
});

describe('a new store inside an existing file is put back too (gate7 forced leg on c013270b, 13 Nov)', () => {
  test('a rollback takes out the new store\'s tables and puts the file back as it was before both updates', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    const since = Date.now() - 1;
    // A store new in this version joins the file (limit-stops in source-scheduler.sqlite), then the file's own store updates.
    runSqliteMigrations(db, 'joined', [{ version: 1, name: 'create', up: (d) => d.exec('CREATE TABLE joined_rows (id INTEGER)') }], { env, log: () => {} });
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    expect(restoreSchemaBackupsSince(env, since).sort()).toEqual(['fixture', 'joined']);
    expect(preSchemaBackupsOf(path)).toEqual([]);
    const restored = new Database(path, { readonly: true });
    expect(restored.query("SELECT name FROM sqlite_master WHERE name = 'joined_rows'").get()).toBeNull();
    expect(readSqliteSchemaVersion(restored, 'fixture')).toBe(1);
    expect(restored.query('SELECT body FROM items').get()).toEqual({ body: 'kept' });
    restored.close();
  });

  test('a brand-new file gets no copy', () => {
    const env = home();
    const path = join(env.HOME!, 'fresh.sqlite');
    const db = new Database(path, { create: true });
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    db.close();
    expect(preSchemaBackupsOf(path)).toEqual([]);
  });
});

describe('a killed backup leaves nothing behind once a backup runs again', () => {
  test('part-way copies of gone processes are removed; a live process\'s copy is kept', () => {
    const env = home();
    const backup = join(env.HOME!, 'store.sqlite.pre-schema-15.bak');
    const gone = Bun.spawnSync([process.execPath, '-e', '0']).pid;
    const live = process.ppid;
    for (const name of [`${backup}.${gone}.partial`, `${backup}.${gone}.partial-journal`, `${backup}.${live}.partial`, backup]) writeFileSync(name, 'x');
    expect(removeAbandonedBackupCopies(backup)).toBe(2);
    expect(existsSync(`${backup}.${gone}.partial`)).toBe(false);
    expect(existsSync(`${backup}.${gone}.partial-journal`)).toBe(false);
    expect(existsSync(`${backup}.${live}.partial`)).toBe(true);
    expect(existsSync(backup)).toBe(true);
  }, 30_000);
});

describe('retired state is moved aside for the upgrade that retires it (#1563 review)', () => {
  test('state last written long ago is still put back by a failed upgrade', () => {
    const env = home();
    const path = join(env.HOME!, 'retired.sqlite');
    writeFileSync(path, 'old rows');
    const longAgo = new Date(Date.now() - 30 * 24 * HOUR);
    utimesSync(path, longAgo, longAgo);
    const since = Date.now() - 1;
    expect(retireStatePath(env, 'retired', path)).toBe(true);
    // The move keeps the time it was given just before, so the copy counts as this upgrade's.
    expect(statSync(retiredStateBackupPath(path)).mtimeMs).toBeGreaterThanOrEqual(since);
    expect(restoreSchemaBackupsSince(env, since)).toEqual(['retired']);
    expect(readFileSync(path, 'utf8')).toBe('old rows');
  });

  test('a copy an earlier start left gives way to the newer state, which a failed upgrade puts back', () => {
    const env = home();
    const path = join(env.HOME!, 'retired.sqlite');
    const backup = retiredStateBackupPath(path);
    writeFileSync(backup, 'older copy');
    const longAgo = new Date(Date.now() - 30 * 24 * HOUR);
    utimesSync(backup, longAgo, longAgo);
    writeFileSync(path, 'newer rows');
    const since = Date.now() - 1;
    expect(retireStatePath(env, 'retired', path)).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe('newer rows');
    expect(restoreSchemaBackupsSince(env, since)).toEqual(['retired']);
    expect(readFileSync(path, 'utf8')).toBe('newer rows');
  });
});

describe('the supervisor waits on boot progress', () => {
  async function startWith(inProgress: boolean): Promise<string> {
    const children: ReturnType<typeof spawnProcess>[] = [];
    const readyAt = Date.now() + 400;
    const service = createNativeProcessService({
      id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
      readinessPollMs: 10, stopGraceMs: 100, restartDelaysMs: [60_000],
      spawn: ((command: string, args: readonly string[], options: object) => {
        const child = spawnProcess(command, args as string[], options as Parameters<typeof spawnProcess>[2]);
        children.push(child);
        return child;
      }) as unknown as typeof spawnProcess,
      async prepareStart() {
        return {
          command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH ?? '' },
          startupTimeoutMs: 100, endpointOccupied: false,
          startupInProgress: () => inProgress,
          readinessProbe: async () => Date.now() >= readyAt,
        };
      },
    });
    try {
      await service.start({ logger: { warn() {} }, serviceHealth: { reportFailure() {}, clearFailure() {} } });
      return 'ready';
    } catch {
      return 'timed out';
    } finally {
      await service.stop();
    }
  }

  test('a child not ready by its deadline but still booting is waited for', async () => {
    expect(await startWith(true)).toBe('ready');
  }, 10_000);

  test('a child with no progress still times out', async () => {
    expect(await startWith(false)).toBe('timed out');
  }, 10_000);
});

describe('the supervisor probes before it gives up', () => {
  test('a child that finished its boot during the last wait is ready, not timed out', async () => {
    const readyAt = Date.now() + 150;
    const service = createNativeProcessService({
      id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
      // The deadline passes during the wait, and the boot ends then too.
      readinessPollMs: 400, stopGraceMs: 100, restartDelaysMs: [60_000],
      async prepareStart() {
        return {
          command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH ?? '' },
          startupTimeoutMs: 100, endpointOccupied: false,
          startupInProgress: () => Date.now() < readyAt,
          readinessProbe: async () => Date.now() >= readyAt,
        };
      },
    });
    let outcome = 'ready';
    try {
      await service.start({ logger: { warn() {} }, serviceHealth: { reportFailure() {}, clearFailure() {} } });
    } catch {
      outcome = 'timed out';
    } finally {
      await service.stop();
    }
    expect(outcome).toBe('ready');
  }, 30_000);
});

describe('the worker reports its boot', () => {
  test('main() writes starting before it opens any store, and done when ready', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'workers', 'engine', 'server.ts'), 'utf8');
    const main = source.slice(source.indexOf('export async function main()'));
    const begin = main.indexOf('beginBootProgress(process.env)');
    expect(begin).toBeGreaterThan(main.indexOf('takeWorkerDataOwnerLock('));
    expect(begin).toBeLessThan(main.indexOf('deleteMarkedAccountsAtBoot('));
    expect(main.indexOf("if (engineRole === 'single') { finishBootProgress();")).toBeGreaterThan(0);
    // The heartbeat starts before the boot's first step, from its own thread.
    expect(main.indexOf('startEngineHeartbeat(process.env, engineRole)')).toBeGreaterThan(main.indexOf('takeWorkerDataOwnerLock('));
    expect(main.indexOf('startEngineHeartbeat(process.env, engineRole)')).toBeLessThan(begin);
    expect(main).toContain('commands.markReady();\n    finishBootProgress();');
  });
});
