// #1639: `olympus engine install` replacing a running version sets the data
// root aside first, puts it back when the new one does not prove healthy, and
// removes the copy when it does, the way `olympus worker upgrade` does.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateInFlightSince, updateRecordPath } from '../src/core/data-root-snapshot.ts';
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

describe('the copy of the data an engine install takes', () => {
  test('a failed new version: the data goes back as it was, and the record of the update says only what was kept', () => {
    const { env, body, update } = setup();
    copyEngineStores(env);
    expect(updateInFlightSince(env)).toBeDefined();
    expect(existsSync(`${olympusDataRoot(env)}.before-update`)).toBe(true);
    update();
    expect(restoreEngineStores(env, { log: () => {} })[0]).toBe('The Olympus data was put back as it was before the update.');
    expect(body()).toBe('old');
    expect(updateInFlightSince(env)).toBeUndefined();
  }, 30_000);

  test('a second failure keeps its own failed root beside the first, and the next committed update removes both', () => {
    const { env, update } = setup();
    const root = olympusDataRoot(env);
    copyEngineStores(env);
    update();
    restoreEngineStores(env, { log: () => {} });
    copyEngineStores(env);
    update();
    restoreEngineStores(env, { log: () => {} });
    const failed = readdirSync(join(root, '..')).filter((name) => name.startsWith('olympus.failed-update-'));
    expect(failed.length).toBe(2);
    copyEngineStores(env);
    expect(commitEngineStores(env).length).toBe(2);
    expect(readdirSync(join(root, '..')).filter((name) => name.startsWith('olympus.'))).toEqual([]);
  }, 30_000);

  test('a healthy new version: its changes stay, and the copy goes', () => {
    const { env, body, update } = setup();
    copyEngineStores(env);
    update();
    commitEngineStores(env);
    expect(body()).toBe('new');
    expect(existsSync(`${olympusDataRoot(env)}.before-update`)).toBe(false);
    expect(updateInFlightSince(env)).toBeUndefined();
  }, 30_000);

  test('a store copy a build from before the whole-root copy left is removed at the next commit', () => {
    const { env, store } = setup();
    writeFileSync(`${store}.pre-schema-upgrade.bak`, 'old copy');
    writeFileSync(sharedDataPath('schema-backups', env), `${JSON.stringify({ storeId: 'ledger', dbPath: store, backupPath: `${store}.pre-schema-upgrade.bak` })}\n`);
    copyEngineStores(env);
    commitEngineStores(env);
    expect(existsSync(`${store}.pre-schema-upgrade.bak`)).toBe(false);
  }, 30_000);

  test('with no install in flight nothing is put back, and a record that cannot be read stops the put-back', () => {
    const { env, body, update } = setup();
    expect(restoreEngineStores(env)).toEqual([]);
    copyEngineStores(env);
    update();
    writeFileSync(updateRecordPath(env), '{');
    expect(() => restoreEngineStores(env)).toThrow(/cannot be read/);
    expect(body()).toBe('new');
  }, 30_000);
});

describe('the copy and the put-back wait for the stopped engine to let go of its data', () => {
  // Mac forced-failure leg, 15 Nov 2026: launchd reported the new version stopped while it was still shutting down, it
  // opened a store the put-back had just restored and migrated it again, and the restored previous version refused it.
  // The owner (the background or a single engine), and the split's front, which holds only the engine process share.
  for (const [who, take] of [['the data owner', 'holdDataOwnerLock(env)'], ['the split front', "takeWorkerDataOwnerLock(env, { engineRole: 'front' })"]] as const) test(`while ${who} is still alive, nothing is put back and the refusal says so`, () => {
    const { env, body, update } = setup();
    copyEngineStores(env);
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
        expect(updateInFlightSince(env)).toBeDefined();
        owner.kill('SIGKILL');
        return owner.exited;
      }).then(() => {
        // Once it has exited, the put-back goes ahead.
        expect(restoreEngineStores(env, { ownerWaitMs: 5_000, log: () => {} })[0]).toContain('put back');
        expect(body()).toBe('old');
      });
    } catch (error) {
      owner.kill('SIGKILL');
      throw error;
    }
  }, 30_000);
});
