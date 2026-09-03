import type { Database } from 'bun:sqlite';
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
  options: { dryRun?: boolean; knownVersion?: number } = {},
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

  ensureSchemaVersionTable(db);
  const applied: Array<{ version: number; name: string }> = [];
  db.transaction(() => {
    for (const migration of ordered.filter((entry) => entry.version > currentVersion)) {
      migration.up(db);
      writeSqliteSchemaVersion(db, storeId, migration.version);
      applied.push({ version: migration.version, name: migration.name });
    }
  })();

  return {
    storeId,
    currentVersion,
    targetVersion,
    dryRun: false,
    applied,
    pending: applied,
  };
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
