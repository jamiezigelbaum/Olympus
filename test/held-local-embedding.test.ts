import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { LocalConnectorStore, createConnectorStoreCorpusAdapter, createConnectorStoreContentProvider, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { RecordingProvider, CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, localProvider, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const SPECS = [{ id: 'held', name: 'picnic.txt', text: 'Quietorchardmarker ordinary picnic notes for Sunday.' }];

async function fixture(privateProvider = localProvider(), personalProvider = privateProvider) {
  const tmp = tempDir();
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/tiers.sqlite` });
  const secrets = new SecretLocationsIndex({ dbPath: `${tmp.dir}/secrets.sqlite` });
  const internal = new LocalConnectorStore({ dbPath: `${tmp.dir}/personal.sqlite`, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: ledger });
  const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/private.sqlite`, corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local', tierLedger: ledger });
  const set = new TieredStoreSet({ setId: 'held-local', ledger, secretLocations: secrets,
    tierClassification: { holdContentUntilJudged: true, sniffer: { id: 'fixture-waiting', judge: () => ({ verdict: 'undecided', queued: true }) } },
    legs: [
      { trustDomain: 'internal', corpusId: internal.corpusId, store: internal, embeddingProvider: personalProvider },
      { trustDomain: 'secure_local', corpusId: store.corpusId, store, embeddingProvider: privateProvider },
    ],
  });
  cleanups.push(() => { internal.close(); store.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  await set.sync(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  const db = (store as unknown as { db: Database }).db;
  const vectors = () => (db.query('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }).n;
  const verdict = (tier: 'secure' | 'private') => {
    for (const pass of ['metadata', 'content'] as const) ledger.applySnifferVerdict(identityOf('held'), {
      pass, tier, reason: `${pass === 'content' ? 'content:' : ''}sniffer:fixture-waiting:${tier}`, modelId: 'fixture',
    }, { placementFor: decision => set.placementFor(decision) });
  };
  return { store, internal, ledger, secrets, set, db, vectors, verdict, privateProvider, personalProvider };
}

async function evidence(store: LocalConnectorStore) {
  return buildEvidencePackDetailed({ question: 'Quietorchardmarker', maxResults: 5,
    searchContext: { allowedTrustDomains: ['secure_local'] },
    registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain })]),
    adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store }) },
    contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) },
    classificationCoverage: () => [{ corpusId: store.corpusId, pendingClassificationItems: 1 }],
  });
}

test('shared local identity embeds held content without changing lexical, Private evidence, counts or coverage; vector search waits for judgment', async () => {
  const f = await fixture();
  expect(f.ledger.copies(identityOf('held')).some(copy => copy.embedHold)).toBe(true);
  const lexical = f.store.searchItems('Quietorchardmarker', 5);
  expect(lexical).toHaveLength(1);
  const before = f.store.status();
  const packBefore = await evidence(f.store);
  expect(packBefore.pack.candidates).toHaveLength(1);
  expect(f.store.missingEmbeddingItemIds(f.privateProvider, 10)).toEqual([localId('held')]);
  expect((await f.store.embedChunks({ provider: f.privateProvider })).chunksEmbedded).toBeGreaterThan(0);
  expect(f.vectors()).toBeGreaterThan(0);
  expect(f.store.searchItems('Quietorchardmarker', 5)).toEqual(lexical);
  expect(f.store.status().counts).toEqual(before.counts);
  expect(f.store.status().tier).toEqual(before.tier);
  const packAfter = await evidence(f.store);
  expect(packAfter.pack.candidates).toEqual(packBefore.pack.candidates);
  expect(packAfter.pack.coverage).toEqual(packBefore.pack.coverage);
  expect(packAfter.classificationCoverage).toEqual(packBefore.classificationCoverage);
  expect((await f.store.vectorSearchLane('Quietorchardmarker', f.privateProvider, 5)).rows).toEqual([]);
  f.verdict('secure'); // Private in the four-tier vocabulary
  expect(f.ledger.copies(identityOf('held')).every(copy => !copy.embedHold)).toBe(true);
  expect((await f.store.vectorSearchLane('Quietorchardmarker', f.privateProvider, 5)).rows).toHaveLength(1);
});

test('held vectors copy to Personal under the shared identity without another embedding', async () => {
  const f = await fixture();
  await f.store.embedChunks({ provider: f.privateProvider });
  const source = f.store.exportItemCopy(identityOf('held'))!;
  const calls = f.privateProvider.inputs.length;
  f.verdict('private'); // Personal in the four-tier vocabulary
  const moved = await moveTieredItem({ set: f.set, identity: identityOf('held'), target: { metadataTier: 'private', contentTier: 'private' }, vectorIdentities: { internal: f.personalProvider } });
  expect(moved.destinations[0]?.vectorsCopied).toBe(source.vectors.length);
  expect(moved.destinations[0]?.chunksToEmbed).toBe(0);
  expect(f.internal.exportItemCopy(identityOf('held'))?.vectors.map(v => [...v.embedding])).toEqual(source.vectors.map(v => [...v.embedding]));
  expect(f.privateProvider.inputs).toHaveLength(calls);
});

