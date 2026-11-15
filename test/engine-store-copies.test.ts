// #1639: `olympus engine install` replacing a running version copies the
// stores first, puts them back when the new one does not prove healthy, and
// removes the copies when it does, the way `olympus worker upgrade` does.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedUpdateSetAsidePath, workerUpgradeInFlight } from '../src/core/boot-progress.ts';
import { commitEngineStores, copyEngineStores, restoreEngineStores } from '../src/core/engine-store-copies.ts';
import { olympusDataRoot, sharedDataPath } from '../src/core/olympus-layout.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'olympus-engine-store-copies-'));
  roots.push(home);
  const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') };
  mkdirSync(olympusDataRoot(env), { recursive: true });
  const store = join(olympusDataRoot(env), 'ledger.sqlite');
  const db = new Database(store, { create: true });
  db.exec("CREATE TABLE kept (body TEXT); INSERT INTO kept VALUES ('old')");
  db.close();
  const body = () => { const read = new Database(store, { readonly: true }); try { return (read.query('SELECT body FROM kept').get() as { body: string }).body; } finally { read.close(); } };
  const update = () => { const write = new Database(store); write.exec("UPDATE kept SET body = 'new'"); write.close(); };
  return { env, store, body, update };
}

describe('the store copies an engine install takes', () => {
  test('a failed new version: the stores go back as they were, and the mark goes', () => {
    const { env, store, body, update } = setup();
    copyEngineStores(env, { bunBin: process.execPath });
    expect(workerUpgradeInFlight(env)).toBe(true);
    expect(existsSync(`${store}.pre-schema-upgrade.bak`)).toBe(true);
    update();
    expect(restoreEngineStores(env)).toEqual(['ledger.sqlite']);
    expect(body()).toBe('old');
    expect(workerUpgradeInFlight(env)).toBe(false);
  }, 30_000);

  test('a failed new version: the stores and ledgers it made are set aside intact, and nothing that was there before is touched (run 43751182260)', () => {
    const { env, body, update } = setup();
    const root = olympusDataRoot(env);
    const ledger = join(root, 'classification-ledger.jsonl');
    writeFileSync(ledger, '{"kept":1}\n');
    copyEngineStores(env, { bunBin: process.execPath });
    update();
    // A file that was there before the mark, written by the new version, keeps its place and its bytes.
    writeFileSync(ledger, '{"kept":1}\n{"later":2}\n');
    const made = join(root, 'sources', 'archive.imports', '1', 'stores', 'email.secure_local.sqlite');
    mkdirSync(join(made, '..'), { recursive: true });
    const db = new Database(made, { create: true });
    db.exec("CREATE TABLE imported (body TEXT); INSERT INTO imported VALUES ('mail')");
    db.close();
    writeFileSync(`${made}-wal`, 'wal bytes');
    const madeBytes = readFileSync(made);
    writeFileSync(join(root, 'embedding-ledger.jsonl'), '{}\n');
    expect(restoreEngineStores(env)).toEqual([
      'ledger.sqlite',
      'embedding-ledger.jsonl (made by the update, set aside)',
      'sources/archive.imports/1/stores/email.secure_local.sqlite (made by the update, set aside)',
    ]);
    expect(body()).toBe('old');
    expect(existsSync(made) || existsSync(`${made}-wal`) || existsSync(join(root, 'embedding-ledger.jsonl'))).toBe(false);
    expect(readFileSync(failedUpdateSetAsidePath(made)).equals(madeBytes)).toBe(true);
    expect(readFileSync(`${failedUpdateSetAsidePath(made)}-wal`, 'utf8')).toBe('wal bytes');
    expect(readFileSync(ledger, 'utf8')).toBe('{"kept":1}\n{"later":2}\n');
    // The next upgrade neither copies nor puts back what was set aside, and its commit clears it with the copies.
    copyEngineStores(env, { bunBin: process.execPath });
    expect(restoreEngineStores(env)).toEqual(['ledger.sqlite']);
    expect(existsSync(made)).toBe(false);
    copyEngineStores(env, { bunBin: process.execPath });
    commitEngineStores(env);
    expect(existsSync(failedUpdateSetAsidePath(made)) || existsSync(`${failedUpdateSetAsidePath(made)}-wal`)).toBe(false);
  }, 30_000);

  test('a healthy new version: its changes stay, and the copies and the mark go', () => {
    const { env, store, body, update } = setup();
    copyEngineStores(env, { bunBin: process.execPath });
    update();
    commitEngineStores(env);
    expect(body()).toBe('new');
    expect(existsSync(`${store}.pre-schema-upgrade.bak`)).toBe(false);
    expect(workerUpgradeInFlight(env)).toBe(false);
  }, 30_000);

  test('with no install in flight, or a mark that cannot be read, nothing is put back', () => {
    const { env, store, body, update } = setup();
    expect(restoreEngineStores(env)).toEqual([]);
    copyEngineStores(env, { bunBin: process.execPath });
    update();
    writeFileSync(sharedDataPath('upgrade-in-flight', env), '{');
    expect(restoreEngineStores(env)).toEqual([]);
    expect(body()).toBe('new');
    expect(existsSync(`${store}.pre-schema-upgrade.bak`)).toBe(true);
  }, 30_000);
});

describe('the copy and the put-back wait for the stopped engine to let go of its data', () => {
  // Mac forced-failure leg, 15 Nov 2026: launchd reported the new version stopped while it was still shutting down, it
  // opened a store the put-back had just restored and migrated it again, and the restored previous version refused it.
  // The owner (the background or a single engine), and the split's front, which holds only the engine process share.
  for (const [who, take] of [['the data owner', 'holdDataOwnerLock(env)'], ['the split front', "takeWorkerDataOwnerLock(env, { engineRole: 'front' })"]] as const) test(`while ${who} is still alive, nothing is put back and the refusal says so`, () => {
    const { env, body, update } = setup();
    copyEngineStores(env, { bunBin: process.execPath });
    update();
    const owner = Bun.spawn([process.execPath, '-e', `
      const { holdDataOwnerLock, takeWorkerDataOwnerLock } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'data-owner-lock.ts'))});
      const env = ${JSON.stringify(env)};
      ${take};
      console.log('held');
      await new Promise(() => {});
    `], { stdout: 'pipe' });
    try {
      const reader = owner.stdout.getReader();
      return reader.read().then(() => {
        expect(() => restoreEngineStores(env, { ownerWaitMs: 200 })).toThrow('an Olympus process still owns its data');
        expect(body()).toBe('new');
        expect(workerUpgradeInFlight(env)).toBe(true);
        owner.kill('SIGKILL');
        return owner.exited;
      }).then(() => {
        // Once it has exited, the put-back goes ahead.
        expect(restoreEngineStores(env, { ownerWaitMs: 5_000 })).toEqual(['ledger.sqlite']);
        expect(body()).toBe('old');
      });
    } catch (error) {
      owner.kill('SIGKILL');
      throw error;
    }
  }, 30_000);
});
