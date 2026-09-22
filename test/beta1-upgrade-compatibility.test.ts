import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const FIXTURE_SQL = readFileSync(join(import.meta.dir, 'fixtures/beta1-connector-store.sql'), 'utf8');
const CORPUS_ID = 'secure_local.dropbox.files';
const LOCAL_ITEM_ID = 'personal:synthetic-beta1-item';
const CONTENT = 'Synthetic beta one searchable covenant content.';
const ACCOUNT_GENERATION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SCOPE_REVISION = '11111111-1111-4111-8111-111111111111';
const FOLDER_KEY = 'id:approved-folder';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('beta1 connector-store upgrade compatibility', () => {
  test('opens and reopens a beta1 schema-12 store without losing content or trusted scope restrictions', () => {
    const dbPath = createFixtureDatabase();

    assertScopedFixture(newStore(dbPath));
    assertScopedFixture(newStore(dbPath));

    const db = new Database(dbPath, { readonly: true, create: false, strict: true });
    try {
      expect(schemaVersion(db)).toBe(12);
      expect(db.query(`
        SELECT source_scope_generation, source_scope_revision, source_scope_folder_keys_json
        FROM items WHERE local_item_id = ?
      `).get(LOCAL_ITEM_ID)).toEqual({
        source_scope_generation: ACCOUNT_GENERATION,
        source_scope_revision: SCOPE_REVISION,
        source_scope_folder_keys_json: JSON.stringify([FOLDER_KEY]),
      });
    } finally {
      db.close();
    }
  });

  test('migrates the additive schema 11 to 12 without losing the existing searchable item', () => {
    const dbPath = createFixtureDatabase();
    const old = new Database(dbPath);
    try {
      old.exec(`
        ALTER TABLE items DROP COLUMN source_scope_folder_keys_json;
        ALTER TABLE items DROP COLUMN source_scope_revision;
        ALTER TABLE items DROP COLUMN source_scope_generation;
      `);
      old.query("UPDATE schema_version SET version = 11 WHERE store_id = 'connector-store'").run();
    } finally {
      old.close();
    }

    const store = newStore(dbPath);
    try {
      expect(store.localContent(LOCAL_ITEM_ID)?.chunks).toEqual([CONTENT]);
      expect(store.searchItems('covenant', 10, 'personal').map((row) => row.sourceItem.localItemId))
        .toEqual([LOCAL_ITEM_ID]);
    } finally {
      store.close();
    }

    const migrated = new Database(dbPath, { readonly: true, create: false, strict: true });
    try {
      expect(schemaVersion(migrated)).toBe(12);
      expect(migrated.query(`
        SELECT source_scope_generation, source_scope_revision, source_scope_folder_keys_json
        FROM items WHERE local_item_id = ?
      `).get(LOCAL_ITEM_ID)).toEqual({
        source_scope_generation: null,
        source_scope_revision: null,
        source_scope_folder_keys_json: null,
      });
    } finally {
      migrated.close();
    }
  });
});

function createFixtureDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'olympus-beta1-upgrade-'));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, 'connector-store.sqlite');
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(FIXTURE_SQL);
  } finally {
    db.close();
  }
  return dbPath;
}

function newStore(dbPath: string): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
}

function assertScopedFixture(store: LocalConnectorStore): void {
  try {
    expect(store.localContent(LOCAL_ITEM_ID)?.chunks).toEqual([CONTENT]);
    const allowed = store.searchItems('covenant', 10, 'personal', {
      provider: 'dropbox',
      sourceScopeGeneration: ACCOUNT_GENERATION,
      sourceScopeRevision: SCOPE_REVISION,
      sourceScopeFolderAnyKeys: [FOLDER_KEY],
    });
    expect(allowed.map((row) => row.sourceItem.localItemId)).toEqual([LOCAL_ITEM_ID]);

    expect(store.searchItems('covenant', 10, 'work', {
      sourceScopeGeneration: ACCOUNT_GENERATION,
      sourceScopeRevision: SCOPE_REVISION,
      sourceScopeFolderAnyKeys: [FOLDER_KEY],
    })).toEqual([]);
    expect(store.searchItems('covenant', 10, 'personal', {
      sourceScopeGeneration: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sourceScopeRevision: SCOPE_REVISION,
      sourceScopeFolderAnyKeys: [FOLDER_KEY],
    })).toEqual([]);
    expect(store.searchItems('covenant', 10, 'personal', {
      sourceScopeGeneration: ACCOUNT_GENERATION,
      sourceScopeRevision: SCOPE_REVISION,
      sourceScopeFolderAnyKeys: ['id:outside-folder'],
    })).toEqual([]);
    expect(store.searchItems('covenant', 10, 'personal', {
      sourceScopeGeneration: ACCOUNT_GENERATION,
      sourceScopeRevision: '22222222-2222-4222-8222-222222222222',
      sourceScopeFolderAnyKeys: [FOLDER_KEY],
    })).toEqual([]);
  } finally {
    store.close();
  }
}

function schemaVersion(db: Database): number {
  return (db.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get() as {
    version: number;
  }).version;
}
