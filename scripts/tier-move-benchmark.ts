// Synthetic, disposable, counts-only tier-move profile. Never opens live stores.
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { emptyTierMoveTimings, flushTierMoveNotes, moveTieredItemsLowering, moveTieredItem, type TierMoveOptions } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from '../test/helpers/tier-fixtures.ts';

const count = Number(process.env.MOVE_BENCH_ROWS ?? 31200);
const sample = Number(process.env.MOVE_BENCH_SAMPLE ?? 1000);
const mode = process.env.MOVE_BENCH_MODE ?? 'batch';
const tmp = tempDir('synthetic-move-profile-');
const f = openTierFixture(tmp.dir, { embed: false });
const text = 'Synthetic orchard inventory. '.repeat(12).trim();
const lower = classifyItemTiers({ signals: { title: 'Synthetic' }, text });
const high = { ...lower, metadataTier: 'secure' as const, contentTier: 'secure' as const };
const metrics: Record<string, number> = {};
const add = (key: string, ms: number) => { metrics[key] = (metrics[key] ?? 0) + ms; };
function profile(object: any, name: string, key: string) {
  const original = object[name].bind(object);
  object[name] = (...args: any[]) => {
    const start = performance.now();
    try { return original(...args); } finally { add(key, performance.now() - start); }
  };
}
// SQLite transaction overhead is elapsed outside the callback, not a claimed
// syscall-level fsync duration. Nested savepoints are excluded from that count.
function profileTransactions(db: any) {
  const original = db.transaction.bind(db);
  db.transaction = (work: (...args: any[]) => any) => {
    let bodyMs = 0;
    const transaction = original((...args: any[]) => {
      const start = performance.now();
      try { return work(...args); } finally { bodyMs = performance.now() - start; }
    });
    const wrapped: any = (...args: any[]) => run(transaction, args);
    const run = (fn: any, args: any[]) => {
      const outer = !db.inTransaction;
      const start = performance.now();
      try { return fn(...args); } finally {
        if (outer) { add('sqlite_transaction_ms', performance.now() - start - bodyMs); add('sqlite_transactions', 1); }
      }
    };
    for (const mode of ['deferred', 'immediate', 'exclusive']) wrapped[mode] = (...args: any[]) => run(transaction[mode], args);
    return wrapped;
  };
}
try {
  await f.set.sync(fixtureConnector(() => [{ id: 'template', name: 'Synthetic', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity: identityOf('template'), target: high });
  const source = f.stores.secure_local!;
  const copy = source.exportItemCopy(identityOf('template'))!;
  const vectorProvider = { provider: 'built-in', modelId: 'synthetic-768', backend: 'local' as const,
    dimension: 768, epochId: 'synthetic-768-v1', configHash: 'synthetic' };
  copy.vectorAuthorities = [{ ...vectorProvider }];
  copy.vectors = copy.chunks.map(chunk => ({ chunkIndex: chunk.chunkIndex, modelId: vectorProvider.modelId,
    contentHash: chunk.embeddingInputHash!, embedding: new Uint8Array(new Float32Array(768).fill(0.125).buffer) }));
  f.stores.internal!.importItemCopy(copy, { trustTier: 'S3', syncConnectorId: 'synthetic-profile', vectorProvider });
  // Seed the full backlog in transactions; setup is excluded from the profile.
  const sourceDb = (source as any).db as Database;
  const ledgerDb = (f.ledger as any).db as Database;
  for (let offset = 0; offset < count; offset += 250) {
    ledgerDb.transaction(() => sourceDb.transaction(() => {
      for (let n = offset; n < Math.min(count, offset + 250); n++) {
        const identity = identityOf(`synthetic-${n}`);
        source.importItemCopy({ ...copy, identity, columns: { ...copy.columns, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId } },
          { trustTier: 'S4', syncConnectorId: 'synthetic-profile', vectorProvider });
        f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
        f.ledger.recordRoutedPlacement(identity, lower, f.set.placementFor(lower));
      }
    })())();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const oldNotes = Number(process.env.MOVE_BENCH_OLD_NOTES ?? 63000);
  ledgerDb.transaction(() => {
    for (let n = 0; n < oldNotes; n++) f.ledger.writeMeta(`tier-move-note:synthetic-completed-${n}`, '');
  })();
  if (process.env.MOVE_BENCH_LEGACY_META === '1') {
    // Reproduce the pre-index lookup on this disposable synthetic database.
    f.ledger.metaEntries = (prefix, options = {}) => ledgerDb.query(`
      SELECT key, value FROM tier_ledger_meta INDEXED BY sqlite_autoindex_tier_ledger_meta_1
      WHERE key >= ? AND key < ? AND key > ? AND value <> '' ORDER BY key LIMIT ?`)
      .all(prefix, `${prefix}\uffff`, options.after ?? '', options.limit ?? -1) as Array<{ key: string; value: string }>;
  }
  for (const store of f.set.openStores()) {
    profile(store, 'exportItemCopy', 'export_ms');
    profile(store, 'importItemCopy', 'copy_including_vectors_ms');
    profile(store, 'stripCopyContent', 'purge_ms');
    profileTransactions((store as any).db);
  }
  profile(f.ledger, 'stageMove', 'stage_ms');
  profile(f.ledger, 'completeMove', 'flip_ms');
  profileTransactions(ledgerDb);
  const timings = emptyTierMoveTimings();
  let service: TierSnifferService | undefined;
  let installed: InstalledTierClassification | undefined;
  if (mode === 'service') {
    installed = new InstalledTierClassification({ env: {} });
    service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
      model: { async complete() { throw new Error('No model in a move benchmark'); } },
      modelAvailable: () => false, stores: () => f.set.openStores(),
      classificationLedgerPath: join(tmp.dir, 'classification.jsonl'),
      autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(tmp.dir, 'notes.jsonl') },
    });
  }

  if (process.env.MOVE_BENCH_TRACE === '1') console.log(JSON.stringify({ phase: 'measured_start', epoch_ms: Date.now() }));
  const started = performance.now();
  const move = (n: number): TierMoveOptions => ({
    set: f.set, identity: identityOf(`synthetic-${n}`), target: lower, vectorIdentities: { internal: vectorProvider }, timings,
    embeddingLedger: { path: join(tmp.dir, 'notes.jsonl'), approvedBy: 'system-automatic' },
  });
  let moved = 0;
  let maxBatchMs = 0;
  let slices = 0;
  let maxSliceMs = 0;
  let firstSliceMoves = 0;
  let lastSliceMoves = 0;
  while (moved < sample) {
    if (service) {
      const drain = service as unknown as { drainMoves(direction: 'lower'): Promise<{ moved: number; elapsedMs: number; timings: typeof timings }> };
      const report = await drain.drainMoves('lower');
      moved += report.moved;
      slices++;
      maxSliceMs = Math.max(maxSliceMs, report.elapsedMs);
      if (slices === 1) firstSliceMoves = report.moved;
      lastSliceMoves = report.moved;
      for (const key of Object.keys(timings) as Array<keyof typeof timings>) timings[key] += report.timings[key];
      if (!report.moved) throw new Error('Synthetic service drain made no progress');
      continue;
    }
    const sliceStarted = performance.now();
    slices++;
    do {
      const batchStarted = performance.now();
      if (mode === 'single') { await moveTieredItem(move(moved)); moved++; }
      else {
        const moves = Array.from({ length: Math.min(25, sample - moved) }, (_, n) => move(moved + n));
        let copied = 0;
        const results = moveTieredItemsLowering(moves, { shouldStop: () => copied++ > 0 && performance.now() - batchStarted >= 25 });
        if (results.some(result => 'error' in result)) throw new Error('Synthetic move failed');
        moved += results.length;
        await flushTierMoveNotes(f.ledger, { timings });
      }
      maxBatchMs = Math.max(maxBatchMs, performance.now() - batchStarted);
      await new Promise(resolve => setTimeout(resolve, 0));
    } while (moved < sample && performance.now() - sliceStarted < 1000);
  }
  const elapsed = performance.now() - started;
  if (process.env.MOVE_BENCH_TRACE === '1') console.log(JSON.stringify({ phase: 'measured_end', epoch_ms: Date.now() }));
  service?.stop(); installed?.close();
  const selectionStarted = performance.now();
  f.ledger.listMoving({ limit: 25, direction: 'raise' });
  const raiseSelectionMs = performance.now() - selectionStarted;
  console.log(JSON.stringify({ mode, old_notes: oldNotes, rows: count, sample: moved, elapsed_ms: Math.round(elapsed), slices,
    max_batch_ms: maxBatchMs, max_slice_ms: maxSliceMs, first_slice_moves: firstSliceMoves, last_slice_moves: lastSliceMoves, raise_selection_ms: raiseSelectionMs, moves_per_second: moved * 1000 / elapsed,
    steps_per_move: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v / moved])),
    per_move: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v / moved])) }));
} finally { f.close(); tmp.cleanup(); }
