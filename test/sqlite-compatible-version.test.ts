// A compatible version per store (Chromium's sql::MetaTable rule). A
// migration that only adds tables, indexes or columns leaves the store usable
// by the build one version behind: no copy before it, and a rollback is
// "start the previous build". Everything else raises the compatible version.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { finishBootProgress } from '../src/core/boot-progress.ts';
import {
  additiveMigration,
  assertSqliteSchemaCanOpen,
  isAdditiveMigration,
  readSqliteCompatibleVersion,
  readSqliteSchemaVersion,
  runSqliteMigrations,
  sqliteSchemaUsable,
  type SqliteMigration,
} from '../src/core/sqlite-migrations.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';

const roots: string[] = [];
afterEach(() => {
  finishBootProgress();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-compatible-version-'));
  roots.push(root);
  return { HOME: root, XDG_DATA_HOME: join(root, '.local', 'share') };
}

const CREATE: SqliteMigration = { version: 1, name: 'create', up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)') };
const ADD = additiveMigration(2, 'add_tier', ['ALTER TABLE items ADD COLUMN tier TEXT', 'CREATE INDEX IF NOT EXISTS items_tier ON items(tier)']);
const REWRITE: SqliteMigration = { version: 3, name: 'rewrite', up: (db) => db.exec("UPDATE items SET tier = 'personal'") };

describe('additive migrations', () => {
  test('only adding statements can be declared additive', () => {
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS extra (id INTEGER PRIMARY KEY)',
      'CREATE INDEX extra_id ON extra(id)',
      'ALTER TABLE items ADD COLUMN note TEXT DEFAULT \'\'',
      'ALTER TABLE items ADD COLUMN score REAL DEFAULT 0.5;',
      'CREATE INDEX IF NOT EXISTS items_body_id ON items(body DESC, id)',
    ]) expect(isAdditiveMigration(additiveMigration(9, 'ok', [statement]))).toBe(true);
    for (const statement of [
      'DROP TABLE items',
      'ALTER TABLE items RENAME TO old_items',
      'ALTER TABLE items DROP COLUMN body',
      "UPDATE items SET body = ''",
      'DELETE FROM items',
      'INSERT INTO items (body) VALUES (1)',
      'CREATE UNIQUE INDEX one_body ON items(body)',
      'CREATE TABLE copy AS SELECT * FROM items',
      'CREATE TRIGGER t AFTER INSERT ON items BEGIN SELECT 1; END',
      'CREATE TABLE a (id INTEGER); DROP TABLE items',
      'VACUUM',
      // Each of these makes a write the previous build does today fail.
      'ALTER TABLE items ADD COLUMN required TEXT NOT NULL DEFAULT \'\'',
      'ALTER TABLE items ADD COLUMN positive INTEGER CHECK (positive > 0)',
      'ALTER TABLE items ADD COLUMN owner INTEGER REFERENCES owners(id)',
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, item INTEGER REFERENCES items(id))',
      "CREATE INDEX by_json ON items(json_extract(body, '$.x'))",
      'CREATE INDEX recent ON items(id) WHERE body IS NOT NULL',
    ]) expect(() => additiveMigration(9, 'not_ok', [statement])).toThrow('not additive');
    expect(() => additiveMigration(9, 'empty', [])).toThrow('no statements');
  });

  test('a migration written by hand is never additive', () => {
    expect(isAdditiveMigration(CREATE)).toBe(false);
    expect(isAdditiveMigration({ ...ADD })).toBe(false);
  });
});

