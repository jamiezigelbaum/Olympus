// A tiered store set is found by its ledger's identity, not by the path the
// ledger had (docs/design/source-storage.md, "Migration of existing installs").
//
// The fixture is a set as main wrote it at 2b58a8ef, before account folders:
// three tier stores and the set ledger in one flat folder, each store's
// binding row recording the ledger's id and the absolute path it then had
// (fixtures/tier-set-legacy/make-fixture.ts). The migration renames the files
// into `<data>/sources/<source>/<slot>/stores/` with other names and rewrites
// nothing inside them, so a store must find its ledger by id from where it
// now sits, and must still refuse any other ledger.
//
// A store left by a clean close keeps an empty -wal file on macOS (and the
// migration renames it with the store); a read-only connection cannot open a
// WAL database without one, so the fixture gets them back.

import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'bun:test';
import { accountStorePath, type LayoutEnv } from '../src/core/olympus-layout.ts';
import { openConnectorStore } from '../src/core/source-storage.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { locateTierItem } from '../src/workers/classification/tier-cli.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { TierLedgerUnavailableError, type LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { FIXTURE_PLACEMENT, CORPORA, fixtureConnector, identityOf, type FixtureSpec } from './helpers/tier-fixtures.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'tier-set-legacy');
const LEGACY_DATA_DIR = '/olympus-legacy-data';
/** The set ledger's id in the fixture, minted by main's code. */
const SET_LEDGER_ID = 'dbf3f830b65993afad6c44ebd83d83da';
type Tier = 'internal' | 'public_safe' | 'secure_local';
const TIERS: readonly Tier[] = ['internal', 'public_safe', 'secure_local'];
const ACCOUNT = { source_id: 'dropbox.files', slot: '1', layout: 'folder' } as const;
const SOURCE = { sourceId: 'dropbox.files' };

/** The fixture's own file names, which the migration replaces. */
const LEGACY_STORE: Record<Tier, string> = {
  internal: 'fixture-internal-store.sqlite',
  public_safe: 'fixture-public-store.sqlite',
  secure_local: 'fixture-secure-store.sqlite',
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface World {
  root: string;
  env: LayoutEnv;
  /** The flat folder the set was written in. */
  legacy: string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'olympus-tier-set-rename-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, 'legacy-data');
  mkdirSync(legacy, { recursive: true });
  for (const file of readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.gz'))) {
    const path = join(legacy, file.slice(0, -'.gz'.length));
    writeFileSync(path, gunzipSync(readFileSync(join(FIXTURE_DIR, file))));
    writeFileSync(`${path}-wal`, '');
  }
  return { root, env: { HOME: root }, legacy };
}

const legacyPath = (w: World, tier: Tier): string => join(w.legacy, LEGACY_STORE[tier]);
const folderPath = (w: World, tier: Tier): string => accountStorePath(ACCOUNT, tier, w.env);

/** Each store's binding row, rewritten to name where the ledger sits in the flat folder now (the fixture names a path of the machine that wrote it). */
function recordLedgerPathAsWritten(w: World): void {
  for (const tier of TIERS) {
    const db = new Database(legacyPath(w, tier));
    try {
      const row = db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string };
      const binding = JSON.parse(row.cursor) as { ledgerId: string; ledgerPath: string };
      binding.ledgerPath = join(w.legacy, binding.ledgerPath.slice(LEGACY_DATA_DIR.length + 1));
      db.query(`UPDATE sync_runs SET cursor = ? WHERE connector_id = 'tiered_store_set_binding'`).run(JSON.stringify(binding));
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      db.close();
    }
  }
  for (const name of readdirSync(w.legacy)) if (name.endsWith('-shm')) rmSync(join(w.legacy, name));
  for (const name of readdirSync(w.legacy)) if (name.endsWith('-wal')) writeFileSync(join(w.legacy, name), '');
}

function renameWithWal(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  for (const [source, target] of [[from, to], [`${from}-wal`, `${to}-wal`]] as const) {
    if (existsSync(source)) renameSync(source, target);
  }
}

/** One store of the set into the account folder, with its own ledger sidecar if it has one (the set ledger is the secure store's). */
function moveStoreIntoAccountFolder(w: World, tier: Tier): void {
  renameWithWal(legacyPath(w, tier), folderPath(w, tier));
  renameWithWal(tierLedgerPathForStore(legacyPath(w, tier)), tierLedgerPathForStore(folderPath(w, tier)));
}

/** What the migration does to the set: every file and its -wal renamed into the account folder, nothing opened. */
function renameIntoAccountFolder(w: World): void {
  for (const tier of TIERS) moveStoreIntoAccountFolder(w, tier);
}

interface FileState {
  size: number;
  mtimeMs: number;
  sha256: string;
}

function fileStates(dir: string): Record<string, FileState> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return [name, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') }];
  }));
}

