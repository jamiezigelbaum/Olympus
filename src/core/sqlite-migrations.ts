import type { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, openSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { preSchemaBackupPath, recordSchemaBackup, reportBootStep, type BootStepEvent } from './boot-progress.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';

export const SQLITE_SCHEMA_VERSION_TABLE = 'schema_version';
export const CURRENT_OLYMPUS_SQLITE_SCHEMA_VERSION = 1;

export interface SqliteMigration {
  version: number;
  name: string;
  up(db: Database): void;
}

export interface SqliteMigrationResult {
  storeId: string;
  currentVersion: number;
  targetVersion: number;
  dryRun: boolean;
  applied: Array<{ version: number; name: string }>;
  pending: Array<{ version: number; name: string }>;
}

export interface SqliteMigrationOptions {
  dryRun?: boolean;
  knownVersion?: number;
  /** The data root's environment, for boot progress and the backup record. */
  env?: LayoutEnv;
  /** One line per store update; store id only, never a path. */
  log?: (line: string) => void;
  /** Tests: free bytes in the store's folder. */
  freeBytes?: (directory: string) => number;
  /** Tests: where progress goes; defaults to the boot progress file. */
  report?: (event: BootStepEvent) => void;
}

/** Room an update needs beside the store: its backup, its rewrite, and headroom. */
export function schemaUpdateSpaceNeeded(fileBytes: number): number {
  return Math.ceil(fileBytes * 1.2) + 512 * 1024 * 1024;
}

export function currentStoreMigrations(): SqliteMigration[] {
  return [
    {
      version: CURRENT_OLYMPUS_SQLITE_SCHEMA_VERSION,
      name: 'record_existing_v1_schema',
      up() {
        // Existing stores still own their CREATE TABLE migrations locally.
        // This migration records that the v1 schema is known to this build.
      },
    },
  ];
}

export function assertSqliteSchemaCanOpen(
  db: Database,
  storeId: string,
  knownVersion = CURRENT_OLYMPUS_SQLITE_SCHEMA_VERSION,
): void {
  const currentVersion = readSqliteSchemaVersion(db, storeId);
  if (currentVersion > knownVersion) {
    throw new OperationError(
      'config_error',
      `SQLite store "${storeId}" is at schema_version ${currentVersion}, but this Olympus build only knows schema_version ${knownVersion}.`,
      'Upgrade Olympus before opening this store. Refusing to open it prevents an older build from corrupting newer data.',
    );
  }
}

export function runSqliteMigrations(
  db: Database,
  storeId: string,
  migrations = currentStoreMigrations(),
  options: SqliteMigrationOptions = {},
): SqliteMigrationResult {
  const ordered = validateMigrations(migrations);
  const targetVersion = options.knownVersion ?? ordered.at(-1)?.version ?? CURRENT_OLYMPUS_SQLITE_SCHEMA_VERSION;
  const currentVersion = readSqliteSchemaVersion(db, storeId);
  if (currentVersion > targetVersion) {
    throw new OperationError(
      'config_error',
      `SQLite store "${storeId}" is at schema_version ${currentVersion}, but this Olympus build only knows schema_version ${targetVersion}.`,
      'Upgrade Olympus before opening this store. Refusing to open it prevents an older build from corrupting newer data.',
    );
  }

  const pending = ordered
    .filter((migration) => migration.version > currentVersion)
    .map(({ version, name }) => ({ version, name }));
  if (options.dryRun === true) {
    return {
      storeId,
      currentVersion,
      targetVersion,
      dryRun: true,
      applied: [],
      pending,
    };
  }

  const env = options.env ?? process.env;
  const report = options.report ?? ((event: BootStepEvent) => reportBootStep(env, event));
  const log = options.log ?? ((line: string) => console.log(line));
  // Every writable open passes here: a heartbeat for the boot that opens it.
  report({ phase: 'starting', storeId });
  ensureSchemaVersionTable(db);
  const applied: Array<{ version: number; name: string }> = [];
  if (pending.length > 0) {
    const toVersion = pending.at(-1)!.version;
    const label = `[storage] ${storeId} schema ${currentVersion} to ${toVersion}`;
    // A new store's first schema is not an update: only existing stores are logged.
    const logged = currentVersion > 0;
    if (logged) log(`${label}: updating`);
    // A store on disk with data is copied first, so a failed upgrade can put
    // it back for the previous version (#1494). A new store has nothing to keep.
    const backupMs = currentVersion > 0 && storeOnDisk(db)
      ? backUpBeforeUpdate(db, storeId, currentVersion, env, report, options.freeBytes)
      : undefined;
    report({ phase: 'migrating', storeId });
    const migrateStarted = performance.now();
    // Another process may open the same file at the same moment (the CLI and
    // the worker). Take the write lock before reading the version again, and
    // apply only what is still pending under it: the loser of the race waits
    // (busy_timeout) and then finds nothing to do, rather than running a
    // migration twice or failing on a stale snapshot.
    db.transaction(() => {
      const lockedVersion = readSqliteSchemaVersion(db, storeId);
      if (lockedVersion > targetVersion) {
        throw new OperationError(
          'config_error',
          `SQLite store "${storeId}" is at schema_version ${lockedVersion}, but this Olympus build only knows schema_version ${targetVersion}.`,
          'Upgrade Olympus before opening this store. Refusing to open it prevents an older build from corrupting newer data.',
        );
      }
      for (const migration of ordered.filter((entry) => entry.version > lockedVersion)) {
        migration.up(db);
        writeSqliteSchemaVersion(db, storeId, migration.version);
        applied.push({ version: migration.version, name: migration.name });
      }
    }).immediate();
    const migrateMs = Math.round(performance.now() - migrateStarted);
    report({ phase: 'starting', storeId, completedStore: true });
    if (logged && applied.length > 0) {
      log(`${label}: ${backupMs === undefined ? 'in memory, no backup' : `backed up in ${backupMs} ms`}, migrated in ${migrateMs} ms`);
    }
  }

  return {
    storeId,
    currentVersion,
    targetVersion,
    dryRun: false,
    applied,
    pending: applied,
  };
}

function storeOnDisk(db: Database): boolean {
  const file = db.filename;
  return typeof file === 'string' && file !== '' && file !== ':memory:' && !file.startsWith('file::memory:') && existsSync(file);
}

/**
 * Checks for room, then writes `<db>.pre-schema-<from>.bak` with VACUUM INTO,
 * outside any transaction and owner-only. A backup left by an earlier attempt
 * is replaced: the store may have taken writes at the same version since, and
 * restoring the old copy would lose them. Returns how long it took.
 */
function backUpBeforeUpdate(
  db: Database,
  storeId: string,
  fromVersion: number,
  env: LayoutEnv,
  report: (event: BootStepEvent) => void,
  freeBytes: (directory: string) => number = defaultFreeBytes,
): number {
  const file = db.filename;
  const backup = preSchemaBackupPath(file, fromVersion);
  const started = performance.now();
  // An earlier attempt's copy stays until the new one replaces it: no credit for its space.
  // It is never removed first, since another opener may have just written it.
  const needed = schemaUpdateSpaceNeeded(statSync(file).size);
  const free = freeBytes(dirname(file));
  if (free < needed) {
    throw new OperationError(
      'config_error',
      `Updating the "${storeId}" store needs ${formatBytes(needed)} free on its disk, and ${formatBytes(free)} is free.`,
      'Free up space on that disk, then start Olympus again. Nothing was changed.',
    );
  }
  report({ phase: 'backing_up', storeId });
  // Written beside the backup and renamed into place: a backup that exists is whole.
  const partial = `${backup}.${process.pid}.partial`;
  rmSync(partial, { force: true });
  // Recorded before the copy starts, so a delete or forget finds a copy a crash left part way.
  recordSchemaBackup(env, { storeId, dbPath: file, backupPath: backup });
  try {
    // Created empty and owner-only first: SQLite would create it with the umask's mode.
    closeSync(openSync(partial, 'wx', 0o600));
    db.query('VACUUM INTO ?').run(partial);
    chmodSync(partial, 0o600);
    // Another opener may have finished the update first: its backup stands,
    // and a copy of the updated store must not replace it.
    if (copyVersion(db, partial, storeId) !== fromVersion) {
      rmSync(partial, { force: true });
      return Math.round(performance.now() - started);
    }
    renameSync(partial, backup);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return Math.round(performance.now() - started);
}

function copyVersion(db: Database, path: string, storeId: string): number {
  // The open handle's own class: this module never loads bun:sqlite itself.
  const copy = new (db.constructor as new (path: string, options: { readonly: boolean }) => Database)(path, { readonly: true });
  try {
    return readSqliteSchemaVersion(copy, storeId);
  } finally {
    copy.close();
  }
}

function defaultFreeBytes(directory: string): number {
  const stats = statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

export function readSqliteSchemaVersion(db: Database, storeId: string): number {
  if (!schemaVersionTableExists(db)) return 0;
  const row = db
    .query(`SELECT version FROM ${SQLITE_SCHEMA_VERSION_TABLE} WHERE store_id = ?`)
    .get(storeId) as { version?: number } | null;
  return typeof row?.version === 'number' && Number.isInteger(row.version) ? row.version : 0;
}

function ensureSchemaVersionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SQLITE_SCHEMA_VERSION_TABLE} (
      store_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function writeSqliteSchemaVersion(db: Database, storeId: string, version: number): void {
  db.query(`
    INSERT INTO ${SQLITE_SCHEMA_VERSION_TABLE} (store_id, version, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      version = excluded.version,
      applied_at = excluded.applied_at
  `).run(storeId, version, new Date().toISOString());
}

function schemaVersionTableExists(db: Database): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(SQLITE_SCHEMA_VERSION_TABLE) as { name?: string } | null;
  return row?.name === SQLITE_SCHEMA_VERSION_TABLE;
}

function validateMigrations(migrations: SqliteMigration[]): SqliteMigration[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  let previous = 0;
  for (const migration of ordered) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new OperationError('config_error', `SQLite migration "${migration.name}" must use a positive integer version.`);
    }
    if (migration.version === previous) {
      throw new OperationError('config_error', `Duplicate SQLite migration version ${migration.version}.`);
    }
    previous = migration.version;
  }
  return ordered;
}