describe('a store records the lowest version that can use it', () => {
  test('an additive update keeps it, and the build one version behind still opens the store', () => {
    const env = home();
    const db = new Database(join(env.HOME!, 'store.sqlite'), { create: true });
    runSqliteMigrations(db, 'fixture', [CREATE, ADD], { env, log: () => {} });
    expect(readSqliteSchemaVersion(db, 'fixture')).toBe(2);
    expect(readSqliteCompatibleVersion(db, 'fixture')).toBe(1);
    // The previous build, which knows only version 1.
    expect(() => assertSqliteSchemaCanOpen(db, 'fixture', 1)).not.toThrow();
    expect(sqliteSchemaUsable(db, 'fixture', 1)).toBe(true);
    expect(runSqliteMigrations(db, 'fixture', [CREATE], { env, log: () => {} }).applied).toEqual([]);
    expect(readSqliteSchemaVersion(db, 'fixture')).toBe(2);
    db.query('INSERT INTO items (body) VALUES (?)').run('written by the previous build');
    db.close();
  });

  test('a rewrite raises it, and the previous build refuses the store', () => {
    const env = home();
    const db = new Database(join(env.HOME!, 'store.sqlite'), { create: true });
    runSqliteMigrations(db, 'fixture', [CREATE, ADD, REWRITE], { env, log: () => {} });
    expect(readSqliteCompatibleVersion(db, 'fixture')).toBe(3);
    expect(() => assertSqliteSchemaCanOpen(db, 'fixture', 2)).toThrow('only knows schema_version 2');
    expect(() => runSqliteMigrations(db, 'fixture', [CREATE, ADD], { env, log: () => {} })).toThrow('only knows schema_version 2');
    expect(sqliteSchemaUsable(db, 'fixture', 2)).toBe(false);
    db.close();
  });

  test('a store from before compatible versions counts its own version', () => {
    const env = home();
    const db = new Database(join(env.HOME!, 'store.sqlite'), { create: true });
    // As 1.4 wrote it: no compatible_version column.
    db.exec(`CREATE TABLE schema_version (store_id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_version (store_id, version, applied_at) VALUES ('fixture', 2, '2026-11-01T00:00:00Z');`);
    expect(readSqliteCompatibleVersion(db, 'fixture')).toBe(2);
    expect(() => assertSqliteSchemaCanOpen(db, 'fixture', 1)).toThrow('only knows schema_version 1');
    db.close();
  });
});

describe('the boot copies only what a rollback needs', () => {
  test('an additive update of a store a compatible-version build wrote takes no copy', () => {
    const env = home();
    const path = join(env.HOME!, 'store.sqlite');
    const db = new Database(path, { create: true });
    runSqliteMigrations(db, 'fixture', [CREATE], { env, log: () => {} });
    db.query('INSERT INTO items (body) VALUES (?)').run('kept');
    const lines: string[] = [];
    runSqliteMigrations(db, 'fixture', [CREATE, ADD], { env, log: (line) => lines.push(line) });
    db.close();
    expect(existsSync(`${path}.pre-schema-1.bak`)).toBe(false);
    expect(lines.at(-1)).toMatch(/^\[storage\] fixture schema 1 to 2: in memory, no backup, migrated in \d+ ms$/);
  });

  test('a store from before compatible versions is still copied, since the previous build refuses newer versions', () => {
    const env = home();
    const path = join(env.HOME!, 'store.sqlite');
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT);
      CREATE TABLE schema_version (store_id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_version (store_id, version, applied_at) VALUES ('fixture', 1, '2026-11-01T00:00:00Z');`);
    runSqliteMigrations(db, 'fixture', [CREATE, ADD], { env, log: () => {} });
    db.close();
    expect(existsSync(`${path}.pre-schema-1.bak`)).toBe(true);
  });

  test('an update with any rewrite in it is copied', () => {
    const env = home();
    const path = join(env.HOME!, 'store.sqlite');
    const db = new Database(path, { create: true });
    runSqliteMigrations(db, 'fixture', [CREATE], { env, log: () => {} });
    runSqliteMigrations(db, 'fixture', [CREATE, ADD, REWRITE], { env, log: () => {} });
    db.close();
    expect(existsSync(`${path}.pre-schema-1.bak`)).toBe(true);
  });
});

// The previous release opens a store the next one changed additively. This
// build stands in for "the previous release": each large store is made at
// this build's schema, then given what an additive next version could add (a
// column on every table, a new table and index, version one higher, compatible
// version this build's), and must open again for writing and reading.
function bumpAdditively(path: string, storeId: string): void {
  const db = new Database(path);
  try {
    const version = readSqliteSchemaVersion(db, storeId);
    const tables = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE TABLE%'
      AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version'`).all() as Array<{ name: string }>).map((row) => row.name);
    // A virtual table's shadow tables are its own business.
    const shadow = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all() as Array<{ name: string }>)
      .flatMap(({ name }) => tables.filter((table) => table.startsWith(`${name}_`))));
    db.transaction(() => {
      for (const table of tables) if (!shadow.has(table)) db.exec(`ALTER TABLE "${table}" ADD COLUMN next_release_note TEXT`);
      db.exec('CREATE TABLE next_release_extra (id INTEGER PRIMARY KEY, note TEXT); CREATE INDEX next_release_extra_note ON next_release_extra(note);');
      const bumped = db.query('UPDATE schema_version SET version = ?, compatible_version = ? WHERE store_id = ?').run(version + 1, version, storeId);
      expect(version).toBeGreaterThan(0);
      expect(bumped.changes).toBe(1);
    })();
  } finally { db.close(); }
}