/** The files of the stores themselves (not the ledgers beside them) and their -wal, as they stand. */
function storeFiles(states: Record<string, FileState>): Record<string, FileState> {
  return Object.fromEntries(Object.entries(states).filter(([name]) => !name.includes('tier-ledger') && !name.endsWith('-shm')));
}

const SEARCHES = ['harbour', 'compost', 'ferry', 'vault', 'notice', 'rota'] as const;

function openReadOnly(path: string, tier: Tier, env: LayoutEnv): LocalConnectorStore {
  return openConnectorStore(SOURCE, { dbPath: path, corpusId: CORPORA[tier]!, family: 'file', trustDomain: tier, readOnly: true }, env);
}

/** What each store serves, through read-only handles: the part of the set a reader sees. */
function observe(paths: Record<Tier, string>, env: LayoutEnv): Record<string, unknown> {
  const seen: Record<string, unknown> = {};
  for (const tier of TIERS) {
    const store = openReadOnly(paths[tier], tier, env);
    try {
      seen[tier] = {
        found: Object.fromEntries(SEARCHES.map((word) => [word, store.searchItems(word, 10).map((row) => row.sourceItem.localItemId).sort()])),
        counts: store.status().counts,
      };
    } finally {
      store.close();
    }
  }
  return seen;
}

/** What searching the fixture must show: the garden notes raised to Private are served only there. */
const EXPECTED = {
  internal: {
    found: { harbour: ['personal:ferry', 'personal:rota'], compost: [], ferry: ['personal:ferry'], vault: [], notice: [], rota: ['personal:rota'] },
    counts: { items: 2, chunks: 2 },
  },
  public_safe: {
    found: { harbour: ['personal:notice'], compost: [], ferry: [], vault: [], notice: ['personal:notice'], rota: [] },
    counts: { items: 1, chunks: 1 },
  },
  secure_local: {
    found: { harbour: ['personal:vault'], compost: ['personal:garden'], ferry: [], vault: ['personal:vault'], notice: [], rota: [] },
    counts: { items: 2, chunks: 2 },
  },
};

function expectServed(seen: Record<string, unknown>): void {
  expect(seen).toMatchObject(EXPECTED);
}

function legacyPaths(w: World): Record<Tier, string> {
  return { internal: legacyPath(w, 'internal'), public_safe: legacyPath(w, 'public_safe'), secure_local: legacyPath(w, 'secure_local') };
}

function folderPaths(w: World): Record<Tier, string> {
  return { internal: folderPath(w, 'internal'), public_safe: folderPath(w, 'public_safe'), secure_local: folderPath(w, 'secure_local') };
}

function bindingOf(path: string): { ledgerId: string; ledgerPath: string } {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string };
    return JSON.parse(row.cursor) as { ledgerId: string; ledgerPath: string };
  } finally {
    db.close();
  }
}

/** The tiers the set ledger holds for the fixture's items, and where each copy stands. */
function ledgerState(ledgerPath: string): unknown {
  const ledger = new TierLedger({ dbPath: ledgerPath });
  try {
    return ['garden', 'rota', 'notice'].map((id) => {
      const identity = identityOf(id);
      const current = ledger.getCurrent(identity)!;
      return {
        id,
        metadata: current.metadataTier,
        content: current.contentTier,
        state: current.state,
        copies: ledger.copies(identity).map((copy) => [copy.corpusId, copy.state]),
      };
    });
  } finally {
    ledger.close();
  }
}

