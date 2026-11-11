import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedgerPurgedRollbackRefusedError } from '../src/workers/classification/tier-ledger.ts';
import { moveTieredItem, flushTierMoveNotes } from '../src/workers/connector-store/tier-move.ts';
import { sweepAutomaticSupersededCopies } from '../src/workers/connector-store/tier-auto-prune-sweep.ts';
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
