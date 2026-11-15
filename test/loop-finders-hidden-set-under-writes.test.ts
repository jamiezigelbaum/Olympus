// Family 1 of the loop-thread rule, under writes (plan thread, 15 Nov 2026):
// the hidden-copy set is a visibility decision, so the set the read worker
// helps build must equal the one the writer builds on its own connection even
// while copies are hidden during the build.
//
// Why it holds: the build reads both feed cursors (the ledger's
// tier_visibility_changes, the store's item_visibility_feed) on the loop
// before the finder starts, and the worker's snapshots (ledger, then store)
// open after that. Every write after the cursors is in a feed past them, and
// the next read re-derives each fed identity from the current ledger and
// store, by key. A write before the snapshots is seen twice (in the snapshot
// and in the feed), which is harmless because an identity is re-derived, not
// toggled. Two snapshots taken at different times can't leave a row visible:
// whatever changed between them, or after them, is in a feed past the
// installed cursors. Between the memo's install and the next read the set may
// be one change behind, as it always was, and no row is served from it alone:
// every returned row is re-checked against the current ledger.

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

interface Finder { here(): unknown; offThread(): Promise<unknown> }
interface StoreInternals {
  tierLedgerHiddenMemo: { ledgerCursor: number; storeCursor: number } | undefined;
  visibilitySqlMemo: unknown;
  savedVisibilitySteps: unknown;
  visibilityBootstrapFinder(ledger: unknown): Finder;
  tierHiddenItemPksInTurns(): Promise<HiddenSet>;
  tierLedgerHiddenItemPks(): HiddenSet;
  copyServable(identity: unknown): boolean;
}

test('a copy hidden while the worker builds the set is in the next read, and never served', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const specs: FixtureSpec[] = Array.from({ length: 16 }, (_, index) => ({
    id: `row-${String(index + 1).padStart(2, '0')}`, name: `row-${index + 1}.txt`, text: `orchard row number ${index + 1}`,
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
  await hide('row-02');
  const store = fixture.stores.internal! as unknown as StoreInternals;
  store.savedVisibilitySteps = function* () { return undefined; }; // no saved set: every first build bootstraps
  const fresh = () => { store.tierLedgerHiddenMemo = undefined; store.visibilitySqlMemo = undefined; };
  const rebuiltHere = () => { fresh(); return sorted(store.tierLedgerHiddenItemPks()); };

  // Writes land at three points of the off-thread build: after the loop read
  // the cursors but before the worker's snapshots, between the ledger and the
  // store snapshot (started when the store read is sent), and after both.
  const realFinder = store.visibilityBootstrapFinder;
  let between: Promise<void> | undefined;
  setReadPoolObserverForTests((_path, read) => {
    if (!between && read.sql.includes('CROSS JOIN items i')) between = hide('row-09');
  }, { snapshots: true });
  store.visibilityBootstrapFinder = function (ledger) {
    const finder = realFinder.call(this, ledger);
    return {
      here: () => finder.here(),
      offThread: async () => {
        await hide('row-05');
        const found = await finder.offThread();
        await between;
        await hide('row-13');
        return found;
      },
    };
  };
  fresh();
  const built = await store.tierHiddenItemPksInTurns();
  expect(between).toBeDefined();
  store.visibilityBootstrapFinder = realFinder;
  setReadPoolObserverForTests();

  // The memo was installed at the cursors read before the walk, so the hides
  // after them are still ahead of it in the feeds.
  const installed = { ...store.tierLedgerHiddenMemo! };
  const ledgerCursorNow = (fixture.set.ledger as unknown as { visibilityChangesSince(after?: number): { cursor: number } })
    .visibilityChangesSince().cursor;
  expect(ledgerCursorNow).toBeGreaterThan(installed.ledgerCursor);
  expect((built.hidden as number[]).length).toBeGreaterThanOrEqual(2);

  // Never served while the memo is behind: each row is checked against the ledger.
  for (const id of ['row-02', 'row-05', 'row-09', 'row-13']) expect(store.copyServable(identityOf(id))).toBe(false);
  expect(store.copyServable(identityOf('row-01'))).toBe(true);

  // The next read applies the feed and equals a whole rebuild on the writer.
  const next = sorted(store.tierLedgerHiddenItemPks());
  expect(store.tierLedgerHiddenMemo!.ledgerCursor).toBe(ledgerCursorNow);
  expect((next.hidden as number[]).length).toBe(4);
  expect(next).toEqual(rebuiltHere());

  // And a whole build with its finder on the worker equals the one here.
  fresh();
  expect(sorted(await store.tierHiddenItemPksInTurns())).toEqual(rebuiltHere());
});
