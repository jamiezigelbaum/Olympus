import type { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, openSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { preSchemaBackupPath, recordSchemaBackup, removeAbandonedBackupCopies, reportBootStep, workerUpgradeInFlight, type BootStepEvent } from './boot-progress.ts';
import { setEngineStep } from './engine-heartbeat.ts';
import { upgradeCopyExists } from './upgrade-store-copies.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';

export const SQLITE_SCHEMA_VERSION_TABLE = 'schema_version';
export const CURRENT_OLYMPUS_SQLITE_SCHEMA_VERSION = 1;

export interface SqliteMigration {
  version: number;
  name: string;
  up(db: Database): void;
}

// A store's compatible version is the lowest schema version a build must know
// to use it (Chromium's sql::MetaTable rule). A migration made with
// `additiveMigration` only adds tables, indexes or columns, so it leaves the
// compatible version where it was: a build one version behind still opens the
// store, a rollback needs no copy of it, and the boot takes none. Every other
// migration raises the compatible version to its own.
//
// Only `additiveMigration` can mark a migration additive: the mark is this
// module's own set, not a field another module can set by hand.
const ADDITIVE_MIGRATIONS = new WeakSet<SqliteMigration>();
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
// A new table (no AS SELECT): the previous build never reads or writes it.
const NEW_TABLE = new RegExp(`^CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s*\\(`, 'i');
// A plain index on named columns: no expression the previous build's writes
// could fail to evaluate, no WHERE, never UNIQUE.
const NEW_INDEX = new RegExp(`^CREATE\\s+INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s+ON\\s+${NAME}\\s*\\(\\s*${NAME}(\\s+(ASC|DESC))?(\\s*,\\s*${NAME}(\\s+(ASC|DESC))?)*\\s*\\)$`, 'i');
// A nullable column with at most a literal default: the previous build's
// writes, which never name it, still pass every constraint.
const NEW_COLUMN = new RegExp(`^ALTER\\s+TABLE\\s+${NAME}\\s+ADD\\s+(COLUMN\\s+)?${NAME}(\\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC))?(\\s+DEFAULT\\s+(NULL|-?[0-9]+(\\.[0-9]+)?|'[^']*'))?$`, 'i');
/** Words that change or read existing rows, or the shape old code relies on. */
// REFERENCES: a new table pointing at an old one can refuse the previous
// build's deletes there.
const NOT_ADDITIVE = /\b(DROP|RENAME|UPDATE|DELETE|INSERT|REPLACE|SELECT|TRIGGER|UNIQUE|VACUUM|PRAGMA|ATTACH|DETACH|REFERENCES)\b/i;

function additiveStatement(body: string): boolean {
  if (body.includes(';') || NOT_ADDITIVE.test(body)) return false;
  return NEW_TABLE.test(body) || NEW_INDEX.test(body) || NEW_COLUMN.test(body);
}

/**
 * A migration that only adds: a new table, a plain non-unique index on named
 * columns, or a nullable column with at most a literal default; one statement
 * each. A build that knows only the version before it still opens the store
 * and writes it. Throws on anything else, so a migration that rewrites, drops,
 * renames or constrains cannot be declared additive.
 *
 * The code that reads an added column must treat NULL as "not known yet": the
 * previous build writes rows without it, and its INSERT OR REPLACE writes a
 * row back with the column at its default.
 */
export function additiveMigration(version: number, name: string, statements: readonly string[]): SqliteMigration {
  if (statements.length === 0) throw new OperationError('config_error', `Additive migration "${name}" has no statements.`);
  for (const statement of statements) {
    const body = statement.trim().replace(/;$/, '').trim();
    if (!additiveStatement(body)) {
      throw new OperationError('config_error', `Additive migration "${name}" has a statement that is not additive: ${body.slice(0, 80)}`);
    }
  }
  const migration: SqliteMigration = {
    version,
    name,
    up(db) { for (const statement of statements) db.exec(statement); },
  };
  ADDITIVE_MIGRATIONS.add(migration);
  return migration;
}

export function isAdditiveMigration(migration: SqliteMigration): boolean {
  return ADDITIVE_MIGRATIONS.has(migration);
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
  if (currentVersion > knownVersion && readSqliteCompatibleVersion(db, storeId) > knownVersion) {
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
    // A newer build's store that this one may still use: nothing to apply.
    if (readSqliteCompatibleVersion(db, storeId) <= targetVersion) {
      return { storeId, currentVersion, targetVersion, dryRun: options.dryRun === true, applied: [], pending: [] };
    }
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
  // Progress goes to stderr: a CLI command's stdout may be JSON for another program.
  const log = options.log ?? ((line: string) => console.error(line));
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
    // A new store whose tables join a file that already holds another
    // store's (limit-stops in source-scheduler.sqlite) changes that file
    // too: it is copied as well, so a rollback takes the new tables out
    // (gate7 forced leg on c013270b, 13 Nov).
    // The upgrade already copied the whole file after the previous version
    // stopped (upgrade-store-copies.ts): no second copy, and none on this loop.
    const upgradeCopied = storeOnDisk(db) && upgradeCopyExists(db.filename);
    // Only additions, to a store a build that knows compatible versions last
    // wrote: the version a rollback restores still opens it, so no copy.
    // A store from before compatible versions keeps its copy, since the build
    // a rollback restores then refuses any version newer than its own.
    const compatibleWithPrevious = currentVersion > 0
      && storedCompatibleVersion(db, storeId) !== undefined
      && ordered.filter((migration) => migration.version > currentVersion).every(isAdditiveMigration);
    // With no worker upgrade in flight nothing would ever put a copy back or
    // remove it, so none is taken (workerUpgradeInFlight). Within one, only a
    // store the upgrade did not copy is copied here, and the step says so.
    const backupMs = storeOnDisk(db) && !upgradeCopied && !compatibleWithPrevious
      && workerUpgradeInFlight(env)
      && (currentVersion > 0 || holdsOtherVersionedStore(db, storeId))
      ? backUpBeforeUpdate(db, storeId, currentVersion, env, report, options.freeBytes)
      : undefined;
    report({ phase: 'migrating', storeId });
    setEngineStep(`updating ${storeId}`);
    const migrateStarted = performance.now();
    // Another process may open the same file at the same moment (the CLI and
    // the worker). Take the write lock before reading the version again, and
    // apply only what is still pending under it: the loser of the race waits
    // (busy_timeout) and then finds nothing to do, rather than running a
    // migration twice or failing on a stale snapshot.
    db.transaction(() => {
      const lockedVersion = readSqliteSchemaVersion(db, storeId);
      // Another process moved it past this build in the meantime, compatibly.
      if (lockedVersion > targetVersion && readSqliteCompatibleVersion(db, storeId) <= targetVersion) return;
      if (lockedVersion > targetVersion) {
        throw new OperationError(
          'config_error',
          `SQLite store "${storeId}" is at schema_version ${lockedVersion}, but this Olympus build only knows schema_version ${targetVersion}.`,
          'Upgrade Olympus before opening this store. Refusing to open it prevents an older build from corrupting newer data.',
        );
      }
      // A store from before compatible versions starts at its own version.
      let compatible = storedCompatibleVersion(db, storeId) ?? lockedVersion;
      for (const migration of ordered.filter((entry) => entry.version > lockedVersion)) {
        migration.up(db);
        if (!isAdditiveMigration(migration)) compatible = migration.version;
        writeSqliteSchemaVersion(db, storeId, migration.version, compatible);
        applied.push({ version: migration.version, name: migration.name });
      }
    }).immediate();
    const migrateMs = Math.round(performance.now() - migrateStarted);
    setEngineStep(undefined);
    report({ phase: 'starting', storeId, completedStore: true });
    if (logged && applied.length > 0) {
      log(`${label}: ${backupMs !== undefined ? `backed up in ${backupMs} ms` : upgradeCopied ? 'copied by the upgrade' : 'in memory, no backup'}, migrated in ${migrateMs} ms`);
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

/**
 * The file already holds another versioned store: a store joining it at
 * version 0 changes a file a rollback must put back as it was. A file whose
 * tables predate versioning, or a new file, needs no copy.
 */
function holdsOtherVersionedStore(db: Database, storeId: string): boolean {
  if (!schemaVersionTableExists(db)) return false;
  return (db.query(`SELECT COUNT(*) AS n FROM ${SQLITE_SCHEMA_VERSION_TABLE}
    WHERE store_id != ? AND version > 0`).get(storeId) as { n: number }).n > 0;
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
  // A killed backup's part-way copy is, before the space is measured.
  removeAbandonedBackupCopies(backup);
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
  setEngineStep(`backing up ${storeId}`);
  // Written beside the backup and renamed into place: a backup that exists is whole.
  const partial = `${backup}.${process.pid}.partial`;
  rmSync(partial, { force: true });
  // Recorded before the copy starts, so a delete or forget finds a copy a crash left part way.
  recordSchemaBackup(env, { storeId, dbPath: file, backupPath: backup });
  try {
    // Created empty and owner-only first: SQLite would create it with the umask's mode.
    closeSync(openSync(partial, 'wx', 0o600));
    // Copied through a second, read-only handle: a store may run its update inside
    // its own transaction, where VACUUM is refused. That handle sees the last
    // committed state, which is the version being replaced.
    const source = openReadonly(db, file);
    try {
      source.query('VACUUM INTO ?').run(partial);
    } finally {
      source.close();
    }
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

/** Opens `path` read-only with the open handle's own class: this module never loads bun:sqlite itself. */
function openReadonly(db: Database, path: string): Database {
  return new (db.constructor as new (path: string, options: { readonly: boolean }) => Database)(path, { readonly: true });
}

function copyVersion(db: Database, path: string, storeId: string): number {
  const copy = openReadonly(db, path);
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

/**
 * Whether this build, which knows schema version `knownVersion`, uses the
 * store as it is: at that version, or newer but compatible with it.
 */
export function sqliteSchemaUsable(db: Database, storeId: string, knownVersion: number): boolean {
  const version = readSqliteSchemaVersion(db, storeId);
  return version === knownVersion || (version > knownVersion && readSqliteCompatibleVersion(db, storeId) <= knownVersion);
}

/**
 * The lowest schema version a build must know to use this store: its own
 * version for a store from before compatible versions.
 */
export function readSqliteCompatibleVersion(db: Database, storeId: string): number {
  return storedCompatibleVersion(db, storeId) ?? readSqliteSchemaVersion(db, storeId);
}

/**
 * The stored compatible version, when a build that knows them wrote this
 * store's row. A build from before them (1.4) updates `version` and leaves the
 * column as it was; it only ever does so for versions every later build knows,
 * so a stale value never lets a build open a store newer than it can use.
 */
function storedCompatibleVersion(db: Database, storeId: string): number | undefined {
  if (!schemaVersionTableExists(db) || !compatibleVersionColumnExists(db)) return undefined;
  const row = db
    .query(`SELECT compatible_version FROM ${SQLITE_SCHEMA_VERSION_TABLE} WHERE store_id = ?`)
    .get(storeId) as { compatible_version?: number | null } | null;
  return typeof row?.compatible_version === 'number' && Number.isInteger(row.compatible_version) ? row.compatible_version : undefined;
}

function compatibleVersionColumnExists(db: Database): boolean {
  return (db.query(`SELECT COUNT(*) AS n FROM pragma_table_info('${SQLITE_SCHEMA_VERSION_TABLE}') WHERE name = 'compatible_version'`)
    .get() as { n: number }).n > 0;
}

function ensureSchemaVersionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SQLITE_SCHEMA_VERSION_TABLE} (
      store_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      compatible_version INTEGER
    );
  `);
  // Added beside the 1.4 columns: 1.4 writes rows by column name and ignores it.
  if (compatibleVersionColumnExists(db)) return;
  try {
    db.exec(`ALTER TABLE ${SQLITE_SCHEMA_VERSION_TABLE} ADD COLUMN compatible_version INTEGER`);
  } catch (error) {
    // Another process opening the same file added it first.
    if (!compatibleVersionColumnExists(db)) throw error;
  }
}

function writeSqliteSchemaVersion(db: Database, storeId: string, version: number, compatible: number): void {
  db.query(`
    INSERT INTO ${SQLITE_SCHEMA_VERSION_TABLE} (store_id, version, applied_at, compatible_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      version = excluded.version,
      applied_at = excluded.applied_at,
      compatible_version = excluded.compatible_version
  `).run(storeId, version, new Date().toISOString(), compatible);
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
