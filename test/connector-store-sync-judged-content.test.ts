import { afterEach, expect, test } from 'bun:test';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const original = 'Orchardoriginalmarker: bring bananas and oranges to the picnic.';
const changed = 'Orchardchangedmarker: bring apples and pears to the picnic.';

function lane() {
  const tmp = tempDir('olympus-sync-judged-');
  const f = openTierFixture(tmp.dir, { embed: false });
  const queue = new TierSnifferStore({ dbPath: ':memory:' });
  const set = new TieredStoreSet({
    setId: 'sync-judged', ledger: f.ledger, secretLocations: f.secrets,
    tierClassification: { sniffer: new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE) },
    legs: ['internal', 'secure_local'].map(domain => ({
      trustDomain: domain as 'internal' | 'secure_local', corpusId: CORPORA[domain as 'internal' | 'secure_local'],
      store: f.stores[domain as 'internal' | 'secure_local']!,
    })),
  });
  cleanups.push(() => { queue.close(); f.close(); tmp.cleanup(); });
  let calls = 0;
  let author = 'Orchard writer';
  const sync = (text: string) => {
    const base = fixtureConnector(() => [{ id: 'note', name: 'Orchard notes', text }]);
    const connector = { ...base,
      async *listItems() {
        for await (const page of base.listItems()) yield { ...page, items: page.items.map(item => ({ ...item,
          metadata: { title: 'Orchard notes', author, locatorUri: 'https://example.test/orchard', tags: ['reading'], updatedAt: '2026-11-11T19:15:00Z' },
        })) };
      },
      classificationSignals: () => ({ title: 'Orchard notes', sender: author, labels: ['reading'], folderKeys: ['article', 'archive'] }),
    };
    return set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  };
  const finishMove = async () => {
    const row = f.ledger.getCurrent(identityOf('note'))!;
    if (row.state === 'moving') await moveTieredItem({ set, identity: identityOf('note'),
      target: { metadataTier: row.targetMetadataTier!, contentTier: row.targetContentTier! }, expectedGeneration: row.generation });
  };
  const pass = async () => {
    rejudgeRoutedItems({ set, autoMoves: true });
    await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: queue, placementFor: d => set.placementFor(d) }],
      lane: BUILT_IN_SNIFFER_LANE, model: { async complete(request) {
        calls++;
        const items = request.prompt.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: items.map(item => ({
          i: item.i, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 0.99,
        })) }) };
      } } });
    await finishMove();
  };
  const readable = (marker: string, text: string) => {
    expect(f.stores.internal!.searchItems(marker, 10).map(hit => hit.sourceItem.providerItemId)).toEqual(['note']);
    expect(f.stores.internal!.localContent(localId('note'))?.chunks.join('')).toBe(text);
    expect(f.ledger.getCurrent(identityOf('note'))).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
    expect(f.ledger.copies(identityOf('note'))).toContainEqual(expect.objectContaining({ trustDomain: 'internal', layers: 'both', embedHold: false }));
  };
  return { ...f, set, queue, sync, pass, readable, calls: () => calls, renameAuthor: () => { author = 'Different writer'; } };
}

test('sync keeps unchanged judged Personal content readable before any sniffer pass', async () => {
  const f = lane();
  await f.sync(original);
  await f.pass();
  f.readable('Orchardoriginalmarker', original);
  const copies = f.ledger.copies(identityOf('note'));
  await f.sync(original);
  f.readable('Orchardoriginalmarker', original);
  expect(f.ledger.copies(identityOf('note'))).toEqual(copies);
  expect(f.queue.counts().questions).toBe(0);
  expect(f.calls()).toBe(1);
});

test('sync applies a cached Personal verdict for changed material at write time', async () => {
  const f = lane();
  await f.sync(changed);
  await f.pass();
  await f.sync(original);
  await f.pass();
  f.readable('Orchardoriginalmarker', original);
  // The same item was judged on these new bytes earlier. No pass follows this write.
  await f.sync(changed);
  f.readable('Orchardchangedmarker', changed);
  expect(f.stores.internal!.searchItems('Orchardoriginalmarker', 10)).toEqual([]);
  expect(f.queue.counts().questions).toBe(0);
  expect(f.calls()).toBe(2);
});

test('sync holds changed material without a verdict until the sniffer pass releases it', async () => {
  const f = lane();
  await f.sync(original);
  await f.pass();
  await f.sync(changed);
  expect(f.ledger.getCurrent(identityOf('note'))).toMatchObject({ contentPending: true });
  expect(f.stores.internal!.searchItems('Orchardchangedmarker', 10)).toEqual([]);
  expect(f.stores.internal!.searchItems('Orchardoriginalmarker', 10)).toEqual([]);
  expect(f.stores.internal!.localContent(localId('note'))?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local!.localContent(localId('note'))?.chunks.join('')).toBe(changed);
  expect(f.queue.counts().questions).toBe(1);
  await f.pass();
  f.readable('Orchardchangedmarker', changed);
  expect(f.calls()).toBe(2);
});

test('a changed author cannot reuse a stored-input verdict that omitted that author', async () => {
  const f = lane();
  await f.sync(changed);
  await f.pass();
  await f.sync(original);
  await f.pass();
  f.renameAuthor();
  await f.sync(changed);
  expect(f.ledger.getCurrent(identityOf('note'))).toMatchObject({ contentPending: true });
  expect(f.stores.internal!.searchItems('Orchardchangedmarker', 10)).toEqual([]);
  expect(f.queue.counts().questions).toBe(1);
  expect(f.calls()).toBe(2);
});

test('a cached edit also releases an item currently held for different material during this sync', async () => {
  const f = lane();
  await f.sync(original);
  await f.pass();
  await f.sync(changed);
  expect(f.ledger.getCurrent(identityOf('note'))).toMatchObject({ contentPending: true });
  await f.sync(original);
  f.readable('Orchardoriginalmarker', original);
  expect(f.calls()).toBe(1);
});
