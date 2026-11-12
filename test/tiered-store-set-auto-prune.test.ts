import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedgerPurgedRollbackRefusedError } from '../src/workers/classification/tier-ledger.ts';
import { moveTieredItem, flushTierMoveNotes } from '../src/workers/connector-store/tier-move.ts';
import { reclaimAutomaticSupersededCopies, startSupersededSweepTicker, sweepAutomaticSupersededCopies } from '../src/workers/connector-store/tier-auto-prune-sweep.ts';
import { SUPERSEDED_SWEEP_SLICE_MS } from '../src/workers/connector-store/tiered-store-set.ts';
import { createSourceAnswerTrace, runWithSourceAnswerTrace } from '../src/workers/source-index/answer-latency-trace.ts';
import { readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';
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

// Real SQLite payload pages tied to the three fixture chunks. The sweep must
// delete a/c's vectors, while b's migration-protected vector and body survive.
function fillReclaimFixture(ctx: Awaited<ReturnType<typeof fixture>>, legacy = false): number {
  const db = new Database(ctx.f.paths.secure_local);
  db.exec('PRAGMA busy_timeout = 10000;');
  try {
    if (legacy) db.exec('PRAGMA auto_vacuum = NONE; VACUUM;');
    expect(db.query('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: legacy ? 0 : 2 });
    db.query(`INSERT INTO chunk_embeddings(chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
      SELECT chunk_pk, 'fixture-reclaim', item_pk, content_hash, zeroblob(?), '2026-11-12' FROM chunks`).run(36 * 1024 * 1024);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return statSync(ctx.f.paths.secure_local).size;
  } finally { db.close(); }
}

function reclaimFixtureIntact(ctx: Awaited<ReturnType<typeof fixture>>): void {
  for (const id of ['a', 'c']) expect(ctx.f.stores.internal!.localContent(localId(id))?.chunks.join('')).toBe(text);
  expect(ctx.f.stores.secure_local!.copyContentState(identityOf('b'))?.chunks).toBe(1);
  const db = new Database(ctx.f.paths.secure_local, { readonly: true });
  db.exec('PRAGMA busy_timeout = 10000;');
  try {
    expect(db.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(db.query('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('SELECT bounded_text AS text FROM chunks').all()).toEqual([{ text }]);
    expect(db.query('SELECT count(*) AS rows, sum(length(embedding)) AS bytes FROM chunk_embeddings').get())
      .toEqual({ rows: 1, bytes: 36 * 1024 * 1024 });
  } finally { db.close(); }
}

for (const legacy of [false, true]) test(`real ${legacy ? 'legacy NONE' : 'incremental'} store shrinks once after the sweep and survives reopen`, async () => {
  const ctx = await fixture();
  const beforeSweep = fillReclaimFixture(ctx, legacy);
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger }).complete).toBe(true);
  const afterSweep = statSync(ctx.f.paths.secure_local).size;
  expect(afterSweep).toBe(beforeSweep);
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    if (legacy) {
      // Death after SQLite commits, before the ledger records completion:
      // retain the intent and retry even though the freelist is now small.
      const write = ctx.f.ledger.writeMeta.bind(ctx.f.ledger);
      let interrupted = false;
      const failure = spyOn(ctx.f.ledger, 'writeMeta').mockImplementation((key, value) => {
        if (key === 'automatic-superseded-prune-v1' && JSON.parse(value).reclaimed?.[CORPORA.secure_local]?.done) {
          interrupted = true;
          throw new Error('reclaim receipt crash');
        }
        return write(key, value);
      });
      try {
        await waitFor(async () => {
          try { await reclaimAutomaticSupersededCopies(ctx.f.set); }
          catch (error) { expect((error as Error).message).toBe('reclaim receipt crash'); }
          return interrupted;
        }, { timeoutMs: 120_000, description: 'reclaim commits before its completion receipt' });
      } finally { failure.mockRestore(); }
      expect(JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1')!).reclaimed[CORPORA.secure_local].done).toBeUndefined();
      expect(log.mock.calls).toHaveLength(0);
      ctx.reopen();
    }
    await waitFor(() => reclaimAutomaticSupersededCopies(ctx.f.set), { timeoutMs: 120_000, description: 'reclaim drains the fixture' });
    const afterReclaim = statSync(ctx.f.paths.secure_local).size;
    expect(afterReclaim).toBeLessThan(afterSweep - 64 * 1024 * 1024);
    reclaimFixtureIntact(ctx);
    expect(log.mock.calls.filter(([line]) => String(line).startsWith('[tier-auto-prune-reclaim]'))).toHaveLength(1);
    expect(log.mock.calls[0]![0]).toBe(`[tier-auto-prune-reclaim] ledger=${ctx.f.ledger.ledgerId()} tier=secure_local bytes_before=${afterSweep} bytes_after=${afterReclaim}`);
    ctx.reopen();
    const reclaim = spyOn(ctx.f.stores.secure_local!, 'reclaimFreePages');
    expect(await reclaimAutomaticSupersededCopies(ctx.f.set)).toBe(true);
    expect(reclaim).not.toHaveBeenCalled();
    reclaim.mockRestore();
    reclaimFixtureIntact(ctx);
    // This receipt is copied into result.md, not committed as a benchmark DB.
    process.stdout.write(`reclaim-fixture ${JSON.stringify({ legacy, beforeSweep, afterSweep, afterReclaim })}\n`);
  } finally { log.mockRestore(); }
}, 150_000);

test('an Ask preempts a running legacy conversion within the slice budget, and the next tick retries safely', async () => {
  const ctx = await fixture();
  fillReclaimFixture(ctx, true);
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger }).complete).toBe(true);
  const store = ctx.f.stores.secure_local!;
  const original = store.reclaimFreePages.bind(store);
  let started = false;
  const observe = spyOn(store, 'reclaimFreePages').mockImplementation(budget => original(budget, { onStarted: () => { started = true; } }));
  const reclaim = reclaimAutomaticSupersededCopies(ctx.f.set);
  try {
    await waitFor(() => started, { description: 'conversion worker opens the store' });
    const beforeAsk = performance.now();
    let admissionMs = 0;
    let holdAsk!: () => void;
    const held = new Promise<void>(resolve => { holdAsk = resolve; });
    const ask = runWithSourceAnswerTrace(createSourceAnswerTrace(), async () => {
      admissionMs = performance.now() - beforeAsk;
      expect(admissionMs).toBeLessThan(SUPERSEDED_SWEEP_SLICE_MS);
      expect(store.copyContentState(identityOf('b'))?.chunks).toBe(1);
      await held;
    });
    try {
      expect(await reclaim).toBe(false);
      const receipt = JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1')!).reclaimed[CORPORA.secure_local];
      expect(receipt.done).toBeUndefined();
      // A new tick must not start disk work for the whole duration of an Ask.
      const calls = observe.mock.calls.length;
      expect(await reclaimAutomaticSupersededCopies(ctx.f.set)).toBe(false);
      expect(observe.mock.calls.length).toBe(calls);
    } finally { holdAsk(); await ask; }
    process.stdout.write(`reclaim-ask ${JSON.stringify({ admissionMs, budgetMs: SUPERSEDED_SWEEP_SLICE_MS })}\n`);
  } finally { observe.mockRestore(); await reclaim; }
  ctx.reopen();
  await waitFor(() => reclaimAutomaticSupersededCopies(ctx.f.set), { timeoutMs: 120_000, description: 'interrupted conversion retries' });
  reclaimFixtureIntact(ctx);
}, 150_000);