describe('a set written the old way (recorded ledger path), before and after a rename', () => {
  test('the fixture is the old form: id and an absolute path', () => {
    const w = world();
    for (const tier of TIERS) {
      expect(bindingOf(legacyPath(w, tier))).toEqual({
        ledgerId: SET_LEDGER_ID,
        ledgerPath: `${LEGACY_DATA_DIR}/fixture-secure-store.tier-ledger.sqlite`,
      });
    }
  });

  test('where it was written, the recorded path still finds the ledger', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    expectServed(observe(legacyPaths(w), w.env));
  });

  test('renamed into the account folder with nothing opened in between: the same ledger, tiers and results, and no store written', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    const before = observe(legacyPaths(w), w.env);
    const ledgerBefore = ledgerState(join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite'));

    renameIntoAccountFolder(w);
    const dir = dirname(folderPath(w, 'internal'));
    const filesBefore = fileStates(dir);
    // The rows still name the old place, which is gone.
    expect(bindingOf(folderPath(w, 'internal')).ledgerPath).toBe(join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite'));
    expect(existsSync(bindingOf(folderPath(w, 'internal')).ledgerPath)).toBe(false);

    const after = observe(folderPaths(w), w.env);
    expect(after).toEqual(before);
    expectServed(after);
    expect(ledgerState(tierLedgerPathForStore(folderPath(w, 'secure_local')))).toEqual(ledgerBefore);
    expect(TierLedger.readLedgerId(tierLedgerPathForStore(folderPath(w, 'secure_local')))).toBe(SET_LEDGER_ID);

    // Nothing was written to any store: bytes, size and mtime as they were, and every -wal still empty.
    const stores = storeFiles(fileStates(dir));
    expect(stores).toEqual(storeFiles(filesBefore));
    expect(Object.keys(stores).filter((name) => name.endsWith('-wal')).map((name) => stores[name]!.size)).toEqual([0, 0, 0]);
  });

  test('a renamed store opened for writing and only read leaves its file as it was; its -wal stays empty', () => {
    const w = world();
    renameIntoAccountFolder(w);
    const dir = dirname(folderPath(w, 'internal'));
    const before = storeFiles(fileStates(dir));
    const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(folderPath(w, 'secure_local')) });
    const stores = TIERS.map((tier) => openConnectorStore(
      SOURCE,
      { dbPath: folderPath(w, tier), corpusId: CORPORA[tier]!, family: 'file', trustDomain: tier, ...(tier === 'secure_local' ? { tierLedger: ledger } : {}) },
      w.env,
    ));
    try {
      for (const store of stores) expect(store.searchItems('harbour', 5).length).toBeGreaterThan(0);
      expect(stores[0]!.searchItems('compost', 5)).toEqual([]);
    } finally {
      for (const store of stores) store.close();
      ledger.close();
    }
    const after = storeFiles(fileStates(dir));
    const mainFiles = (states: Record<string, FileState>) => Object.fromEntries(Object.entries(states).filter(([name]) => name.endsWith('.sqlite')));
    expect(mainFiles(after)).toEqual(mainFiles(before));
    expect(Object.entries(after).filter(([name]) => name.endsWith('-wal')).map(([, state]) => state.size)).toEqual([0, 0, 0]);
  });

  test('the same set opened for normal work after the rename syncs through, and its binding rows are not rewritten', async () => {
    const w = world();
    renameIntoAccountFolder(w);
    const paths = folderPaths(w);
    const rowsBefore = TIERS.map((tier) => bindingOf(paths[tier]));
    // As a lane opens it: the ledger beside the secure store, handed to every store.
    const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
    const open = (tier: Tier): LocalConnectorStore => openConnectorStore(
      SOURCE,
      { dbPath: paths[tier], corpusId: CORPORA[tier]!, family: 'file', trustDomain: tier, tierLedger: ledger },
      w.env,
    );
    const stores = { internal: open('internal'), secure_local: open('secure_local'), public_safe: open('public_safe') };
    cleanups.unshift(() => { for (const store of Object.values(stores)) store.close(); ledger.close(); });
    const set = new TieredStoreSet({
      setId: 'fixture.personal',
      ledger,
      legs: TIERS.map((trustDomain) => ({ trustDomain, corpusId: CORPORA[trustDomain]!, store: stores[trustDomain], legacy: true })),
    });

    expect(ledger.ledgerId()).toBe(SET_LEDGER_ID);
    expect(stores.internal.searchItems('compost', 5)).toEqual([]);
    expect(stores.secure_local.searchItems('compost', 5).map((row) => row.sourceItem.localItemId)).toEqual(['personal:garden']);
    const extra: FixtureSpec = { id: 'tide', name: 'tide-table.txt', text: 'Tide table for the harbour pilots.' };
    const specs: FixtureSpec[] = [
      { id: 'rota', name: 'harbour-rota.txt', text: 'Harbour cleaning rota for the volunteers.' },
      extra,
    ];
    const run = await set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(run.routing.itemsSecrets).toBe(0);
    expect(stores.internal.searchItems('pilots', 5).map((row) => row.sourceItem.localItemId)).toEqual(['personal:tide']);
    // Syncing never rewrote the recorded path.
    expect(TIERS.map((tier) => bindingOf(paths[tier]))).toEqual(rowsBefore);
  });

  test('a set moved as a whole to another flat folder (the recorded path is gone) is found by the recorded name beside the store', () => {
    const w = world();
    const moved = join(w.root, 'restored-data');
    renameSync(w.legacy, moved);
    const paths = Object.fromEntries(TIERS.map((tier) => [tier, join(moved, LEGACY_STORE[tier])])) as Record<Tier, string>;
    expectServed(observe(paths, w.env));
  });

  test('the account folder, then back out to the flat folder: the recorded path serves again', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    renameIntoAccountFolder(w);
    expectServed(observe(folderPaths(w), w.env));
    // The migration's rollback puts the files back where they were.
    for (const tier of TIERS) {
      renameWithWal(folderPath(w, tier), legacyPath(w, tier));
      renameWithWal(tierLedgerPathForStore(folderPath(w, tier)), tierLedgerPathForStore(legacyPath(w, tier)));
    }
    expectServed(observe(legacyPaths(w), w.env));
  });
});

