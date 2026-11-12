import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedgerPurgedRollbackRefusedError } from '../src/workers/classification/tier-ledger.ts';
import { moveTieredItem, flushTierMoveNotes } from '../src/workers/connector-store/tier-move.ts';
import { startSupersededSweepTicker, sweepAutomaticSupersededCopies } from '../src/workers/connector-store/tier-auto-prune-sweep.ts';
import { readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const text = 'Orchard inventory for winter.';
const low = classifyItemTiers({ signals: { title: 'Orchard' }, text });
const high = { ...low, metadataTier: 'secure' as const, contentTier: 'secure' as const };
async function fixture() {
  const tmp = tempDir('auto-prune-sweep-');
  const clock = createTestClock();
  let f = openTierFixture(tmp.dir, { embed: false, now: clock.date });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.stores.secure_local!.syncFromConnector(fixtureConnector(() => ['a', 'b', 'c'].map(id => ({
    id, name: 'Orchard', text, legacyDomain: 'secure_local' as const,
  }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  f.stores.secure_local!.bindTierSet(f.ledger);
  for (const id of ['a', 'b', 'c']) {
    const identity = identityOf(id);
    f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
    await moveTieredItem({ set: f.set, identity, decision: low }); // old automatic behaviour
  }
  f.ledger.replaceMigrationProposals('migration', [{ identity: identityOf('b'), family: 'file',
    fromCorpusId: CORPORA.secure_local, fromTrustDomain: 'secure_local', kind: 'queued_move',
    metadataTier: 'private', contentTier: 'private', decision: low, chunks: 1,
    estimatedChunksToEmbed: 1, estimatedTokens: 10, itemFingerprint: 'fixture', batchKeys: [],
  }]);
  f.ledger.markMigrationProposal('migration', identityOf('b'), { status: 'moved', movedGeneration: f.ledger.getCurrent(identityOf('b'))!.generation });
  // Simulate an upgrade: the old worker has never run this sweep.
  f.ledger.writeMeta('automatic-superseded-prune-v1', '');
  const embeddingLedger = { path: join(tmp.dir, 'invalidation.jsonl'), approvedBy: 'system-automatic' as const };
  return { get f() { return f; }, clock, embeddingLedger,
    reopen() { f.close(); f = openTierFixture(tmp.dir, { embed: false, now: clock.date }); } };
}

test('bounded sweep resumes its cursor, protects moved proposals, audits per corpus, then idles', async () => {
  const ctx = await fixture();
  const sweep = () => sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, embeddingLedger: ctx.embeddingLedger });
  expect(sweep()).toMatchObject({ checked: 1, purged: 1, complete: false });
  expect(ctx.f.stores.secure_local!.copyContentState(identityOf('a'))).toBeUndefined();
  expect(sweep()).toMatchObject({ checked: 1, purged: 0, complete: false });
  expect(ctx.f.ledger.copies(identityOf('b')).some(copy => copy.state === 'superseded')).toBe(true);
  expect(ctx.f.stores.secure_local!.copyContentState(identityOf('b'))?.chunks).toBe(1);
  expect(sweep()).toMatchObject({ checked: 1, purged: 1 });
  expect(sweep().complete).toBe(true);
  expect(sweep()).toMatchObject({ checked: 0, purged: 0, complete: true });
  await flushTierMoveNotes(ctx.f.ledger);
  const entries = (await readEmbeddingLedger(ctx.embeddingLedger.path)).entries.filter(entry => entry.entry_id?.startsWith('automatic-superseded-prune:'));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ status: 'complete', kind: 'invalidation', scope: { chunks: { [CORPORA.secure_local]: 2 } } });
  for (const id of ['a', 'c']) {
    expect(ctx.f.stores.internal!.localContent(localId(id))?.chunks.join('')).toBe(text);
    expect(() => ctx.f.ledger.rollbackMove(identityOf(id), { expectedGeneration: ctx.f.ledger.getCurrent(identityOf(id))!.generation })).toThrow(TierLedgerPurgedRollbackRefusedError);
  }
  ctx.f.ledger.rollbackMove(identityOf('b'), { expectedGeneration: ctx.f.ledger.getCurrent(identityOf('b'))!.generation });
  expect(ctx.f.stores.secure_local!.localContent(localId('b'))?.chunks.join('')).toBe(text);
});

test('interrupted sweep keeps original chunk counts and resumes on worker startup without duplicate invalidations', async () => {
  const ctx = await fixture();
  const original = ctx.f.stores.secure_local!.stripCopyContent.bind(ctx.f.stores.secure_local!);
  const failure = spyOn(ctx.f.stores.secure_local!, 'stripCopyContent').mockImplementation((...args) => {
    original(...args); throw new Error('crash after store commit');
  });
  try {
    expect(sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, embeddingLedger: ctx.embeddingLedger })).toMatchObject({ failed: 1, complete: false });
  } finally { failure.mockRestore(); }
  expect(ctx.f.stores.secure_local!.copyContentState(identityOf('a'))?.chunks).toBe(0);
  ctx.reopen(); // constructor maintenance resumes the pending receipt
  await ctx.f.set.repairLowerContent();
  await flushTierMoveNotes(ctx.f.ledger);
  expect(ctx.f.ledger.copies(identityOf('a')).some(copy => copy.state === 'superseded')).toBe(false);
  const entries = (await readEmbeddingLedger(ctx.embeddingLedger.path)).entries.filter(entry => entry.entry_id?.startsWith('automatic-superseded-prune:'));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.scope?.chunks?.[CORPORA.secure_local]).toBe(2);
  await ctx.clock.advance(600_000);
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger })).toMatchObject({ checked: 0, purged: 0, complete: true });
  await flushTierMoveNotes(ctx.f.ledger);
  expect((await readEmbeddingLedger(ctx.embeddingLedger.path)).entries.filter(entry => entry.entry_id === entries[0]!.entry_id)).toHaveLength(1);
});