test('a Secret verdict removes held vectors, text and copies and keeps a location only', async () => {
  const f = await fixture();
  await f.store.embedChunks({ provider: f.privateProvider });
  expect(f.vectors()).toBeGreaterThan(0);
  await moveTieredItem({ set: f.set, identity: identityOf('held'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
  expect(f.vectors()).toBe(0);
  expect(f.ledger.copies(identityOf('held'))).toEqual([]);
  expect(f.store.localContent(localId('held'))).toBeUndefined();
  expect(f.secrets.get(identityOf('held'))).toMatchObject({ title: 'picnic.txt' });
  expect(f.store.missingEmbeddingItemIds(f.privateProvider, 10)).toEqual([]);
  expect((await f.store.embedChunks({ provider: f.privateProvider })).chunksEmbedded).toBe(0);
});

test('mismatched identities, missing identity, Venice and ordinary cloud never admit a pending judgment', async () => {
  for (const personal of [
    new RecordingProvider('openai-compatible', 'other-model', 'local'),
    new RecordingProvider('openai-compatible', 'secure-local-qwen3-embed', 'local', 8),
    new RecordingProvider('openai-compatible', 'secure-local-qwen3-embed', 'local', 4, 'other-epoch'),
  ]) {
    const f = await fixture(localProvider(), personal);
    expect(f.store.missingEmbeddingItemIds(f.privateProvider, 10)).toEqual([]);
    expect((await f.store.embedChunks({ provider: f.privateProvider })).chunksEmbedded).toBe(0);
    expect(f.privateProvider.inputs).toEqual([]);
  }
  const missing = await fixture();
  missing.store.usePersonalEmbeddingProvider(() => undefined);
  expect((await missing.store.embedChunks({ provider: missing.privateProvider })).chunksEmbedded).toBe(0);
  for (const name of ['venice', 'google-gemini']) {
    const cloud = new RecordingProvider(name, 'cloud-model', 'cloud');
    if (name === 'google-gemini') {
      const f = await fixture();
      expect(f.store.missingEmbeddingItemIds(cloud, 10)).toEqual([]);
      await expect(f.store.embedChunks({ provider: cloud })).rejects.toThrow();
    } else {
      const f = await fixture(cloud);
      expect(f.store.missingEmbeddingItemIds(cloud, 10)).toEqual([]);
      expect((await f.store.embedChunks({ provider: cloud })).chunksEmbedded).toBe(0);
    }
    expect(cloud.inputs).toEqual([]);
  }
});

test('non-judgment holds, names-only, staged, superseded, deletion and Secret-in-progress remain excluded', async () => {
  for (const reason of ['non-judgment', 'names', 'staged', 'superseded', 'deletion', 'secret', 'secret-target', 'secret-override', 'S5']) {
    const f = await fixture();
    const ldb = (f.ledger as unknown as { db: Database }).db;
    // Warm the incremental cache before each change.
    expect(f.store.missingEmbeddingItemIds(f.privateProvider, 10)).toHaveLength(1);
    if (reason === 'non-judgment') ldb.query("UPDATE tier_items SET state = 'current', metadata_pending = 0, content_pending = 0").run();
    if (reason === 'names') ldb.query("UPDATE tier_copies SET layers = 'metadata'").run();
    if (reason === 'staged' || reason === 'superseded') ldb.query('UPDATE tier_copies SET copy_state = ?').run(reason);
    if (reason === 'deletion' || reason === 'secret') f.ledger.putWriteIntent({ identity: identityOf('held'), connectorId: 'fixture_lane', kind: reason });
    if (reason === 'secret-target') ldb.query("UPDATE tier_items SET target_content_tier = 'secrets'").run();
    if (reason === 'secret-override') f.ledger.setOverride(identityOf('held'), { kind: 'tier', tier: 'secrets' });
    if (reason === 'S5') f.db.query("UPDATE items SET trust_tier = 'S5'").run();
    expect((await f.store.embedChunks({ provider: f.privateProvider })).chunksEmbedded).toBe(0);
    expect(f.privateProvider.inputs).toEqual([]);
    expect(f.vectors()).toBe(0);
  }
});

test('a Secret arriving during local embedding cannot leave a vector behind', async () => {
  const f = await fixture();
  const embed = f.privateProvider.embed.bind(f.privateProvider);
  f.privateProvider.embed = async inputs => {
    const result = await embed(inputs);
    f.ledger.putWriteIntent({ identity: identityOf('held'), connectorId: 'fixture_lane', kind: 'secret' });
    return result;
  };
  await f.store.embedChunks({ provider: f.privateProvider });
  expect(f.vectors()).toBe(0);
});
