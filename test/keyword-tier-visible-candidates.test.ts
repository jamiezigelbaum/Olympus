// #1174: keyword search must look past hidden copies for visible matches.
//
// In a store where most items are superseded copies, the best-ranked keyword
// matches can all be copies the tier filter hides. The lane used to filter one
// fixed page of candidates, so a visible match ranked below them was never
// considered. These tests put N superseded copies above one visible match.

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  FIXTURE_PLACEMENT,
  fixtureConnector,
  localId,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * `hiddenCount` items that say the query words many times (so they rank
 * first) and one visible item that says them once, then every copy of the
 * loud items in the visible item's store is marked superseded.
 */
async function crowdedStore(hiddenCount: number, words: string): Promise<{ fixture: TierFixture; store: LocalConnectorStore }> {
  const { dir, cleanup } = tempDir('olympus-1174-');
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  const loud = `${words} `.repeat(12);
  const specs: FixtureSpec[] = [
    ...Array.from({ length: hiddenCount }, (_, n) => ({ id: `old-${n}`, name: `old-${n}.txt`, text: `${loud} superseded copy ${n}.` })),
    { id: 'visible', name: 'visible.txt', text: `A single mention of ${words} in the note that is still current, among many other plain words about the weather and the garden.` },
  ];
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const ldb = (fixture.ledger as unknown as { db: Database }).db;
  const home = ldb.query("SELECT corpus_id FROM tier_copies WHERE provider_item_id = 'visible' AND copy_state = 'current' AND layers IN ('content', 'both')")
    .get() as { corpus_id: string };
  ldb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id LIKE 'old-%' AND corpus_id = ?").run(home.corpus_id);
  const store = fixture.set.openStores().find((candidate) => candidate.corpusId === home.corpus_id)!;
  return { fixture, store };
}

test('a visible keyword match ranked below a full page of superseded copies is returned', async () => {
  const { store } = await crowdedStore(40, 'quietorchardmarker');
  // The hidden copies are still in this store's index and outrank the visible one.
  const ids = store.searchItems('quietorchardmarker', 10).map((row) => row.sourceItem.localItemId);
  expect(ids).toEqual([localId('visible')]);
  const detailed = store.searchItemsDetailed('quietorchardmarker', 10);
  // Every match was read, so the one visible row is a count, not a lower bound.
  expect(detailed.saturated).toBe(false);
});

test('the read pool pages the same way (#1079 search path)', async () => {
  const { store } = await crowdedStore(40, 'quietorchardmarker');
  const pooled = await store.searchItemsDetailedOffThread('quietorchardmarker', 10);
  expect(pooled.rows.map((row) => row.sourceItem.localItemId)).toEqual([localId('visible')]);
  expect(pooled.saturated).toBe(false);
});

test('the same holds for a multi-concept query under the minimum-signal filter', async () => {
  const { store } = await crowdedStore(60, 'quietorchardmarker lanternledgerword');
  for (const contentOnly of [false, true]) {
    const options = { contentOnly, locate: false };
    const direct = store.searchItemsDetailed('quietorchardmarker lanternledgerword', 5, undefined, undefined, options);
    const pooled = await store.searchItemsDetailedOffThread('quietorchardmarker lanternledgerword', 5, undefined, undefined, options);
    for (const result of [direct, pooled]) {
      expect(result.rows.map(row => row.sourceItem.localItemId)).toEqual([localId('visible')]);
      expect(result.concepts.total).toBe(2);
      expect([...result.concepts.matched]).toEqual([[localId('visible'), 2]]);
      expect(result.saturated).toBe(false);
    }
    expect(pooled).toEqual(direct);
  }
}, 60_000);

test('superseded copies stay hidden however many pages are read', async () => {
  const { store } = await crowdedStore(30, 'quietorchardmarker');
  const rows = store.searchItems('quietorchardmarker', 50);
  expect(rows.map((row) => row.sourceItem.localItemId)).toEqual([localId('visible')]);
  expect(rows.some((row) => row.sourceItem.localItemId.includes('old-'))).toBe(false);
});

test('the scan is bounded: past the cap, a buried match is not looked for', async () => {
  const { store } = await crowdedStore(1_050, 'quietorchardmarker');
  const db = (store as unknown as { db: Database }).db;
  const original = db.query.bind(db);
  let pages = 0;
  let rowsRead = 0;
  const spy = (sql: string) => {
    // The bounded first try ranks only the best rows and, on these tied
    // copies, is discarded for the full ranking (#1242): count the pages
    // whose candidates the scan looked at.
    if (!sql.includes('LIMIT ? OFFSET ?') || sql.includes('MIN(top.rank)')) return original(sql);
    // An uncached statement, so each page is wrapped once.
    const statement = db.prepare(sql);
    const all = statement.all.bind(statement);
    return Object.assign(statement, {
      all: (...params: unknown[]) => {
        pages += 1;
        const rows = (all as (...args: unknown[]) => unknown[])(...params);
        rowsRead += rows.length;
        return rows;
      },
    });
  };
  (db as unknown as { query: typeof spy }).query = spy;
  try {
    const detailed = store.searchItemsDetailed('quietorchardmarker', 10);
    expect(detailed.rows).toEqual([]);
    expect(detailed.saturated).toBe(true);
    expect(rowsRead).toBe(1_000);
    expect(pages).toBeLessThanOrEqual(8);
  } finally {
    (db as unknown as { query: typeof original }).query = original;
  }
}, 60_000);
