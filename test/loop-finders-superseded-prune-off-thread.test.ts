// Family 5 of the loop-thread rule (loop-stall step-back, 15 Nov 2026): the
// one-time superseded-copy sweep finds its pages on the ledger's read worker
// and gives the loop a turn between the items it prunes. Each item is read
// again by key and pruned under the generation it holds now, so a decision
// that lands after its page was found is never pruned over, and the sweep is
// not marked done across it.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { ledgerReadOffThread } from '../src/workers/connector-store/child-visibility.ts';
import { setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { sweepAutomaticSupersededCopies, sweepAutomaticSupersededCopiesInTurns } from '../src/workers/connector-store/tier-auto-prune-sweep.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { createTestClock } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  setReadPoolObserverForTests();
  shutdownReadPool();
});
const text = 'Orchard inventory for winter.';
const low = classifyItemTiers({ signals: { title: 'Orchard' }, text });
const high = { ...low, metadataTier: 'secure' as const, contentTier: 'secure' as const };
const STATE = 'automatic-superseded-prune-v1';

/** Three items moved down by the old automatic behaviour: each leaves a Private copy superseded. */
async function fixture() {
  const tmp = tempDir('auto-prune-off-thread-');
  const clock = createTestClock();
  const f = openTierFixture(tmp.dir, { embed: false, now: clock.date });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.stores.secure_local!.syncFromConnector(fixtureConnector(() => ['a', 'b', 'c'].map(id => ({
    id, name: 'Orchard', text, legacyDomain: 'secure_local' as const,
  }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  f.stores.secure_local!.bindTierSet(f.ledger);
  for (const id of ['a', 'b', 'c']) {
    f.ledger.recordRoutedPlacement(identityOf(id), high, f.set.placementFor(high));
    await moveTieredItem({ set: f.set, identity: identityOf(id), decision: low });
  }
  f.ledger.writeMeta(STATE, '');
  const embeddingLedger = { path: join(tmp.dir, 'invalidation.jsonl'), approvedBy: 'system-automatic' as const };
  return { f, embeddingLedger };
}

type Fixture = Awaited<ReturnType<typeof fixture>>['f'];

function outcome(f: Fixture) {
  return {
    state: JSON.parse(f.ledger.readMeta(STATE) || '{}').done === true,
    superseded: ['a', 'b', 'c'].filter(id => f.ledger.copies(identityOf(id)).some(copy => copy.state === 'superseded')),
    privateCopies: ['a', 'b', 'c'].filter(id => f.stores.secure_local!.copyContentState(identityOf(id)) !== undefined),
  };
}

function observeWalk(): () => number {
  let reads = 0;
  setReadPoolObserverForTests((_path, read) => { if (read.sql.includes('tier_copies_superseded_walk')) reads += 1; }, { snapshots: true });
  return () => reads;
}

test('each page is found on the read worker, and the slices prune what the sweep here prunes', async () => {
  const here = await fixture();
  while (!sweepAutomaticSupersededCopies(here.f.set, { limit: 1, embeddingLedger: here.embeddingLedger }).complete) { /* next page */ }
  const loop = await fixture();
  const reads = observeWalk();
  for (let slice = 0; slice < 10; slice++) {
    if ((await sweepAutomaticSupersededCopiesInTurns(loop.f.set, { limit: 1, embeddingLedger: loop.embeddingLedger })).complete) break;
  }
  expect(reads()).toBeGreaterThan(1);
  expect(outcome(loop.f)).toEqual(outcome(here.f));
  expect(outcome(loop.f)).toEqual({ state: true, superseded: [], privateCopies: [] });
});

test('a decision that lands after the page was found is read by key: the item is decided as it is now', async () => {
  // Here: c is raised back to Private (hidden first, then moved) before the sweep looks.
  const raise = async (f: Fixture) => {
    f.ledger.recordRoutedPlacement(identityOf('c'), high, f.set.placementFor(high));
    await moveTieredItem({ set: f.set, identity: identityOf('c'), decision: high });
  };
  const here = await fixture();
  await raise(here.f);
  const hereReport = sweepAutomaticSupersededCopies(here.f.set, { embeddingLedger: here.embeddingLedger });
  // On the loop: the worker's page still holds c at its old generation; the
  // raise lands at the first turn, before the loop reaches c.
  const loop = await fixture();
  const generation = loop.f.ledger.getCurrent(identityOf('c'))!.generation;
  let turns = 0;
  const loopReport = await sweepAutomaticSupersededCopiesInTurns(loop.f.set, { embeddingLedger: loop.embeddingLedger,
    turn: () => (turns++ === 0 ? raise(loop.f) : undefined) });
  expect(loop.f.ledger.getCurrent(identityOf('c'))!.generation).not.toBe(generation);
  expect(turns).toBe(2);
  expect(loopReport).toEqual(hereReport);
  expect(loopReport).toMatchObject({ checked: 3, purged: 2, failed: 0 });
  expect(outcome(loop.f)).toEqual(outcome(here.f));
  // A raise keeps its names-only superseded row and its Private copy serves.
  expect(loop.f.stores.secure_local!.copyContentState(identityOf('c'))?.chunks).toBe(1);
});

test('a hide-first move that starts after the page was found is not pruned over, and the walk is not done', async () => {
  const loop = await fixture();
  let turns = 0;
  const report = await sweepAutomaticSupersededCopiesInTurns(loop.f.set, { embeddingLedger: loop.embeddingLedger, turn: () => {
    if (turns++ === 0) loop.f.ledger.recordRoutedPlacement(identityOf('c'), high, loop.f.set.placementFor(high));
    return undefined;
  } });
  expect(report).toMatchObject({ checked: 3, purged: 2, failed: 0, complete: false });
  expect(loop.f.stores.secure_local!.copyContentState(identityOf('c'))?.chunks).toBe(1);
  // Delayed, not lost: once c's move ends, a later slice walks again and finishes.
  await moveTieredItem({ set: loop.f.set, identity: identityOf('c'), decision: high });
  expect((await sweepAutomaticSupersededCopiesInTurns(loop.f.set, { embeddingLedger: loop.embeddingLedger })).complete).toBe(true);
});

test('inside a ledger hold the page waits for the hold to end before it reads on the worker', async () => {
  const { f, embeddingLedger } = await fixture();
  const reads = observeWalk();
  let release!: () => void;
  const held = f.ledger.holdingWrites(() => new Promise<void>((resolve) => { release = resolve; }));
  const slice = sweepAutomaticSupersededCopiesInTurns(f.set, { limit: 1, embeddingLedger });
  // Two reads of the ledger on its worker while the hold is open: a page sent
  // without waiting would be seen first.
  for (let reads = 0; reads < 2; reads++) await ledgerReadOffThread(f.ledger, (function* () { yield { sql: 'SELECT 1 AS one', params: [], mode: 'get' as const }; })());
  expect(reads()).toBe(0);
  release();
  await held;
  expect(await slice).toMatchObject({ checked: 1, purged: 1, failed: 0 });
  expect(reads()).toBe(1);
});

test('a slice asked for while one runs does nothing', async () => {
  const { f, embeddingLedger } = await fixture();
  const first = sweepAutomaticSupersededCopiesInTurns(f.set, { limit: 1, embeddingLedger });
  expect(await sweepAutomaticSupersededCopiesInTurns(f.set, { limit: 1, embeddingLedger })).toMatchObject({ checked: 0, complete: false });
  expect(await first).toMatchObject({ checked: 1, purged: 1 });
});
