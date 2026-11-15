// Family 1 of the loop-thread rule, under a ledger hold: the hidden-copy
// set's bootstrap reads its feed cursors on the loop's connections. Inside a
// hold (TierLedger.holdingWrites, a transaction kept across an await) those
// cursors already cover the hold's own writes, which the read worker's
// snapshot can't see until the hold commits. The finder waits the hold out
// before it reads on the worker, and walks on the loop's own connections
// (which do see the hold's writes) when the hold lasts past its wait.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { waitFor } from './helpers/test-clock.ts';
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

interface Finder { here(): unknown; offThread(): Promise<unknown> }
interface StoreInternals {
  tierLedgerHiddenMemo: unknown;
  visibilitySqlMemo: unknown;
  savedVisibilitySteps: unknown;
  visibilityBootstrapFinder(ledger: unknown): Finder;
  tierHiddenItemPksInTurns(): Promise<HiddenSet>;
  tierLedgerHiddenItemPks(): HiddenSet;
}

async function setup() {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const specs: FixtureSpec[] = Array.from({ length: 8 }, (_, index) => ({
    id: `row-${index + 1}`, name: `row-${index + 1}.txt`, text: `lantern row number ${index + 1}`,
  }));
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const hide = async (id: string) => {
    const moved = await moveTieredItem({
      set: fixture.set, identity: identityOf(id), target: { metadataTier: 'public', contentTier: 'public' },
      vectorIdentities: { public_safe: fixture.cloud },
      embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
    });
    expect(moved.supersededCorpora).toEqual([CORPORA.internal]);
  };
  await hide('row-1');
  const store = fixture.stores.internal! as unknown as StoreInternals;
  store.savedVisibilitySteps = function* () { return undefined; };
  const fresh = () => { store.tierLedgerHiddenMemo = undefined; store.visibilitySqlMemo = undefined; };
  const rebuiltHere = () => { fresh(); return sorted(store.tierLedgerHiddenItemPks()); };
  const walks: string[] = [];
  setReadPoolObserverForTests((_path, read) => { if (read.sql.includes('tier_copies_visibility_walk')) walks.push(read.sql); }, { snapshots: true });
  return { fixture, store, hide, fresh, rebuiltHere, walks };
}

test('a bootstrap begun inside a hold reads on the worker only after the hold commits', async () => {
  const { fixture, store, hide, fresh, rebuiltHere, walks } = await setup();
  const realFinder = store.visibilityBootstrapFinder;
  let reached!: () => void;
  const finderReached = new Promise<void>((resolve) => { reached = resolve; });
  store.visibilityBootstrapFinder = function (ledger) {
    const finder = realFinder.call(this, ledger);
    return { here: () => finder.here(), offThread: () => { reached(); return finder.offThread(); } };
  };
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let build: Promise<HiddenSet> | undefined;
  const hold = fixture.ledger.holdingWrites(async () => {
    await hide('row-4'); // written inside the hold: in the ledger's feed, not yet committed
    fresh();
    build = store.tierHiddenItemPksInTurns();
    let settled = false;
    void build.then(() => { settled = true; }, () => { settled = true; });
    await finderReached; // the cursors are read
    // Give a read on the worker every chance to happen inside the hold: it must not.
    await waitFor(() => settled, { timeoutMs: 300 }).catch(() => undefined);
    expect(settled).toBe(false);
    expect(walks).toEqual([]);
    await released;
  });
  await finderReached;
  expect(fixture.ledger.writesHeld()).toBe(true);
  release();
  await hold;
  const built = sorted(await build!);
  store.visibilityBootstrapFinder = realFinder;
  expect(walks.length).toBeGreaterThan(0); // walked on the worker, after the commit
  expect((built.hidden as number[]).length).toBe(2);
  // The installed set is complete: the next read (by the feed) and a whole rebuild agree.
  expect(sorted(store.tierLedgerHiddenItemPks())).toEqual(built);
  expect(rebuiltHere()).toEqual(built);
});

test('a hold that outlasts the wait is walked on the loop\'s own connections, which see its writes', async () => {
  const { fixture, store, hide, fresh, rebuiltHere, walks } = await setup();
  let built: HiddenSet | undefined;
  await fixture.ledger.holdingWrites(async () => {
    await hide('row-6');
    fresh();
    built = sorted(await store.tierHiddenItemPksInTurns()); // the whole build, inside the hold
  });
  expect(walks).toEqual([]);
  expect((built!.hidden as number[]).length).toBe(2);
  expect(sorted(store.tierLedgerHiddenItemPks())).toEqual(built!);
  expect(rebuiltHere()).toEqual(built!);
});
