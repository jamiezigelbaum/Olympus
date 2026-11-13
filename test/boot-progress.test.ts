// #1494: an upgrade from 1.4.4 spent minutes per tier ledger in schema updates,
// the fixed 180 s waits gave up while the work was progressing, and the
// rollback started the previous version on ledgers already at the new schema.
// The waits now follow the worker's boot progress, and each store is copied
// before its schema update so a failed upgrade can put it back.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOT_PROGRESS_SCHEMA,
  beginBootProgress,
  bootInProgress,
  bootProgressIsLive,
  duringStoreUpdateStep,
  workerStillStarting,
  BOOT_READY_ANSWER_GRACE_MS,
  finishBootProgress,
  readBootProgress,
  reportBootStep,
  preSchemaBackupsOf,
  recordSchemaBackup,
  removeAllSchemaBackups,
  removeSchemaBackupsSince,
  removeAbandonedBackupCopies,
  restoreSchemaBackupsSince,
  retiredStateBackupPath,
  retireStatePath,
  type BootProgress,
  type BootStepEvent,
} from '../src/core/boot-progress.ts';
import { createNativeProcessService } from '../src/core/native-process-service.ts';
import { readSqliteSchemaVersion, runSqliteMigrations, type SqliteMigration } from '../src/core/sqlite-migrations.ts';

const roots: string[] = [];
afterEach(() => {
  finishBootProgress();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-boot-progress-'));
  roots.push(root);
  return { HOME: root, XDG_DATA_HOME: join(root, '.local', 'share') };
}

const HOUR = 60 * 60 * 1000;
function progress(phase: BootProgress['phase'], ages: { startedMs: number; updatedMs: number }, now: number, pid = process.pid): BootProgress {
  return {
    schema: BOOT_PROGRESS_SCHEMA, pid, phase, completedStores: 0,
    startedAt: new Date(now - ages.startedMs).toISOString(), updatedAt: new Date(now - ages.updatedMs).toISOString(),
  };
}

describe('bootInProgress', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  test('a fresh starting boot is in progress', () => {
    expect(bootProgressIsLive(progress('starting', { startedMs: 10_000, updatedMs: 1_000 }, now), now)).toBe(true);
  });
  test('a starting boot with no report for 5 minutes has stalled', () => {
    expect(bootProgressIsLive(progress('starting', { startedMs: HOUR, updatedMs: 5 * 60_000 }, now), now)).toBe(false);
  });
  test('a store update started 2 hours ago is still in progress', () => {
    expect(bootProgressIsLive(progress('migrating', { startedMs: 2 * HOUR, updatedMs: 2 * HOUR }, now), now)).toBe(true);
    expect(bootProgressIsLive(progress('migrating', { startedMs: 7 * HOUR, updatedMs: 7 * HOUR }, now), now)).toBe(false);
  });
  test('a dead worker is not in progress', () => {
    expect(bootProgressIsLive(progress('starting', { startedMs: 0, updatedMs: 0 }, now, 4_000_000), now, () => false)).toBe(false);
  });
  test('a finished boot is not in progress', () => {
    expect(bootProgressIsLive(progress('done', { startedMs: 0, updatedMs: 0 }, now), now)).toBe(false);
  });
  test('the worker writes the file; another data root and a boot that ended write nothing', () => {
    const env = home();
    beginBootProgress(env);
    expect(readBootProgress(env)).toMatchObject({ pid: process.pid, phase: 'starting', completedStores: 0 });
    expect(bootInProgress(env)).toBe(true);
    reportBootStep(env, { phase: 'migrating', storeId: 'tier-ledger' });
    reportBootStep(env, { phase: 'starting', storeId: 'tier-ledger', completedStore: true });
    const other = home();
    reportBootStep(other, { phase: 'migrating', storeId: 'x' });
    expect(readBootProgress(other)).toBeUndefined();
    expect(readBootProgress(env)).toMatchObject({ phase: 'starting', storeId: 'tier-ledger', completedStores: 1 });
    finishBootProgress();
    expect(readBootProgress(env)?.phase).toBe('done');
    expect(bootInProgress(env)).toBe(false);
    reportBootStep(env, { phase: 'starting', storeId: 'later' });
    expect(readBootProgress(env)?.phase).toBe('done');
    const text = readFileSync(join(env.HOME!, '.local', 'share', 'openclaw', 'olympus', 'boot-progress.json'), 'utf8');
    expect(text).not.toContain(env.HOME!);
    expect(statSync(join(env.HOME!, '.local', 'share', 'openclaw', 'olympus', 'boot-progress.json')).mode & 0o777).toBe(0o600);
  });
});

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
    expect(removeSchemaBackupsSince(env, 0)).toBe(1);
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
    const env = home();
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

