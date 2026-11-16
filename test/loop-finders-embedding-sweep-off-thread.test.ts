// Family 5 of the loop-thread rule (loop-stall step-back, 15 Nov 2026): the
// embedding sweep's work list and its diagnostics inventory are finders. Each
// window of the chunk/item/vector join is read on the store's read worker; the
// loop only drops what the tier ledger keeps out of view and what failed. A
// list found there can be older than the store, so it never authorizes a
// dispatch: the batch recheck in embedChunks does, against the store and
// ledger as they are when the batch goes out.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { embedPendingChunks } from '../src/workers/connector-store/local-index.ts';
import { setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setReadPoolObserverForTests();
  shutdownReadPool();
});

const IDS = ['row-a', 'row-b', 'row-c', 'row-d', 'row-e'];

async function personalStore() {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const specs: FixtureSpec[] = IDS.map((id) => ({ id, name: `${id}.txt`, text: `meadow note ${id}` }));
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const moveToPublic = (id: string) => moveTieredItem({
    set: fixture.set, identity: identityOf(id), target: { metadataTier: 'public', contentTier: 'public' },
    vectorIdentities: { public_safe: fixture.cloud },
    embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
  });
  return { fixture, store: fixture.stores.internal!, moveToPublic };
}

/** The sweep's window reads that reached the read worker. */
function observeWindows(marker: string): () => number {
  let windows = 0;
  setReadPoolObserverForTests((_path, read) => { if (read.sql.includes(marker)) windows += 1; }, { snapshots: true });
  return () => windows;
}

test('the work list is read on the read worker, a window at a time, and equals the list found here', async () => {
  const { fixture, store, moveToPublic } = await personalStore();
  // row-c moves to Public: its Personal copy is superseded and hidden here.
  await moveToPublic('row-c');
  const windows = observeWindows('first_chunk_pk');
  // One chunk per window, so the list spans several reads.
  const offThread = await store.missingEmbeddingItemIdsInTurns(fixture.cloud, 10, {}, 1);
  expect(windows()).toBeGreaterThan(1);
  expect(offThread).toEqual(store.missingEmbeddingItemIds(fixture.cloud, 10));
  expect(offThread).toEqual(['row-a', 'row-b', 'row-d', 'row-e'].map((id) => `personal:${id}`));
  // A limit stops the walk with the items of the earliest chunks.
  expect(await store.missingEmbeddingItemIdsInTurns(fixture.cloud, 2, {}, 1)).toEqual(offThread.slice(0, 2));
});

test('a copy hidden after the worker found the list is not sent: the outcome is the one found here', async () => {
  // Here: the move lands before the sweep looks.
  const here = await personalStore();
  await here.moveToPublic('row-b');
  await embedPendingChunks([{ store: here.store, provider: here.fixture.cloud, wholeStore: true }], { maxItems: 10 });
  // Off the loop: the worker's list still names row-b; the move lands after it was found.
  const raced = await personalStore();
  const find = raced.store.missingEmbeddingItemIdsInTurns.bind(raced.store);
  let found: string[] = [];
  raced.store.missingEmbeddingItemIdsInTurns = (async (...args: Parameters<typeof find>) => {
    found = await find(...args);
    await raced.moveToPublic('row-b');
    return found;
  }) as typeof find;
  await embedPendingChunks([{ store: raced.store, provider: raced.fixture.cloud, wholeStore: true }], { maxItems: 10 });
  expect(found).toContain('personal:row-b');
  expect(raced.fixture.cloud.inputs.join('\n')).not.toContain('row-b');
  const owed = (store: typeof here.store) => store.embeddingOwedItemIds(here.fixture.cloud.modelId, IDS.map((id) => `personal:${id}`));
  expect(owed(raced.store)).toEqual(owed(here.store));
  expect(owed(raced.store)).toEqual(['personal:row-b']);
});

test('the inventory counts on the read worker, and its counts equal the list', async () => {
  const { fixture, store, moveToPublic } = await personalStore();
  await moveToPublic('row-c');
  const windows = observeWindows('in_scope');
  const counts = await store.embeddingSweepInventory(fixture.cloud, {}, undefined, 1);
  expect(windows()).toBeGreaterThan(1);
  expect(counts).toMatchObject({ pending_chunks: 5, eligible_chunks: 4, skipped_hidden_chunks: 1, inventory_complete: 1 });
  // A spent budget says so, rather than calling the unseen tail empty.
  expect(await store.embeddingSweepInventory(fixture.cloud, {}, Date.now() - 1, 1)).toMatchObject({ inventory_complete: 0, pending_chunks: 0 });
});