describe('while the rename is half done (the migration resumes, or puts the files back)', () => {
  function servedBy(path: string, tier: Tier, env: LayoutEnv): { served: boolean; ledger: string | undefined } {
    const store = openReadOnly(path, tier, env);
    try {
      let served = true;
      try {
        store.status();
      } catch (error) {
        if (!(error instanceof TierLedgerUnavailableError)) throw error;
        served = false;
      }
      return { served, ledger: store.tierSetLedgerPath() };
    } finally {
      store.close();
    }
  }

  test('stores in the folder with the ledger still in the flat folder find it by the recorded path', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    const ledger = join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite');
    moveStoreIntoAccountFolder(w, 'internal');
    moveStoreIntoAccountFolder(w, 'public_safe');
    // The secure store's own sidecar IS the set ledger, so it stays until the end.
    renameWithWal(legacyPath(w, 'secure_local'), folderPath(w, 'secure_local'));
    for (const tier of TIERS) expect(servedBy(folderPath(w, tier), tier, w.env)).toEqual({ served: true, ledger });
  });

  test('once the ledger has moved, stores in the folder find it there; a store still in the flat folder is refused until its turn', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    const folderLedger = tierLedgerPathForStore(folderPath(w, 'secure_local'));
    moveStoreIntoAccountFolder(w, 'internal');
    moveStoreIntoAccountFolder(w, 'secure_local');
    expect(servedBy(folderPath(w, 'internal'), 'internal', w.env)).toEqual({ served: true, ledger: folderLedger });
    expect(servedBy(folderPath(w, 'secure_local'), 'secure_local', w.env)).toEqual({ served: true, ledger: folderLedger });
    // Fails closed: its ledger is neither where it was nor in a folder it can see.
    expect(servedBy(legacyPath(w, 'public_safe'), 'public_safe', w.env)).toEqual({ served: false, ledger: undefined });
    moveStoreIntoAccountFolder(w, 'public_safe');
    expectServed(observe(folderPaths(w), w.env));
  });
});