test('a hide-first move is left intact and revisited before the one-time sweep completes', async () => {
  const ctx = await fixture();
  const identity = identityOf('c');
  ctx.f.ledger.recordRoutedPlacement(identity, high, ctx.f.set.placementFor(high));
  expect(ctx.f.ledger.getCurrent(identity)?.state).toBe('moving');
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger }).complete).toBe(false);
  expect(ctx.f.stores.internal!.copyContentState(identity)?.chunks).toBe(1);
  await moveTieredItem({ set: ctx.f.set, identity, decision: high });
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger }).complete).toBe(true);
  // A raise is not pruned: its names-only superseded row stays for re-home.
  expect(ctx.f.ledger.copies(identity).filter(copy => copy.state === 'superseded').map(copy => copy.corpusId)).toEqual([CORPORA.internal]);
});

test('a superseded copy holding a newer source version than the destination is kept', async () => {
  const ctx = await fixture();
  const store = ctx.f.stores.secure_local!;
  const original = store.copyContentState.bind(store);
  const newer = spyOn(store, 'copyContentState').mockImplementation((identity) => {
    const state = original(identity);
    if (!state || identity.providerItemId !== identityOf('a').providerItemId) return state;
    return { ...state, sourceVersion: 'later-edit', contentHash: 'later-edit', updatedAt: '2999-01-01T00:00:00.000Z' };
  });
  try {
    expect(sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, embeddingLedger: ctx.embeddingLedger }))
      .toMatchObject({ checked: 1, purged: 0, kept: 1, failed: 0 });
  } finally { newer.mockRestore(); }
  expect(ctx.f.ledger.copies(identityOf('a')).some(copy => copy.state === 'superseded')).toBe(true);
  expect(store.copyContentState(identityOf('a'))?.chunks).toBe(1);
  // The sweep moved on: the next item is pruned as usual.
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, embeddingLedger: ctx.embeddingLedger })).toMatchObject({ checked: 1 });
});

