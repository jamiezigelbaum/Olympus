// Family 1 of the loop-thread rule (loop-stall step-back, 15 Nov 2026): the
// hidden-copy set's bootstrap walk (every copy of the corpus in the ledger,
// then this store's item pks for the flagged ones) runs on the read worker
// when the set is built in turns, and the set it builds equals the one the
// same walk builds on the store's own connection.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  setReadPoolObserverForTests();
  for (const cleanup of cleanups.splice(0)) cleanup();
  shutdownReadPool();
});

type HiddenSet = Record<string, number[] | number>;
const sorted = (set: HiddenSet) => Object.fromEntries(Object.entries(set).map(([key, value]) =>
  [key, Array.isArray(value) ? [...value].sort((a, b) => a - b) : value]));

test('the bootstrap walk runs on the read worker and builds the set the writer builds', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const specs: FixtureSpec[] = Array.from({ length: 12 }, (_, index) => ({
    id: `row-${String(index + 1).padStart(2, '0')}`, name: `row-${index + 1}.txt`, text: `meadow row number ${index + 1}`,
  }));
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  for (const id of ['row-03', 'row-07']) {
    const moved = await moveTieredItem({
      set: fixture.set, identity: identityOf(id), target: { metadataTier: 'public', contentTier: 'public' },
      vectorIdentities: { public_safe: fixture.cloud },
      embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
    });
    expect(moved.supersededCorpora).toEqual([CORPORA.internal]);
  }
  const store = fixture.stores.internal! as unknown as {
    dbPath: string;
    tierLedgerHiddenMemo: unknown;
    visibilitySqlMemo: unknown;
    savedVisibilitySteps: unknown;
    tierHiddenItemPksInTurns(): Promise<HiddenSet>;
    tierLedgerHiddenItemPks(): HiddenSet;
  };
  // Every build here starts from nothing: no memo and no saved set.
  store.savedVisibilitySteps = function* () { return undefined; };
  const fresh = () => { store.tierLedgerHiddenMemo = undefined; store.visibilitySqlMemo = undefined; };
  const pooled: string[] = [];
  setReadPoolObserverForTests((_path, read) => { pooled.push(read.sql); }, { snapshots: true });
  fresh();
  const offThread = await store.tierHiddenItemPksInTurns();
  expect(pooled.some((sql) => sql.includes('tier_copies_visibility_walk'))).toBe(true);
  expect(pooled.some((sql) => sql.includes('CROSS JOIN items i'))).toBe(true);
  fresh();
  const here = store.tierLedgerHiddenItemPks();
  expect(sorted(offThread)).toEqual(sorted(here));
  expect((offThread.hidden as number[]).length).toBe(2);
});