describe('a store never takes a ledger that is not the one it is bound to', () => {
  function replaceWithOtherLedger(path: string): string {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const other = new TierLedger({ dbPath: path });
    const id = other.ledgerId();
    other.close();
    return id;
  }

  function refused(path: string, tier: Tier, env: LayoutEnv): void {
    const store = openReadOnly(path, tier, env);
    try {
      expect(store.searchItems('harbour', 5)).toEqual([]);
      expect(() => store.status()).toThrow(TierLedgerUnavailableError);
      expect(store.tierSetLedgerPath()).toBeUndefined();
    } finally {
      store.close();
    }
  }

  test('another ledger at the recorded path is refused', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    const recorded = join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite');
    expect(replaceWithOtherLedger(recorded)).not.toBe(SET_LEDGER_ID);
    for (const tier of TIERS) refused(legacyPath(w, tier), tier, w.env);
  });

  test('another ledger where the folder keeps the set ledger is refused', () => {
    const w = world();
    renameIntoAccountFolder(w);
    expect(replaceWithOtherLedger(tierLedgerPathForStore(folderPath(w, 'secure_local')))).not.toBe(SET_LEDGER_ID);
    for (const tier of TIERS) refused(folderPath(w, tier), tier, w.env);
  });

  test('no ledger anywhere is refused, and so is the store\'s own ledger, which is a different one', () => {
    const w = world();
    renameIntoAccountFolder(w);
    rmSync(tierLedgerPathForStore(folderPath(w, 'secure_local')));
    rmSync(`${tierLedgerPathForStore(folderPath(w, 'secure_local'))}-wal`, { force: true });
    // The internal store has a ledger of its own beside it, with another id.
    expect(existsSync(tierLedgerPathForStore(folderPath(w, 'internal')))).toBe(true);
    for (const tier of TIERS) refused(folderPath(w, tier), tier, w.env);
  });

  test('no ledger at the recorded path or beside the store is refused, as before', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    rmSync(join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite'));
    rmSync(join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite-wal'), { force: true });
    for (const tier of TIERS) refused(legacyPath(w, tier), tier, w.env);
  });

  test('another ledger left at the old recorded path does not hide the right one that moved', () => {
    const w = world();
    recordLedgerPathAsWritten(w);
    const recorded = join(w.legacy, 'fixture-secure-store.tier-ledger.sqlite');
    renameIntoAccountFolder(w);
    // The old place is taken by some other set's ledger.
    const other = new TierLedger({ dbPath: recorded });
    expect(other.ledgerId()).not.toBe(SET_LEDGER_ID);
    other.close();
    const seen = observe(folderPaths(w), w.env);
    expectServed(seen);
    const store = openReadOnly(folderPath(w, 'internal'), 'internal', w.env);
    try {
      expect(store.tierSetLedgerPath()).toBe(tierLedgerPathForStore(folderPath(w, 'secure_local')));
    } finally {
      store.close();
    }
  });
});

describe('the readers that look for a bound ledger by path', () => {
  test('the tier command finds the set ledger from one renamed store, not at the recorded place', () => {
    const w = world();
    renameIntoAccountFolder(w);
    const located = locateTierItem('garden', { storePaths: [folderPath(w, 'internal')] });
    expect(located.map((item) => item.ledgerPath)).toEqual([tierLedgerPathForStore(folderPath(w, 'secure_local'))]);
    expect(existsSync(LEGACY_DATA_DIR)).toBe(false);
  });

  test('the sniffer pass reads the set ledger of a renamed store, even when it is the only store it knows', () => {
    const w = world();
    renameIntoAccountFolder(w);
    const internal = openReadOnly(folderPath(w, 'internal'), 'internal', w.env);
    try {
      const service = new TierSnifferService({ stores: () => [internal] } as never);
      const ledgers = (service as unknown as { ledgerPaths(): string[] }).ledgerPaths();
      expect(ledgers).toContain(tierLedgerPathForStore(folderPath(w, 'secure_local')));
      expect(ledgers).toContain(tierLedgerPathForStore(folderPath(w, 'internal')));
    } finally {
      internal.close();
    }
  });
});