describe('the previous release opens a store the next one changed additively', () => {
  test('connector store', async () => {
    const env = home();
    const dbPath = join(env.HOME!, 'connector.sqlite');
    const open = (readOnly = false) => new LocalConnectorStore({ dbPath, corpusId: 'compat', family: 'x', trustDomain: 'internal', ...(readOnly ? { readOnly } : {}) });
    open().close();
    bumpAdditively(dbPath, 'connector-store');
    const writer = open();
    writer.close();
    const reader = open(true);
    reader.close();
    const db = new Database(dbPath, { readonly: true });
    expect(readSqliteSchemaVersion(db, 'connector-store')).toBe(17);
    db.close();
  });

  test('tier ledger', () => {
    const env = home();
    const dbPath = join(env.HOME!, 'ledger.sqlite');
    new TierLedger({ dbPath }).close();
    bumpAdditively(dbPath, 'olympus_tier_ledger');
    expect(() => TierLedger.assertSchemaCanOpen(dbPath)).not.toThrow();
    expect(() => TierLedger.assertSchemaCanOpen(dbPath, true)).not.toThrow();
    const writer = new TierLedger({ dbPath });
    expect(writer.hasCurrentSchema()).toBe(true);
    writer.close();
    new TierLedger({ dbPath, readOnly: true }).close();
  });

  test('sniffer store', () => {
    const env = home();
    const dbPath = join(env.HOME!, 'sniffer.sqlite');
    new TierSnifferStore({ dbPath }).close();
    bumpAdditively(dbPath, 'olympus_tier_sniffer');
    new TierSnifferStore({ dbPath }).close();
    new TierSnifferStore({ dbPath, readOnly: true }).close();
  });
});

describe('guards', () => {
  const SRC = join(import.meta.dir, '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
  // The stores the test above opens after an additive bump. Another store
  // joins this list (and that test) before it may declare an additive migration.
  const COVERED = new Set([
    'workers/connector-store/local-index.ts',
    'workers/classification/tier-ledger.ts',
    'workers/classification/sniffer-store.ts',
  ]);

  test('only a store the previous-release test covers declares additive migrations', () => {
    const uses = files(SRC)
      .filter((file) => relative(SRC, file) !== 'core/sqlite-migrations.ts' && readFileSync(file, 'utf8').includes('additiveMigration('))
      .map((file) => relative(SRC, file));
    expect(uses.filter((file) => !COVERED.has(file))).toEqual([]);
  });

  test('no INSERT without a column list, which an added column would break in the previous build', () => {
    // Temporary tables are made by the same statement that fills them; the
    // messaging pairing store copies tables it has just made, unversioned.
    const exempt = (file: string, target: string) => target.startsWith('temp.')
      || (relative(SRC, file) === 'core/messaging-pairing.ts' && target.startsWith('main.'));
    const positional = files(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s+([A-Za-z_"`$.{}]+)\s+(?:VALUES|SELECT)\b/g)]
        .filter((match) => !exempt(file, match[1]!))
        .map((match) => `${relative(SRC, file)}: ${match[0].replace(/\s+/g, ' ')}`);
    });
    expect(positional).toEqual([]);
  });
});
