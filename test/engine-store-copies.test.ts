// #1639: `olympus engine install` replacing a running version copies the
// stores first, puts them back when the new one does not prove healthy, and
// removes the copies when it does, the way `olympus worker upgrade` does.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerUpgradeInFlight } from '../src/core/boot-progress.ts';
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
