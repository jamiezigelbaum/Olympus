import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  readSqliteSchemaVersion,
  runSqliteMigrations,
} from '../src/core/sqlite-migrations.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

describe('SQLite schema migration runner', () => {
  test('migrates up and is idempotent on a fixture DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sqlite-migrations-'));
    const path = join(dir, 'fixture.sqlite');
    try {
      const db = openDatabase(path);
      const first = runSqliteMigrations(db, 'fixture-store');
      const second = runSqliteMigrations(db, 'fixture-store');

      expect(first.applied).toEqual([{ version: 1, name: 'record_existing_v1_schema' }]);
      expect(second.applied).toEqual([]);
      expect(readSqliteSchemaVersion(db, 'fixture-store')).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run reports pending migrations without writing schema_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sqlite-migrations-dry-'));
    const path = join(dir, 'fixture.sqlite');
    try {
      const db = openDatabase(path);
      const result = runSqliteMigrations(db, 'fixture-store', undefined, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.pending).toEqual([{ version: 1, name: 'record_existing_v1_schema' }]);
      expect(result.applied).toEqual([]);
      expect(readSqliteSchemaVersion(db, 'fixture-store')).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('connector-store startup refuses a newer-than-known schema honestly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connector-migrations-newer-'));
    const path = join(dir, 'connector.sqlite');
    try {
      const db = openDatabase(path);
      db.exec([
        'CREATE TABLE schema_version (',
        'store_id TEXT PRIMARY KEY,',
        'version INTEGER NOT NULL,',
        'applied_at TEXT NOT NULL',
        ');',
      ].join(' '));
      db.query('INSERT INTO schema_version (store_id, version, applied_at) VALUES (?, ?, ?)')
        .run('connector-store', 99, new Date().toISOString());
      db.close();

      expect(() => new LocalConnectorStore({
        dbPath: path,
        corpusId: 'internal.test.items',
        family: 'file',
        trustDomain: 'internal',
      })).toThrow(/schema_version 99/);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('canonical connector-store migrations are current and idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connector-migrations-'));
    const path = join(dir, 'connector.sqlite');
    try {
      new LocalConnectorStore({
        dbPath: path,
        corpusId: 'internal.test.items',
        family: 'file',
        trustDomain: 'internal',
      }).close();

      let db = openDatabase(path);
      expect(readSqliteSchemaVersion(db, 'connector-store')).toBe(11);
      expect(tableColumns(db, 'items')).toEqual(expect.arrayContaining([
        'search_text',
        'sender_id',
        'sender_label',
        'sender_is_owner',
        'reactions_json',
      ]));
      expect(tableNames(db)).toEqual(expect.arrayContaining([
        'item_owners',
        'embedding_models',
        'item_write_claims',
        'item_locator_identities',
        'locator_identity_index_state',
      ]));
      db.close();

      new LocalConnectorStore({
        dbPath: path,
        corpusId: 'internal.test.items',
        family: 'file',
        trustDomain: 'internal',
      }).close();

      db = openDatabase(path);
      expect(readSqliteSchemaVersion(db, 'connector-store')).toBe(11);
      expect(schemaVersionRows(db, 'connector-store')).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}

function tableColumns(db: Database, tableName: string): string[] {
  return db.query('PRAGMA table_info(' + tableName + ')').all()
    .map((row) => (row as { name: string }).name);
}

function tableNames(db: Database): string[] {
  return db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((row) => (row as { name: string }).name);
}

function schemaVersionRows(db: Database, storeId: string): number {
  const row = db.query('SELECT COUNT(*) AS count FROM schema_version WHERE store_id = ?')
    .get(storeId) as { count: number };
  return row.count;
}