describe('a long store update is not a stall', () => {
  test('while one store updates, silent for longer than the stall limit, the boot stays in progress', () => {
    const env = home();
    const { db } = storeAtVersion1(env);
    beginBootProgress(env);
    const seen: Array<{ phase: string | undefined; liveAfter10Min: boolean }> = [];
    // The update writes nothing to the progress file while it runs; ten minutes later it must still read as live.
    const slow: SqliteMigration = { version: 2, name: 'slow', up: () => {
      seen.push({ phase: readBootProgress(env)?.phase, liveAfter10Min: bootInProgress(env, Date.now() + 10 * 60_000) });
    } };
    runSqliteMigrations(db, 'fixture', [MIGRATIONS[0]!, slow], { env, log: () => {} });
    db.close();
    expect(seen).toEqual([{ phase: 'migrating', liveAfter10Min: true }]);
    // Between stores, the stall rule applies again.
    expect(readBootProgress(env)?.phase).toBe('starting');
    expect(bootInProgress(env, Date.now() + 10 * 60_000)).toBe(false);
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

describe('a check that reads every row after an update is not a stall (gate7 forced leg, 2026-11-13)', () => {
  test('inside the step the boot reads as a long update; after it, the stall rule applies again', () => {
    const env = home();
    beginBootProgress(env);
    const seen = duringStoreUpdateStep(env, 'fixture', () => ({
      phase: readBootProgress(env)?.phase,
      liveAfter10Min: bootInProgress(env, Date.now() + 10 * 60_000),
    }));
    expect(seen).toEqual({ phase: 'migrating', liveAfter10Min: true });
    expect(readBootProgress(env)?.phase).toBe('starting');
    expect(bootInProgress(env, Date.now() + 10 * 60_000)).toBe(false);
  });

  test('a step that throws still returns the boot to starting', () => {
    const env = home();
    beginBootProgress(env);
    expect(() => duringStoreUpdateStep(env, 'fixture', () => { throw new Error('bad rows'); })).toThrow('bad rows');
    expect(readBootProgress(env)?.phase).toBe('starting');
  });

  // A real child holds one silent step for longer than the supervisor's
  // startup timeout, and the supervisor reads its progress as if ten minutes
  // had passed since the step began: twice the stall limit.
  async function superviseSilentStep(asUpdateStep: boolean): Promise<string> {
    const env = home();
    const readyFile = join(env.HOME!, 'ready');
    const module = join(import.meta.dir, '..', 'src', 'core', 'boot-progress.ts');
    const script = `
      const { beginBootProgress, duringStoreUpdateStep, reportBootStep } = await import(${JSON.stringify(module)});
      const { writeFileSync } = await import('node:fs');
      const env = ${JSON.stringify(env)};
      beginBootProgress(env);
      const silent = () => { const end = Date.now() + 3000; while (Date.now() < end) {} };
      if (${asUpdateStep}) duringStoreUpdateStep(env, 'fixture', silent);
      else { reportBootStep(env, { phase: 'starting', storeId: 'fixture' }); silent(); }
      writeFileSync(${JSON.stringify(readyFile)}, '');
      setInterval(() => {}, 1000);
    `;
    const service = createNativeProcessService({
      id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
      readinessPollMs: 20, stopGraceMs: 100, restartDelaysMs: [60_000],
      async prepareStart() {
        return {
          command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH ?? '' },
          startupTimeoutMs: 1500, endpointOccupied: false,
          startupInProgress: () => bootInProgress(env, Date.now() + 10 * 60_000),
          readinessProbe: async () => existsSync(readyFile),
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

  test('the supervisor waits out a check longer than its timeout and the stall limit', async () => {
    expect(await superviseSilentStep(true)).toBe('ready');
  }, 30_000);

  test('the same silence outside an update step still times out', async () => {
    expect(await superviseSilentStep(false)).toBe('timed out');
  }, 30_000);
});

describe('a worker that finished its boot and is busy is not dead (gate7 success leg on c013270b, 13 Nov)', () => {
  test('done by this live child counts as starting until the grace runs out; another pid does not', () => {
    const env = home();
    beginBootProgress(env);
    finishBootProgress();
    expect(workerStillStarting(env, process.pid)).toBe(true);
    expect(workerStillStarting(env, process.pid + 1_000_000)).toBe(false);
    expect(workerStillStarting(env, undefined)).toBe(false);
    expect(workerStillStarting(env, process.pid, Date.now() + BOOT_READY_ANSWER_GRACE_MS + 1)).toBe(false);
  });

  test('the supervisor waits for a ready child whose first work blocks it past the timeout', async () => {
    const env = home();
    const readyFile = join(env.HOME!, 'ready');
    const module = join(import.meta.dir, '..', 'src', 'core', 'boot-progress.ts');
    const script = `
      const { beginBootProgress, finishBootProgress } = await import(${JSON.stringify(module)});
      const { writeFileSync } = await import('node:fs');
      beginBootProgress(${JSON.stringify(env)});
      finishBootProgress();
      // Its first work after ready holds the event loop, as a store backup does.
      const end = Date.now() + 3000; while (Date.now() < end) {}
      writeFileSync(${JSON.stringify(readyFile)}, '');
      setInterval(() => {}, 1000);
    `;
    const service = createNativeProcessService({
      id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
      readinessPollMs: 20, stopGraceMs: 100, restartDelaysMs: [60_000],
      async prepareStart() {
        return {
          command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH ?? '' },
          startupTimeoutMs: 1500, endpointOccupied: false,
          startupInProgress: (child) => workerStillStarting(env, child.pid),
          readinessProbe: async () => existsSync(readyFile),
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
    expect(main.indexOf("if (engineRole === 'single') finishBootProgress()")).toBeGreaterThan(0);
    expect(main).toContain('commands.markReady();\n    finishBootProgress();');
  });
});