test('an item that keeps failing is stepped past after three passes, so the rest of the sweep finishes (#1412)', async () => {
  const ctx = await fixture();
  const sweep = () => sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger });
  const destination = ctx.f.stores.internal!;
  const original = destination.copyContentState.bind(destination);
  const broken = identityOf('a');
  const unavailable = spyOn(destination, 'copyContentState').mockImplementation((identity, ...rest) =>
    identity.providerItemId === broken.providerItemId ? undefined : original(identity, ...rest));
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (let pass = 0; pass < 3; pass++) expect(sweep()).toMatchObject({ failed: 1, purged: 0, complete: false });
    // Stepped past: the next pass reaches the rest of the ledger.
    expect(sweep()).toMatchObject({ failed: 0, purged: 1, complete: false });
    expect(ctx.f.stores.secure_local!.copyContentState(identityOf('c'))).toBeUndefined();
    // The stuck item is never treated as done while it still fails.
    expect(sweep()).toMatchObject({ failed: 1, complete: false });
    expect(ctx.f.stores.secure_local!.copyContentState(broken)?.chunks).toBe(1);
    const lines = warn.mock.calls.map(call => String(call[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Ledger id, corpora, a count and an error name: never item identity or content.
      expect(line).toMatch(/^\[tier-auto-prune\] ledger=[0-9a-f]+ corpora=\S+ failures=\d+ reason=\w+$/);
    }
  } finally { unavailable.mockRestore(); warn.mockRestore(); }
  // Once the store is back, the walk finishes the item and completes.
  let report = sweep();
  for (let pass = 0; pass < 3 && !report.complete; pass++) report = sweep();
  expect(report.complete).toBe(true);
  expect(ctx.f.stores.secure_local!.copyContentState(broken)).toBeUndefined();
});

test('a receipt stepped past after repeated failures keeps its original chunk count for the audit (#1412)', async () => {
  const ctx = await fixture();
  const sweep = () => sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, embeddingLedger: ctx.embeddingLedger });
  const store = ctx.f.stores.secure_local!;
  const original = store.stripCopyContent.bind(store);
  const failure = spyOn(store, 'stripCopyContent').mockImplementation((...args) => {
    original(...args); throw new Error('store commit then crash');
  });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (let pass = 0; pass < 3; pass++) expect(sweep()).toMatchObject({ failed: 1 });
  } finally { failure.mockRestore(); warn.mockRestore(); }
  expect(store.copyContentState(identityOf('a'))?.chunks ?? 0).toBe(0);
  let report = sweep();
  for (let pass = 0; pass < 10 && !report.complete; pass++) report = sweep();
  expect(report.complete).toBe(true);
  await flushTierMoveNotes(ctx.f.ledger);
  const entries = (await readEmbeddingLedger(ctx.embeddingLedger.path)).entries.filter(entry => entry.entry_id?.startsWith('automatic-superseded-prune:'));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.scope?.chunks?.[CORPORA.secure_local]).toBe(2);
});

test('a failed attempt does not persist the rolled-back audit totals with its failure count (#1412)', async () => {
  const ctx = await fixture();
  const ledger = ctx.f.ledger;
  const original = ledger.writeMeta.bind(ledger);
  let thrown = false;
  // Fail the ledger transaction that finishes item a's receipt, after its
  // in-memory totals were raised and before it commits.
  const failure = spyOn(ledger, 'writeMeta').mockImplementation((key: string, value: string) => {
    if (!thrown && key === 'automatic-superseded-prune-v1' && value.includes('"deleted"') && !value.includes('"pending"')) {
      thrown = true; throw new Error('commit failed');
    }
    return original(key, value);
  });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, embeddingLedger: ctx.embeddingLedger })).toMatchObject({ failed: 1 });
  } finally { failure.mockRestore(); warn.mockRestore(); }
  expect(thrown).toBe(true);
  let report = sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger });
  for (let pass = 0; pass < 5 && !report.complete; pass++) report = sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger });
  expect(report.complete).toBe(true);
  // The rolled-back removal is redone, not skipped by a cursor saved from memory.
  expect(ledger.copies(identityOf('a')).some(copy => copy.state === 'superseded')).toBe(false);
  await flushTierMoveNotes(ledger);
  const entries = (await readEmbeddingLedger(ctx.embeddingLedger.path)).entries.filter(entry => entry.entry_id?.startsWith('automatic-superseded-prune:'));
  expect(entries[0]?.scope?.chunks?.[CORPORA.secure_local]).toBe(2);
});