for (const free of [1_000, 20_000]) test(`a small ${free === 1_000 ? 'absolute' : 'relative'} freelist is skipped durably`, async () => {
  const ctx = await fixture();
  expect(sweepAutomaticSupersededCopies(ctx.f.set, { embeddingLedger: ctx.embeddingLedger }).complete).toBe(true);
  const store = ctx.f.stores.secure_local!;
  const space = spyOn(store, 'reclaimablePages').mockReturnValue({ pages: 1_000_000, free, pageBytes: 4096, bytes: 4_096_000_000 });
  const disk = spyOn(store, 'reclaimFreePages');
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await reclaimAutomaticSupersededCopies(ctx.f.set)).toBe(true);
    expect(await reclaimAutomaticSupersededCopies(ctx.f.set)).toBe(true);
    expect(disk).not.toHaveBeenCalled();
    expect(log.mock.calls).toHaveLength(1);
    expect(JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1')!).reclaimed[CORPORA.secure_local].done).toBe(true);
  } finally { space.mockRestore(); disk.mockRestore(); log.mockRestore(); }
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
  await waitFor(() => JSON.parse(ctx.f.ledger.readMeta('automatic-superseded-prune-v1') || '{}').reclaimed?.[CORPORA.secure_local]?.done,
    { description: 'ticker records small-store reclaim completion' });
  await flushMicrotasks();
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
