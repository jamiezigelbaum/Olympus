import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openEvalDropboxStores } from '../eval/run-real.ts';
import { probeStoreFile } from '../eval/store-probe.ts';
import { TierLedger, TIER_LEDGER_SCHEMA_VERSION, TIER_LEDGER_SQLITE_STORE_ID } from '../src/workers/classification/tier-ledger.ts';
import { findTierSetLedger } from '../src/workers/classification/tier-set-binding.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { workerTierLedgerProblem } from '../src/workers/email-source/server.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, openTierFixture, storePaths, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function version(path: string, set?: number): number {
  const db = new Database(path, set === undefined ? { readonly: true } : { readwrite: true });
  try {
    if (set !== undefined) db.query('UPDATE schema_version SET version = ? WHERE store_id = ?').run(set, TIER_LEDGER_SQLITE_STORE_ID);
    return (db.query('SELECT version FROM schema_version WHERE store_id = ?').get(TIER_LEDGER_SQLITE_STORE_ID) as { version: number }).version;
  } finally { db.close(); }
}
async function world(accountLayout = false) {
  const tmp = tempDir('olympus-copy-isolation-');
  cleanups.push(tmp.cleanup);
  const a = join(tmp.dir, 'A');
  const b = join(tmp.dir, 'B');
  const paths = accountLayout ? {
    public_safe: join(a, 'sources/fixture/1/stores/public_safe.sqlite'),
    internal: join(a, 'sources/fixture/1/stores/internal.sqlite'),
    secure_local: join(a, 'sources/fixture/1/stores/secure_local.sqlite'),
  } : storePaths(a);
  const f = openTierFixture(a, { paths, embed: false });
  try {
    await f.set.sync(fixtureConnector(() => [{ id: 'item', name: 'harbour.txt', text: 'harbour copy isolation' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    for (const store of Object.values(f.stores)) store?.bindTierSet(f.ledger);
  } finally { f.close(); }
  cpSync(a, b, { recursive: true });
  return { a, b, paths, copyPaths: Object.fromEntries(Object.entries(paths).map(([tier, path]) => [tier, path.replace(a, b)])) as typeof paths,
    ledgerA: tieredStoreSetLedgerPath(paths.secure_local), ledgerB: tieredStoreSetLedgerPath(paths.secure_local.replace(a, b)) };
}
function open(path: string, readOnly: boolean) {
  return new LocalConnectorStore({ dbPath: path, corpusId: path.includes('internal') ? CORPORA.internal : CORPORA.secure_local, family: 'file', trustDomain: path.includes('internal') ? 'internal' : 'secure_local', readOnly });
}

describe('tier ledger copy isolation (#1398)', () => {
  for (const accountLayout of [false, true]) for (const readOnly of [true, false]) {
    test(`copy uses its own ledger: account layout=${accountLayout}, readOnly=${readOnly}`, async () => {
      const w = await world(accountLayout);
      version(w.ledgerA, TIER_LEDGER_SCHEMA_VERSION - 1);
      const before = hash(w.ledgerA);
      const store = open(w.copyPaths.internal, readOnly);
      try {
        expect(store.tierSetLedgerPath()).toBe(w.ledgerB);
        expect(store.status()).toBeDefined();
        expect(store.searchItems('harbour', 5).length).toBeGreaterThan(0);
      } finally { store.close(); }
      expect(hash(w.ledgerA)).toBe(before);
      expect(version(w.ledgerA)).toBe(TIER_LEDGER_SCHEMA_VERSION - 1);
      expect(version(w.ledgerB)).toBe(TIER_LEDGER_SCHEMA_VERSION);
    });
  }

  test('a reader refuses an older ledger without migrating or changing either database', async () => {
    const w = await world();
    version(w.ledgerB, TIER_LEDGER_SCHEMA_VERSION - 1);
    const before = [hash(w.ledgerB), hash(w.copyPaths.secure_local)];
    const store = open(w.copyPaths.secure_local, true);
    try {
      expect(() => store.status()).toThrow(/writer must migrate/);
      expect(store.searchItems('harbour', 5)).toEqual([]);
    } finally { store.close(); }
    expect(() => new TierLedger({ dbPath: w.ledgerB, readOnly: true })).toThrow(/writer must migrate/);
    expect([hash(w.ledgerB), hash(w.copyPaths.secure_local)]).toEqual(before);
    expect(version(w.ledgerB)).toBe(TIER_LEDGER_SCHEMA_VERSION - 1);
  });

  test('a bound Personal store\'s former per-leg ledger never holds the front back', async () => {
    const w = await world();
    // An upgraded install keeps the Personal store's old ledger beside it; the set ledger governs the store.
    const former = tieredStoreSetLedgerPath(w.copyPaths.internal);
    new TierLedger({ dbPath: former }).close();
    version(former, TIER_LEDGER_SCHEMA_VERSION - 1);
    expect(findTierSetLedger(w.copyPaths.internal, JSON.parse((new Database(w.copyPaths.internal, { readonly: true }).query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string }).cursor))).toBe(w.ledgerB);
    expect(workerTierLedgerProblem(Object.values(w.copyPaths), true)).toBeUndefined();
    // The set ledger itself still decides.
    version(w.ledgerB, TIER_LEDGER_SCHEMA_VERSION - 1);
    expect(workerTierLedgerProblem(Object.values(w.copyPaths), true)).toMatch(/writer must migrate/);
  });

  test('a downgrade is nonfatal at the worker mount boundary and opens no writable tier data', async () => {
    const w = await world();
    version(w.ledgerB, TIER_LEDGER_SCHEMA_VERSION + 1);
    const before = [hash(w.ledgerB), hash(w.copyPaths.secure_local), hash(w.copyPaths.internal)];
    const message = `This install's privacy ledger was written by a newer Olympus (schema ${TIER_LEDGER_SCHEMA_VERSION + 1}); this build knows ${TIER_LEDGER_SCHEMA_VERSION}. Update Olympus.`;
    expect(workerTierLedgerProblem(Object.values(w.copyPaths))).toBe(message);
    expect(() => new TierLedger({ dbPath: w.ledgerB })).toThrow(message);
    expect(() => open(w.copyPaths.secure_local, false)).toThrow(message);
    const store = open(w.copyPaths.secure_local, true);
    try {
      expect(() => store.status()).toThrow(message);
      expect(store.searchItems('harbour', 5)).toEqual([]);
    } finally { store.close(); }
    expect([hash(w.ledgerB), hash(w.copyPaths.secure_local), hash(w.copyPaths.internal)]).toEqual(before);
    expect(version(w.ledgerB)).toBe(TIER_LEDGER_SCHEMA_VERSION + 1);
  });

  test('a missing local ledger never falls back to the original; eval and probe refuse it', async () => {
    const w = await world();
    rmSync(w.ledgerB);
    const before = hash(w.ledgerA);
    const store = open(w.copyPaths.secure_local, true);
    try {
      expect(store.tierSetLedgerPath()).toBeUndefined();
      expect(store.searchItems('harbour', 5)).toEqual([]);
      expect(() => store.status()).toThrow(/missing/);
    } finally { store.close(); }
    expect(() => openEvalDropboxStores({ secure: w.copyPaths.secure_local, personal: w.copyPaths.internal })).toThrow(/outside the requested directory/);
    expect(() => probeStoreFile({ label: 'copy', dbPath: w.copyPaths.secure_local, term: 'harbour', scanCapMs: 100 })).toThrow(/outside the requested directory/);
    expect(() => open(w.copyPaths.secure_local, false)).toThrow(/missing or outside/);
    expect(hash(w.ledgerA)).toBe(before);
  });

  test('eval rejects an explicit external ledger and a ledger symlink escaping its directory', async () => {
    const w = await world();
    expect(() => openEvalDropboxStores({ secure: w.copyPaths.secure_local, ledger: w.ledgerA })).toThrow(/outside the requested directory/);
    rmSync(w.ledgerB);
    symlinkSync(w.ledgerA, w.ledgerB);
    expect(() => openEvalDropboxStores({ secure: w.copyPaths.secure_local })).toThrow(/outside the requested directory/);
    expect(() => probeStoreFile({ label: 'copy', dbPath: w.copyPaths.secure_local, term: 'harbour', scanCapMs: 100 })).toThrow(/outside the requested directory/);
  });

  test('an in-root recorded ledger remains a valid fallback, but the co-located copy wins', async () => {
    const w = await world(true);
    const recorded = join(w.b, 'previous', 'ledger.sqlite');
    mkdirSync(dirname(recorded), { recursive: true });
    cpSync(w.ledgerB, recorded);
    const ledgerId = TierLedger.readLedgerId(recorded)!;
    expect(findTierSetLedger(w.copyPaths.internal, { ledgerId, ledgerPath: recorded })).toBe(w.ledgerB);
    rmSync(w.ledgerB);
    expect(findTierSetLedger(w.copyPaths.internal, { ledgerId, ledgerPath: recorded })).toBe(recorded);
    expect(() => openEvalDropboxStores({ secure: w.copyPaths.secure_local, ledger: recorded })).toThrow(/outside the requested directory/);
  });
});