test('with a time budget one call keeps paging until the walk ends, and the walk skips items without superseded copies', async () => {
  const ctx = await fixture();
  let clock = 0;
  // Budget spent after the first page: one item only.
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, budgetMs: 5, now: () => (clock += 10),
    embeddingLedger: ctx.embeddingLedger })).toMatchObject({ checked: 1, purged: 1, complete: false });
  // A budget that lasts: the rest of the walk in one call.
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { limit: 1, budgetMs: 60_000, now: () => 0,
    embeddingLedger: ctx.embeddingLedger })).toMatchObject({ purged: 1, complete: true });
  // Only b (its moved migration proposal protects it) still holds a superseded copy.
  expect(ctx.f.ledger.listSupersededItemWindow({ limit: 10 }).map(record => record.providerItemId))
    .toEqual([identityOf('b').providerItemId]);
  expect(ctx.f.ledger.listItemWindow({ limit: 10 })).toHaveLength(3);
});

test('the background ticker sweeps without the sniffer or a sync, then leaves a finished set alone', async () => {
  const ctx = await fixture();
  const slice = spyOn(ctx.f.set, 'sweepSupersededSlice');
  let active = false;
  let tick: (() => void) | undefined;
  let cancelled = false;
  const stop = startSupersededSweepTicker({ active: () => active, sets: () => [ctx.f.set],
    every: (run, ms) => { expect(ms).toBe(5_000); tick = run; return () => { cancelled = true; }; } });
  tick!();
  // The split's front (inactive) takes no slice.
  expect(slice).not.toHaveBeenCalled();
  active = true;
  for (let i = 0; i < 10 && !JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1') || '{}').done; i++) tick!();
  expect(JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1') || '{}').done).toBe(true);
  expect(ctx.f.ledger.listSupersededItemWindow({ limit: 10 }).map(record => record.providerItemId))
    .toEqual([identityOf('b').providerItemId]);
  const calls = slice.mock.calls.length;
  tick!();
  expect(slice.mock.calls.length).toBe(calls);
  stop();
  expect(cancelled).toBe(true);
});

test('a time budget stops a page between items, keeps the cursor, and does not end the walk early', async () => {
  const ctx = await fixture();
  let clock = 0;
  const info = spyOn(console, 'info').mockImplementation(() => {});
  cleanup.push(() => info.mockRestore());
  // Each read of the clock advances it, so the budget is spent after the first item of a 200-item page.
  const first = sweepAutomaticSupersededCopies(ctx.f.set, { budgetMs: 5, now: () => (clock += 10),
    embeddingLedger: ctx.embeddingLedger });
  expect(first).toMatchObject({ checked: 1, purged: 1, complete: false });
  expect(JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1') || '{}').done).toBeUndefined();
  expect(info.mock.calls.some(([line]) => /\[tier-auto-prune\] ledger=\S+ slice_ms=\d+ prune_ms=\d+ max_item_ms=\d+ checked=1 purged=1 complete=false/.test(String(line)))).toBe(true);
  // The next call carries on from the cursor and finishes.
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { budgetMs: 60_000, now: () => 0,
    embeddingLedger: ctx.embeddingLedger })).toMatchObject({ purged: 1, complete: true });
});
