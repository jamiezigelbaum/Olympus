/**
 * A failed update puts the whole data root back as it was (put-back step-back, 16 Nov 2026). The file-by-file put-back
 * it replaced failed each case below but the first, in a real rollback or the same kind of miss:
 * - a store outside the scan (behind a linked folder, or outside the root) that the new build migrates at boot;
 * - JSON state the new build rewrites (archive-imports.json said "imported" for an import whose store was put back,
 *   mac-upgrade 43798749074).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processesWithFilesUnder } from '../src/core/data-root-snapshot.ts';
import { commitEngineStores, copyEngineStores, restoreEngineStores } from '../src/core/engine-store-copies.ts';
import { legacyCaptureDataRoot, olympusDataRoot } from '../src/core/olympus-layout.ts';
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
  const update = () => copyEngineStores(env, { log: () => {} });
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

  test('a store behind a linked folder in the root: the old build opens it again', () => {
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

  test('a store outside the root that the new build migrates: the old build opens it again', () => {
    const m = machine();
    // The legacy capture folder (WhatsApp's bridge state, Telegram's spool), beside the root.
    const outside = join(legacyCaptureDataRoot(m.env), 'whatsapp-live', 'connector-store.db');
    mkdirSync(join(outside, '..'), { recursive: true });
    m.oldOpens(outside);
    m.update();
    m.newMigrates(outside);
    m.putBack();
    expect(() => m.oldOpens(outside)).not.toThrow();
  }, 30_000);

  test('JSON state the new build rewrote goes back too (an import it finished stays the old build\'s to finish)', () => {
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

describe('what the owner is told, and what is kept', () => {
  test('the failed root is kept, named, until the next update that succeeds', () => {
    const m = machine();
    const store = join(m.root, 'sources', 'gmail.email', '1', 'stores', 'internal.sqlite');
    mkdirSync(join(store, '..'), { recursive: true });
    m.oldOpens(store);
    m.update();
    m.newMigrates(store);
    const told = m.putBack();
    const kept = told.join(' ').match(/kept at (\S+) /)?.[1];
    expect(kept).toBeDefined();
    expect(existsSync(join(kept!, 'sources', 'gmail.email', '1', 'stores', 'internal.sqlite'))).toBe(true);
    m.update();
    const removed = commitEngineStores(m.env);
    expect(removed.join(' ')).toContain(kept!);
    expect(existsSync(kept!)).toBe(false);
    expect(existsSync(`${m.root}.before-update`)).toBe(false);
  }, 30_000);

  test('model files are not copied and stay with the live root', () => {
    const m = machine();
    mkdirSync(join(m.root, 'models'), { recursive: true });
    writeFileSync(join(m.root, 'models', 'weights.bin'), 'w');
    m.update();
    expect(existsSync(join(`${m.root}.before-update`, 'models'))).toBe(false);
    m.putBack();
    expect(readFileSync(join(m.root, 'models', 'weights.bin'), 'utf8')).toBe('w');
  }, 30_000);

  test('a disk without room for the copy stops the update before anything changed', () => {
    const m = machine();
    writeFileSync(join(m.root, 'registry.json'), '{}');
    expect(() => copyEngineStores(m.env, { log: () => {}, deps: { clones: () => false, freeBytes: () => 0 } })).toThrow(/needs .* free/);
    expect(existsSync(`${m.root}.before-update`)).toBe(false);
    expect(existsSync(`${m.root}.update.json`)).toBe(false);
  }, 30_000);

  test('a process that still has a store open stops the update, named', () => {
    const m = machine();
    const store = join(m.root, 'sources', 'gmail.email', '1', 'stores', 'internal.sqlite');
    mkdirSync(join(store, '..'), { recursive: true });
    m.oldOpens(store);
    // A straggler of the old version, which knows no lock: it holds the store open.
    const straggler = spawn('sh', ['-c', `exec 3<"${store}"; sleep 60`], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !processesHoldStore(store)) Bun.sleepSync(50);
      expect(() => m.update()).toThrow(/still has Olympus data open/);
      expect(existsSync(`${m.root}.before-update`)).toBe(false);
    } finally {
      straggler.kill('SIGKILL');
    }
  }, 30_000);
});

function processesHoldStore(store: string): boolean {
  const held = processesWithFilesUnder([realpathSync(join(store, '..'))]);
  return Array.isArray(held) && held.length > 0;
}

describe('an update cut short', () => {
  test('a put-back cut short between its renames is finished by the next update, and nothing is lost', () => {
    const m = machine();
    writeFileSync(join(m.root, 'registry.json'), '"before"');
    m.update();
    // The put-back renamed the failed root aside, then stopped.
    renameSync(m.root, `${m.root}.failed-update-1`);
    m.update();
    expect(readFileSync(join(m.root, 'registry.json'), 'utf8')).toBe('"before"');
  }, 30_000);

  test('a copy nothing put back or removed is kept, not deleted, when the next update starts', () => {
    const m = machine();
    writeFileSync(join(m.root, 'registry.json'), '"first"');
    m.update();
    writeFileSync(join(m.root, 'registry.json'), '"used since"');
    m.update();
    const kept = readdirSync(join(m.root, '..')).filter((name) => name.startsWith('olympus.failed-update-'));
    expect(kept.length).toBe(1);
    expect(readFileSync(join(m.root, '..', kept[0]!, 'registry.json'), 'utf8')).toBe('"first"');
    m.putBack();
    expect(readFileSync(join(m.root, 'registry.json'), 'utf8')).toBe('"used since"');
  }, 30_000);
});
