/**
 * A failed update puts the whole data root back as it was (put-back step-back, 16 Nov 2026). Today's put-back rebuilds the
 * root file by file from the mark's list and the record of copies. The cases marked `test.failing` show what that misses.
 * Each one failed a real rollback, or is the same kind of miss:
 * - a store outside the scan (behind a linked folder, or outside the root) that the new build migrates at boot;
 * - JSON state the new build rewrites (archive-imports.json said "imported" for an import whose store was put back,
 *   mac-upgrade 43798749074).
 * When the whole-root snapshot and swap land, those cases pass, and `test.failing` turns them red until it is removed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyEngineStores, restoreEngineStores } from '../src/core/engine-store-copies.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { runSqliteMigrations, type SqliteMigration } from '../src/core/sqlite-migrations.ts';

const STORE = 'connector-store';
const V1: SqliteMigration = { version: 1, name: 'old', up(db) { db.exec('CREATE TABLE IF NOT EXISTS kept (body TEXT)'); } };
// Not additive: the old build refuses a store at version 2, as 1.4.4 refused schema 16.
const V2: SqliteMigration = { version: 2, name: 'new', up(db) { db.exec('CREATE TABLE IF NOT EXISTS added (x INTEGER); DROP TABLE IF EXISTS gone'); } };

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function machine() {
  const home = mkdtempSync(join(tmpdir(), 'olympus-put-back-whole-root-'));
  homes.push(home);
  const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') };
  const root = olympusDataRoot(env);
  mkdirSync(root, { recursive: true });
  const quiet = { env, log: () => {}, report: () => {} };
  /** The old build opens (or creates) a store: it knows version 1 and refuses anything newer. */
  const oldOpens = (path: string): void => {
    const db = new Database(path, { create: true });
    try {
      runSqliteMigrations(db, STORE, [V1], { ...quiet, knownVersion: 1 });
      db.exec("INSERT INTO kept VALUES ('old')");
    } finally { db.close(); }
  };
  /** The new build's boot migrates a store it opens, taking its own copy where the upgrade took none. */
  const newMigrates = (path: string): void => {
    const db = new Database(path);
    try { runSqliteMigrations(db, STORE, [V1, V2], quiet); } finally { db.close(); }
  };
  const update = () => copyEngineStores(env, { bunBin: process.execPath });
  const putBack = () => restoreEngineStores(env, { log: () => {} });
  return { home, env, root, oldOpens, newMigrates, update, putBack };
}

describe('a failed update puts the data root back as it was', () => {
  test('a store inside the root: the old build opens it again', () => {
    const m = machine();
    const store = join(m.root, 'sources', 'gmail.email', '1', 'stores', 'internal.sqlite');
    mkdirSync(join(store, '..'), { recursive: true });
    m.oldOpens(store);
    m.update();
    m.newMigrates(store);
    m.putBack();
    expect(() => m.oldOpens(store)).not.toThrow();
  }, 30_000);

  test.failing('a store behind a linked folder in the root: the old build opens it again', () => {
    const m = machine();
    const elsewhere = join(m.home, 'linked-stores');
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(m.root, 'sources'), { recursive: true });
    symlinkSync(elsewhere, join(m.root, 'sources', 'telegram.messages'));
    const store = join(m.root, 'sources', 'telegram.messages', 'internal.sqlite');
    m.oldOpens(store);
    m.update();
    m.newMigrates(store);
    m.putBack();
    expect(() => m.oldOpens(store)).not.toThrow();
  }, 30_000);

  test.failing('a store outside the root that the new build migrates: the old build opens it again', () => {
    const m = machine();
    const outside = join(m.home, 'legacy', 'whatsapp.sqlite');
    mkdirSync(join(outside, '..'), { recursive: true });
    m.oldOpens(outside);
    m.update();
    m.newMigrates(outside);
    m.putBack();
    expect(() => m.oldOpens(outside)).not.toThrow();
  }, 30_000);

  test.failing('JSON state the new build rewrote goes back too (an import it finished stays the old build\'s to finish)', () => {
    const m = machine();
    const status = join(m.root, 'archive-imports.json');
    writeFileSync(status, JSON.stringify({ archives: [{ status: 'importing' }] }));
    const store = join(m.root, 'sources', 'archive.imports', '1', 'stores', 'email.secure_local.sqlite');
    mkdirSync(join(store, '..'), { recursive: true });
    m.oldOpens(store);
    m.update();
    m.newMigrates(store);
    writeFileSync(status, JSON.stringify({ archives: [{ status: 'imported' }] }));
    m.putBack();
    expect(() => m.oldOpens(store)).not.toThrow();
    expect(JSON.parse(readFileSync(status, 'utf8')).archives[0].status).toBe('importing');
  }, 30_000);
});
