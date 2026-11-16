// #1494: an upgrade from 1.4.4 spent minutes per tier ledger in schema updates,
// the fixed 180 s waits gave up while the work was progressing, and the
// rollback started the previous version on ledgers already at the new schema.
// The waits now follow the worker's boot progress, and each store is copied
// before its schema update so a failed upgrade can put it back.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn as spawnProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOT_PROGRESS_SCHEMA,
  beginBootProgress,
  finishBootProgress,
  readBootProgress,
  reportBootStep,
  preSchemaBackupsOf,
  removeAllSchemaBackups,
  removeRecordedSchemaBackups,
  removeAbandonedBackupCopies,
  retiredStateBackupPath,
  retireStatePath,
  type BootProgress,
  type BootStepEvent,
} from '../src/core/boot-progress.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { createNativeProcessService } from '../src/core/native-process-service.ts';
import { readSqliteSchemaVersion, runSqliteMigrations, type SqliteMigration } from '../src/core/sqlite-migrations.ts';

const roots: string[] = [];
afterEach(() => {
  finishBootProgress();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): Record<string, string> {
  // HOME is the data root itself, where the store copies live (boot-progress.ts ownedBackup).
  const base = mkdtempSync(join(tmpdir(), 'olympus-boot-progress-'));
  roots.push(base);
  const root = join(base, 'openclaw', 'olympus');
  mkdirSync(root, { recursive: true });
  const env = { HOME: root, XDG_DATA_HOME: base, XDG_CONFIG_HOME: join(base, 'config'), XDG_STATE_HOME: join(base, 'state'), XDG_CACHE_HOME: join(base, 'cache') };
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

/** A line of the record of store copies, as a build from before the whole-root copy wrote one. */
function recordSchemaBackup(env: Record<string, string>, entry: { storeId: string; dbPath: string; backupPath: string }): void {
  appendFileSync(sharedDataPath('schema-backups', env), `${JSON.stringify(entry)}\n`);
}

describe('the boot copies no store: a failed update puts the whole data root back', () => {
  test('a pending schema update takes no copy', () => {
    const env = home();
    const { path, db } = storeAtVersion1(env);
    runSqliteMigrations(db, 'fixture', MIGRATIONS, { env, log: () => {} });
    expect(readSqliteSchemaVersion(db, 'fixture')).toBe(2);
    db.close();
    expect(preSchemaBackupsOf(path)).toEqual([]);
  });

  test('retired state is removed, not moved aside', () => {
    const env = home();
    const ledger = join(env.HOME!, 'retired.sqlite');
    writeFileSync(ledger, 'old');
    expect(retireStatePath(env, 'retired', ledger)).toBe(true);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(retiredStateBackupPath(ledger))).toBe(false);
  });
});

describe('store copies an earlier build left', () => {
  test('a commit removes every recorded copy, and a forget every copy on disk', () => {
    const env = home();
    const left = join(env.HOME!, 'left.sqlite');
    writeFileSync(left, '');
    writeFileSync(`${left}.pre-schema-6.bak`, 'old');
    recordSchemaBackup(env, { storeId: 'left', dbPath: left, backupPath: `${left}.pre-schema-6.bak` });
    expect(removeRecordedSchemaBackups(env)).toBe(1);
    expect(preSchemaBackupsOf(left)).toEqual([]);
    writeFileSync(`${left}.pre-schema-upgrade.bak`, 'old');
    recordSchemaBackup(env, { storeId: 'left', dbPath: left, backupPath: `${left}.pre-schema-upgrade.bak` });
    expect(removeAllSchemaBackups(env, true)).toBe(1);
    expect(removeAllSchemaBackups(env, false)).toBe(1);
    expect(preSchemaBackupsOf(left)).toEqual([]);
  });

  test('a recorded line reached through a link, or naming a file not named as a copy, is left alone', () => {
    const env = home();
    // A whole-root backup an owner keeps beside the root, reached from inside it through a link.
    const kept = join(env.XDG_DATA_HOME!, 'openclaw', 'olympus.pre-06f7f555');
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, 'store.sqlite'), 'kept');
    writeFileSync(join(kept, 'store.sqlite.pre-schema-7.bak'), 'kept copy');
    symlinkSync(kept, join(env.HOME!, 'linked'));
    recordSchemaBackup(env, { storeId: 'kept', dbPath: join(env.HOME!, 'linked', 'store.sqlite'), backupPath: join(env.HOME!, 'linked', 'store.sqlite.pre-schema-7.bak') });
    // A copy that is itself a link.
    writeFileSync(join(env.HOME!, 'a.sqlite'), 'live');
    symlinkSync(join(kept, 'store.sqlite'), join(env.HOME!, 'a.sqlite.pre-schema-2.bak'));
    recordSchemaBackup(env, { storeId: 'a', dbPath: join(env.HOME!, 'a.sqlite'), backupPath: join(env.HOME!, 'a.sqlite.pre-schema-2.bak') });
    // Not a copy's name.
    writeFileSync(join(env.HOME!, 'notes.sqlite'), 'live');
    recordSchemaBackup(env, { storeId: 'odd', dbPath: join(env.HOME!, 'notes'), backupPath: join(env.HOME!, 'notes.sqlite') });
    expect(removeRecordedSchemaBackups(env)).toBe(0);
    expect(readFileSync(join(kept, 'store.sqlite.pre-schema-7.bak'), 'utf8')).toBe('kept copy');
    expect(readFileSync(join(kept, 'store.sqlite'), 'utf8')).toBe('kept');
    expect(readFileSync(join(env.HOME!, 'a.sqlite'), 'utf8')).toBe('live');
    expect(readFileSync(join(env.HOME!, 'notes.sqlite'), 'utf8')).toBe('live');
  });

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
