// A source card counts each item waiting for its judge once, not once per tier
// store: Readwise's card said 6,956 held against 3,800 items (run 43648133408)
// because its two stores each counted their copy of the same items.
import { afterEach, expect, test } from 'bun:test';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { LocalConnectorStore, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const SPECS = ['a', 'b', 'c'].map(id => ({ id, name: `picnic-${id}.txt`, text: `Quietorchardmarker ordinary picnic notes ${id} for Sunday.` }));

test('each waiting item is counted once across the two tier stores of a source', async () => {
  const tmp = tempDir();
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/tiers.sqlite` });
  const secrets = new SecretLocationsIndex({ dbPath: `${tmp.dir}/secrets.sqlite` });
  const internal = new LocalConnectorStore({ dbPath: `${tmp.dir}/personal.sqlite`, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: ledger });
  const secure = new LocalConnectorStore({ dbPath: `${tmp.dir}/private.sqlite`, corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local', tierLedger: ledger });
  const set = new TieredStoreSet({ setId: 'held-once', ledger, secretLocations: secrets,
    tierClassification: { holdContentUntilJudged: true, sniffer: { id: 'fixture-waiting', judge: () => ({ verdict: 'undecided', queued: true }) } },
    legs: [
      { trustDomain: 'internal', corpusId: internal.corpusId, store: internal },
      { trustDomain: 'secure_local', corpusId: secure.corpusId, store: secure },
    ],
  });
  cleanups.push(() => { internal.close(); secure.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  await set.sync(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  // Every item waits for its judge, with a held copy in each store.
  for (const spec of SPECS) {
    expect(ledger.copies(identityOf(spec.id)).filter(copy => copy.state === 'current' && copy.embedHold).map(copy => copy.corpusId).sort())
      .toEqual([CORPORA.internal, CORPORA.secure_local].sort());
  }
  const handler = createSourceIndexStatusHandler({
    corpusDefinitions: [internal, secure].map(store => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain })),
    connectorStores: [internal, secure],
  });
  const status = await handler.status({});
  const counts = status.corpora.map(corpus => (corpus as { counts: Record<string, number> }).counts);
  // Each store still says what it holds.
  expect(counts.map(count => count.pending_classification_items)).toEqual([3, 3]);
  // Added up, the set holds three items, not six copies.
  expect(counts.reduce((sum, count) => sum + (count.pending_classification_items_once ?? 0), 0)).toBe(3);
});
