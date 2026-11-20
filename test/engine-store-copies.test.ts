// #1639: `olympus engine install` replacing a running version sets the data
// root aside first, puts it back when the new one does not prove healthy, and
// removes the copy when it does, the way `olympus worker upgrade` does.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateInFlightSince, updateRecordPath } from '../src/core/data-root-snapshot.ts';
import { commitEngineStores, copyEngineStores, restoreEngineStores } from '../src/core/engine-store-copies.ts';
import { olympusDataRoot, sharedDataPath } from '../src/core/olympus-layout.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { storeFileSchemaVersion } from '../src/core/source-storage.ts';
import { classifyItemTiers, contentDigestReason, ownerOverrideSecretReview } from '../src/workers/classification/tier-classifier.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { TIER_LEDGER_SQLITE_STORE_ID, TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { TIER_SNIFFER_SQLITE_STORE_ID, tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID } from '../src/workers/google-connectors/drive.ts';
import { JUDGED_PERSONAL_SNIFFER, fixtureConnector, fixtureItem } from './helpers/tier-fixtures.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  // Real path: a schema backup is removed only where its folder has no symlink in its path, and a Mac's temp folder does.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-engine-store-copies-')));
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
  test('put-back resumes after the Private store of a mounted Personal store is configured', async () => {
    const { env } = setup();
    const storeEnv: Record<string, string> = { ...env };
    const row = { id: 'mounted', name: 'Packing list', text: 'Bring the lunch under the mountingorchardmarker.' };
    const identity = fixtureItem(row).identity;
    const personal = {
      corpusId: 'internal.example.lane', trustDomain: 'internal' as const,
      dbPath: join(olympusDataRoot(env), 'personal.sqlite'), family: 'file' as const,
    };
    const secure = {
      corpusId: 'secure_local.example.lane', trustDomain: 'secure_local' as const,
      dbPath: join(olympusDataRoot(env), 'private.sqlite'), family: 'file' as const,
    };
    storeEnv.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON = JSON.stringify([personal]);
    const seed = new LocalConnectorStore(personal);
    try {
      await seed.syncFromConnector(fixtureConnector(() => [row]), { fetchContent: true });
    } finally {
      seed.close();
    }
    copyEngineStores(storeEnv, { log: () => {}, deps: { clones: () => false } });
    expect(() => restoreEngineStores(storeEnv, { log: () => {} })).toThrow(/No Private store is configured/);
    expect(updateInFlightSince(storeEnv)).toBeDefined();
    storeEnv.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON = JSON.stringify([personal, secure]);
    restoreEngineStores(storeEnv, { log: () => {} });
    expect(updateInFlightSince(storeEnv)).toBeUndefined();
    const checked = new LocalConnectorStore(personal);
    const held = new LocalConnectorStore(secure);
    try {
      expect(checked.searchItems('mountingorchardmarker', 10)).toEqual([]);
      expect(held.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(row.text);
      expect(held.tierLedger()?.copies(identity)).toContainEqual(expect.objectContaining({
        trustDomain: 'secure_local', state: 'current', embedHold: true,
      }));
    } finally {
      checked.close();
      held.close();
    }
  });

  test.each([16, 15])('restored Personal bodies without a matching verdict are held before search resumes (store schema %i)', async (schema) => {
    const { env } = setup();
    const paths = {
      internal: resolvedStorePath('google_drive.docs', 'internal', env),
      secure: resolvedStorePath('google_drive.docs', 'secure_local', env),
    };
    const openPersonal = (tierLedger: TierLedger) => new LocalConnectorStore({ dbPath: paths.internal, corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      trustDomain: 'internal', family: 'file', restoreSchemaVersion: schema, tierLedger });
    const openPrivate = (tierLedger: TierLedger) => new LocalConnectorStore({ dbPath: paths.secure, corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
      trustDomain: 'secure_local', family: 'file', restoreSchemaVersion: schema, tierLedger });
    const receipts = tieredStoreSetLedgerPath(paths.secure);
    const rows = [
      { id: 'legacy', name: 'Picnic list', text: 'Pack the yellow blanket and napkins under the legacyorchardmarker.' },
      { id: 'edited', name: 'Updated picnic list', text: 'Pack the blue cooler and apples under the updatedorchardmarker.' },
      { id: 'judged', name: 'Checked picnic list', text: 'Pack the sandwiches and water under the judgedorchardmarker.' },
      { id: 'secret', name: 'Unsuitable picnic list', text: 'This old copy was marked Secrets under the secretorchardmarker.' },
      { id: 'owner-edit', name: 'Owner picnic list', text: 'Review the picnic key ' + '-----BEGIN ' + 'PRIVATE KEY-----' },
    ];
    const ledgerSchema = schema === 15 ? 12 : 18;
    const openLedger = () => new TierLedger({ dbPath: receipts, restoreSchemaVersion: ledgerSchema });
    const ledger = openLedger();
    const personal = openPersonal(ledger);
    try {
      if (schema === 16) {
        const privateNames = openPrivate(ledger);
        try {
          const { id, name } = rows[1]!;
          await privateNames.syncFromConnector(fixtureConnector(() => [{ id, name }]), { fetchContent: true });
        } finally {
          privateNames.close();
        }
      }
      const connector = fixtureConnector(() => rows);
      await personal.syncFromConnector(connector, { fetchContent: true });
      for (const row of rows.slice(1)) {
        const item = fixtureItem(row);
        const text = row.id === 'edited' || row.id === 'owner-edit' ? 'An earlier copy of the picnic list.' : row.text;
        const override = row.id === 'owner-edit' ? { kind: 'tier', tier: 'private' } as const : undefined;
        if (override) ledger.setOverride(item.identity, override);
        const decision = classifyItemTiers({ signals: connector.classificationSignals(item), text },
          row.id === 'secret' ? { override: { kind: 'tier', tier: 'secrets' } } : override ? { override } : { sniffer: JUDGED_PERSONAL_SNIFFER });
        ledger.recordDecision(item.identity, decision, { trustDomain: 'internal', trustTier: 'S3' });
      }
      expect(personal.searchItems('legacyorchardmarker', 10)).toHaveLength(1);
      expect(personal.searchItems('updatedorchardmarker', 10)).toHaveLength(1);
      expect(personal.searchItems('judgedorchardmarker', 10)).toHaveLength(1);
    } finally {
      personal.close();
      ledger.close();
    }
    const queuePath = tierSnifferPathForLedger(receipts);
    const queue = new TierSnifferStore({ dbPath: queuePath });
    try {
      queue.enqueue({ subject: fixtureItem(rows[1]!).identity, pass: 'content',
        material: 'An earlier copy of the picnic list.', flags: [], mapRevision: 'none' });
    } finally {
      queue.close();
    }
    const queueSchema = schema === 15 ? 7 : 8;
    if (queueSchema === 7) {
      const oldQueue = new Database(queuePath);
      try {
        oldQueue.exec('DROP TABLE chunk_window_verdicts');
        oldQueue.query('UPDATE schema_version SET version = 7, compatible_version = 7 WHERE store_id = ?').run(TIER_SNIFFER_SQLITE_STORE_ID);
      } finally {
        oldQueue.close();
      }
    }
    copyEngineStores(env, { log: () => {}, deps: { clones: () => false } });
    restoreEngineStores(env, { log: () => {} });
    expect(storeFileSchemaVersion(queuePath, TIER_SNIFFER_SQLITE_STORE_ID)).toBe(queueSchema);
    const restoredQueue = new TierSnifferStore({ dbPath: queuePath, restoreQueue: true });
    try {
      expect(restoredQueue.questionFor(fixtureItem(rows[1]!).identity, 'content')).toBeUndefined();
    } finally {
      restoredQueue.close();
    }
    expect(storeFileSchemaVersion(paths.internal, 'connector-store')).toBe(schema);
    expect(storeFileSchemaVersion(paths.secure, 'connector-store')).toBe(schema);
    expect(storeFileSchemaVersion(receipts, TIER_LEDGER_SQLITE_STORE_ID)).toBe(ledgerSchema);
    const restoredLedger = openLedger();
    const restored = openPersonal(restoredLedger);
    let secure: LocalConnectorStore | undefined;
    try {
      expect(restored.searchItems('legacyorchardmarker', 10)).toEqual([]);
      expect(restored.searchItems('updatedorchardmarker', 10)).toEqual([]);
      expect(restored.searchItems('judgedorchardmarker', 10)).toHaveLength(1);
      expect(restored.searchItems('secretorchardmarker', 10)).toEqual([]);
      expect(restored.exportItemCopy(fixtureItem(rows[3]!).identity)).toBeUndefined();
      secure = openPrivate(restoredLedger);
      const edited = rows[4]!;
      const identity = fixtureItem(edited).identity;
      expect(restoredLedger.getOverride(identity)).toMatchObject({ tier: 'private' });
      expect(ownerOverrideSecretReview(restoredLedger.getCurrent(identity)!.reasons)).toEqual({
        kinds: ['private_key_material'], digest: contentDigestReason(edited.text),
      });
      expect(secure.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(edited.text);
      for (const row of rows.slice(0, 2)) {
        const identity = fixtureItem(row).identity;
        expect(secure.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(row.text);
        expect(secure.tierLedger()?.copies(identity)).toContainEqual(expect.objectContaining({
          trustDomain: 'secure_local', state: 'current', embedHold: true,
        }));
      }
    } finally {
      secure?.close();
      restored.close();
      restoredLedger.close();
    }
  });

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
