// #1494: an upgrade from 1.4.4 spent minutes per tier ledger in schema updates,
// the fixed 180 s waits gave up while the work was progressing, and the
// rollback started the previous version on ledgers already at the new schema.
// The waits now follow the worker's boot progress, and each store is copied
// before its schema update so a failed upgrade can put it back.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOT_PROGRESS_SCHEMA,
  beginBootProgress,
  bootInProgress,
  bootProgressIsLive,
  finishBootProgress,
  readBootProgress,
  reportBootStep,
  restoreSchemaBackupsSince,
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
