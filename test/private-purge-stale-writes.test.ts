import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { RawItem } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, fixtureItem, identityOf, localId, openTierFixture, snapshotStore, tempDir } from './helpers/tier-fixtures.ts';

const original = { id: 'garden', name: 'Garden.txt', text: 'Ordinary garden notes about compost.', version: 'v1' };
const late = { ...original, name: 'Old Personal extraction title', text: 'Late extraction contains the original Personal body.', version: 'v2' };

function restore(store: LocalConnectorStore, item: RawItem) {
  const text = item.content.kind === 'text' ? item.content.text : '';
  const hash = createHash('sha256').update(text).digest('hex');
  return store.restoreItemRepresentations({
    syncConnectorId: 'late-extraction', ownerConnectorId: 'fixture_lane', ownershipKind: 'observed',
    classify: () => buildSourceSensitivity({ trustTier: store.trustDomain === 'secure_local' ? 'S4' : 'S3', trustDomain: store.trustDomain }),
    items: [{ item, expectation: {
      sourceItem: item.identity, sourceVersion: item.identity.sourceVersion,
      contentHash: hash,
      chunkContentHashes: [hash],
    } }],
  });
}

function lowerCounts(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    return {
      chunks: count('SELECT COUNT(*) AS n FROM chunks'),
      vectors: count('SELECT COUNT(*) AS n FROM chunk_embeddings'),
      versions: count('SELECT COUNT(*) AS n FROM item_text_versions'),
      contentFts: count('SELECT COUNT(*) AS n FROM connector_store_fts_rows WHERE chunk_pk IS NOT NULL'),
      names: db.query('SELECT title, search_text, locator_uri FROM items').all(),
    };
  } finally { db.close(); }
}

async function fixture() {
  const { dir, cleanup } = tempDir();
  const f = openTierFixture(dir);
  await f.set.sync(fixtureConnector(() => [original]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  return { f, cleanup: () => { f.close(); cleanup(); } };
}

function expectEmptyLower(f: ReturnType<typeof openTierFixture>) {
  expect(lowerCounts(f.paths.internal)).toEqual({ chunks: 0, vectors: 0, versions: 0, contentFts: 0, names: [{ title: null, search_text: null, locator_uri: null }] });
}

test('an extraction issued while Personal cannot restore lower content or names after the move completes', async () => {
  const { f, cleanup } = await fixture();
  try {
    const lower = f.stores.internal!;
    const pendingExtraction = fixtureItem(late);
    await moveTieredItem({ set: f.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' } });
    const destination = snapshotStore(f.paths.secure_local, [localId('garden')]);
    const report = restore(lower, pendingExtraction);
    expect(report.counts.itemsRestored).toBe(0);
    expect(report.counts.itemsMetadataOnly).toBe(1);
    expectEmptyLower(f);
    expect(snapshotStore(f.paths.secure_local, [localId('garden')])).toEqual(destination);
  } finally { cleanup(); }
});

test('a paused Personal sync route is rejected at the eventual metadata/content write boundary', async () => {
  const { f, cleanup } = await fixture();
  try {
    let routed!: () => void;
    const issued = new Promise<void>((resolve) => { routed = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const sync = f.stores.internal!.syncFromConnector(fixtureConnector(() => [late]), {
      fetchContent: true,
      tierRouting: { async route() {
        // This placement was issued before the promotion, exactly the route
        // that the production async sync loop resumes after its await.
        routed();
        await waiting;
        return { kind: 'store', layer: 'both', sensitivity: buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }) };
      } },
    });
    await issued;
    await moveTieredItem({ set: f.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' } });
    release();
    const report = await sync;
    expect(report.itemsRejected).toBe(1);
    expectEmptyLower(f);
    expect(snapshotStore(f.paths.secure_local, [localId('garden')]).chunks.map((chunk) => chunk.bounded_text)).toEqual([original.text]);
  } finally { cleanup(); }
});

test('current Personal and Private stores still accept normal extracted updates', async () => {
  const { f, cleanup } = await fixture();
  try {
    expect(restore(f.stores.internal!, fixtureItem(late)).counts.itemsRestored).toBe(1);
    expect(snapshotStore(f.paths.internal).chunks.map((chunk) => chunk.bounded_text)).toEqual([late.text]);
    await moveTieredItem({ set: f.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' } });
    const privateUpdate = { ...late, text: 'Current Private extraction stays in the Private store.', version: 'v3' };
    expect(restore(f.set.store('secure_local')!, fixtureItem(privateUpdate)).counts.itemsRestored).toBe(1);
    expect(snapshotStore(f.paths.secure_local).chunks.map((chunk) => chunk.bounded_text)).toEqual([privateUpdate.text]);
    expectEmptyLower(f);
  } finally { cleanup(); }
});

test('a refused late extraction does not empty a rollback source before destination verification', async () => {
  const { f, cleanup } = await fixture();
  try {
    const before = snapshotStore(f.paths.internal, [localId('garden')]);
    await expect(moveTieredItem({ set: f.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' }, beforeFlip: () => { throw new Error('destination not verified'); } })).rejects.toThrow('destination not verified');
    expect(restore(f.stores.internal!, fixtureItem(late)).counts.itemsRestored).toBe(0);
    expect(snapshotStore(f.paths.internal, [localId('garden')])).toEqual(before);
  } finally { cleanup(); }
});

test('a body fetch finishing after the purge cannot pass the central chunk writer', async () => {
  const { f, cleanup } = await fixture();
  try {
    let fetching!: () => void;
    const fetched = new Promise<void>((resolve) => { fetching = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const connector = fixtureConnector(() => [{ ...late, text: undefined }]);
    connector.fetchItem = async () => {
      fetching();
      await waiting;
      return fixtureItem(late);
    };
    const sync = f.stores.internal!.syncFromConnector(connector, {
      fetchContent: true,
      tierRouting: { route: () => ({ kind: 'store', layer: 'both', sensitivity: buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }) }) },
    });
    await fetched;
    await moveTieredItem({ set: f.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' } });
    release();
    await sync;
    expectEmptyLower(f);
    expect(snapshotStore(f.paths.secure_local).chunks.map((chunk) => chunk.bounded_text)).toEqual([original.text]);
  } finally { cleanup(); }
});
