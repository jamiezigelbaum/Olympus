import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedgerPurgedRollbackRefusedError, tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { moveTieredItem, moveTieredItemsLowering } from '../src/workers/connector-store/tier-move.ts';
import { purgeLowerTierContent } from '../src/workers/connector-store/tier-content-purge.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const body = 'Orchard pruning plan for the apple trees this winter.';
const low = classifyItemTiers({ signals: { title: 'Orchard' }, text: body });
const high = { ...low, metadataTier: 'secure' as const, contentTier: 'secure' as const };

async function fixture() {
  const tmp = tempDir('auto-prune-');
  const clock = createTestClock();
  const f = openTierFixture(tmp.dir, { embed: false, now: clock.date });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const identity = identityOf('orchard');
  await f.stores.secure_local!.syncFromConnector(fixtureConnector(() => [
    { id: 'orchard', name: 'Orchard', text: body, legacyDomain: 'secure_local' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
  const move = { set: f.set, identity, decision: low, replaceOwnSupersededCopy: true,
    embeddingLedger: { path: join(tmp.dir, 'embedding.jsonl'), approvedBy: 'system-automatic' as const } };
  return { f, identity, move, clock };
}

for (const batch of [false, true]) test(`automatic lowering prunes text and copy row; answers and round trip survive (batch=${batch})`, async () => {
  const { f, identity, move } = await fixture();
  if (batch) expect(moveTieredItemsLowering([move])[0]).toHaveProperty('result');
  else await moveTieredItem(move);
  // Text, vectors and names are gone and the row is tombstoned: nothing serves it.
  expect(f.stores.secure_local!.copyContentState(identity)).toBeUndefined();
  expect(f.stores.secure_local!.exportItemCopy(identity)).toBeUndefined();
  const privateDb = new Database(f.paths.secure_local, { readonly: true });
  try {
    expect(privateDb.query('SELECT COUNT(*) AS n FROM connector_store_fts_rows WHERE chunk_pk IS NOT NULL').get()).toEqual({ n: 0 });
    expect(privateDb.query("SELECT COUNT(*) AS n FROM connector_store_fts WHERE bounded_text <> '' OR title <> ''").get()).toEqual({ n: 0 });
  } finally { privateDb.close(); }
  expect(f.ledger.copies(identity).some(copy => copy.state === 'superseded')).toBe(false);
  expect(f.stores.secure_local!.searchItems('orchard', 10)).toEqual([]);
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
  const stores = f.set.openStores();
  const detail = await buildEvidencePackDetailed({ question: 'orchard', maxResults: 10,
    searchContext: { allowedTrustDomains: ['internal', 'secure_local'] },
    registry: buildSourceIndexCorpusRegistry(stores.map(store => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
    adapters: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
    contentProviders: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreContentProvider({ store })])),
    visibilityGate: createTierVisibilityGate(() => [{ ledger: f.ledger, corpusIds: new Set(Object.values(CORPORA)) }]),
  });
  expect(detail.candidateCorpusIds).toEqual([CORPORA.internal]);
  expect(detail.pack.candidates[0]!.chunks.join('')).toContain(body);
  const generation = f.ledger.getCurrent(identity)!.generation;
  expect(f.ledger.readMeta(`tier-content-purged:${tierLedgerIdentityKey(identity)}`)).toBe(String(generation));
  expect(() => f.ledger.rollbackMove(identity, { expectedGeneration: generation })).toThrow(TierLedgerPurgedRollbackRefusedError);
  await moveTieredItem({ ...move, decision: high });
  expect(f.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
  expect(f.stores.secure_local!.searchItems('orchard', 10)).toHaveLength(1);
});

for (const recovery of ['maintenance', 'single', 'batch'] as const) for (const step of ['beforePrune', 'afterPurge'] as const) test(`automatic prune resumes after a crash ${step} via ${recovery} with flip already durable`, async () => {
  const { f, identity, move } = await fixture();
  const generation = f.ledger.getCurrent(identity)!.generation;
  const strip = step === 'beforePrune' ? spyOn(f.stores.secure_local!, 'stripCopyContent').mockImplementation(() => { throw new Error('crash'); }) : undefined;
  const crashing = { ...move, ...(step === 'afterPurge' ? { afterPurge() { throw new Error('crash'); } } : {}) };
  try {
    if (recovery === 'batch') expect(moveTieredItemsLowering([crashing])[0]).toHaveProperty('error');
    else await expect(moveTieredItem(crashing)).rejects.toThrow('crash');
  } finally { strip?.mockRestore(); }
  expect(f.ledger.getCurrent(identity)).toMatchObject({ generation: generation + 1, contentTier: 'private', state: 'current' });
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
  expect(f.ledger.readMeta(`tier-move-verified:${tierLedgerIdentityKey(identity)}`)).toBeTruthy();
  expect(() => f.ledger.rollbackMove(identity, { expectedGeneration: generation + 1 })).toThrow(TierLedgerPurgedRollbackRefusedError);
  if (recovery === 'maintenance') {
    const report = purgeLowerTierContent(f.set, { maintenance: true, embeddingLedger: move.embeddingLedger });
    expect(report.resumed).toBe(1);
  } else if (recovery === 'batch') expect(moveTieredItemsLowering([move])[0]).toHaveProperty('result');
  else await moveTieredItem(move);
  expect(f.ledger.copies(identity).some(copy => copy.state === 'superseded')).toBe(false);
  expect(f.stores.secure_local!.copyContentState(identity)).toBeUndefined();
  expect(f.ledger.readMeta(`tier-move-verified:${tierLedgerIdentityKey(identity)}`)).toBe('');
});

test('a later decision cannot discard an automatic flip\'s pending prune receipt', async () => {
  const { f, identity, move } = await fixture();
  const strip = spyOn(f.stores.secure_local!, 'stripCopyContent').mockImplementation(() => { throw new Error('crash'); });
  try { await expect(moveTieredItem(move)).rejects.toThrow('crash'); }
  finally { strip.mockRestore(); }
  const flipped = f.ledger.getCurrent(identity)!.generation;
  f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
  expect(f.ledger.getCurrent(identity)).toMatchObject({ generation: flipped, state: 'moving' });
  expect(purgeLowerTierContent(f.set, { maintenance: true, embeddingLedger: move.embeddingLedger }).resumed).toBe(1);
  expect(f.stores.secure_local!.copyContentState(identity)).toBeUndefined();
  expect(f.stores.internal!.copyContentState(identity)?.chunks).toBe(1);
  await moveTieredItem({ ...move, decision: high });
  expect(f.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
});
