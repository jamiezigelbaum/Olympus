import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import * as resolver from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import type { EmbeddingPrefilter } from '../src/workers/classification/embedding-prefilter.ts';
import { flushTierMoveNotes, moveTieredItem, moveTieredItemsLowering, type TierMoveOptions } from '../src/workers/connector-store/tier-move.ts';
import { readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openLegStore, openTierFixture, tempDir, type TierFixture } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const body = 'Synthetic orchard inventory.';
const lower = classifyItemTiers({ signals: { title: 'Synthetic' }, text: body });
const high = { ...lower, metadataTier: 'secure' as const, contentTier: 'secure' as const };

async function fixture(count = 4, privateOnly = false) {
  const tmp = tempDir('synthetic-move-batch-');
  let f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const specs = Array.from({ length: count }, (_, n) => ({ id: `synthetic-${n}`, name: 'Synthetic', text: body }));
  if (privateOnly) {
    // No Personal rows or copy markers from an earlier round trip may mask
    // the first batch's visibility behaviour.
    await f.stores.secure_local!.syncFromConnector(fixtureConnector(() => specs.map(spec => ({ ...spec, legacyDomain: 'secure_local' as const }))),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
  } else {
    await f.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  }
  for (const spec of specs) {
    if (privateOnly) f.ledger.recordRoutedPlacement(identityOf(spec.id), high, f.set.placementFor(high));
    else await moveTieredItem({ set: f.set, identity: identityOf(spec.id), target: high });
    f.ledger.recordRoutedPlacement(identityOf(spec.id), lower, f.set.placementFor(lower));
  }
  const moves = (): TierMoveOptions[] => specs.map(spec => ({
    set: f.set, identity: identityOf(spec.id), target: lower,
    embeddingLedger: { path: join(tmp.dir, 'notes.jsonl'), approvedBy: 'system-automatic' },
  }));
  return { get f() { return f; }, specs, moves,
    reopen() { f.close(); f = openTierFixture(tmp.dir, { embed: false }); },
  };
}

// Open just the ledger and Personal leg: opening a whole set can replay
// verified moves, which would hide an unsafe crash state from this check.
function personalHiddenCheck(f: TierFixture) {
  const ledger = new TierLedger({ dbPath: f.ledger.dbPath });
  const personal = openLegStore(f.paths, 'internal', ledger);
  cleanup.push(() => { personal.close(); ledger.close(); });
  return () => {
    expect(personal.searchItems('orchard', 20)).toEqual([]);
    for (let n = 0; n < 3; n++) {
      expect(personal.localContent(localId(`synthetic-${n}`))?.chunks ?? []).toEqual([]);
    }
  };
}

for (const step of ['beforeCopy', 'afterCopy', 'afterReceipt', 'afterCopiesCommitted', 'beforeFlip', 'afterVerified', 'afterFlip'] as const) {
  for (const recovery of ['abandon', 'resume'] as const) {
    test(`first Private lowering batch stays hidden at ${step}, then ${recovery}`, async () => {
      const f = await fixture(3, true);
      expect(f.f.ledger.corpusHasCopies(f.f.stores.internal!.corpusId)).toBe(false);
      expect(f.f.stores.secure_local!.searchItems('orchard', 20).length).toBe(3);
      const moves = f.moves();
      const expectHidden = personalHiddenCheck(f.f);
      let reached = 0;
      const interrupt = () => { reached++; throw new Error('Synthetic interruption'); };
      const spies: Array<{ mockRestore(): void }> = [];
      if (step === 'beforeCopy' || step === 'beforeFlip' || step === 'afterVerified') {
        moves[2]![step] = interrupt;
      } else if (step === 'afterCopy') {
        const store = f.f.stores.internal!;
        const original = store.importItemCopy.bind(store);
        spies.push(spyOn(store, 'importItemCopy').mockImplementation((...args) => {
          const result = original(...args);
          if (args[0].identity.providerItemId === f.specs[2]!.id) interrupt();
          return result;
        }));
      } else if (step === 'afterReceipt') {
        const original = f.f.ledger.writeMeta.bind(f.f.ledger);
        let receipts = 0;
        spies.push(spyOn(f.f.ledger, 'writeMeta').mockImplementation((...args) => {
          original(...args);
          if (args[0].startsWith('tier-move-verified:') && ++receipts === 3) interrupt();
        }));
      } else if (step === 'afterFlip') {
        const original = f.f.ledger.completeMove.bind(f.f.ledger);
        let flips = 0;
        spies.push(spyOn(f.f.ledger, 'completeMove').mockImplementation((...args) => {
          const result = original(...args);
          if (++flips === 2) interrupt();
          return result;
        }));
        // Roll back the whole flip transaction after the per-item failure.
        moves[2]!.beforeFlip = () => { throw new Error('Synthetic interruption'); };
      }
      try {
        expect(() => moveTieredItemsLowering(moves, {
          afterCopiesCommitted() {
            if (step === 'afterCopiesCommitted') interrupt();
            if (['beforeCopy', 'afterCopy', 'afterReceipt'].includes(step)) throw new Error('Synthetic interruption');
          },
        })).toThrow('Synthetic interruption');
      } finally { for (const spy of spies) spy.mockRestore(); }
      expect(reached).toBe(1);
      for (const spec of f.specs) expect(f.f.ledger.getCurrent(identityOf(spec.id))).toMatchObject({ state: 'moving', contentTier: 'secure' });
      expectHidden();
      personalHiddenCheck(f.f)();
      if (recovery === 'abandon') {
        for (const move of f.moves()) f.f.ledger.abandonMove(move.identity, { expectedGeneration: f.f.ledger.getCurrent(move.identity)!.generation });
        expectHidden();
        personalHiddenCheck(f.f)();
      } else {
        const retry = f.moves();
        for (const move of retry) move.beforeFlip = expectHidden;
        expect(moveTieredItemsLowering(retry).every(result => 'result' in result)).toBe(true);
        expect(f.f.stores.internal!.searchItems('orchard', 20).length).toBe(3);
      }
    });
  }
}

for (const retry of ['batch', 'single'] as const) {
  test(`abandoned batch destinations can be replaced after a source update (${retry} retry)`, async () => {
    const f = await fixture(3, true);
    expect(() => moveTieredItemsLowering(f.moves(), {
      afterCopiesCommitted() { throw new Error('Synthetic interruption'); },
    })).toThrow('Synthetic interruption');
    for (const move of f.moves()) {
      expect(f.f.stores.internal!.exportItemCopy(move.identity)!.chunks.map(chunk => chunk.boundedText).join('')).toBe(body);
      f.f.ledger.abandonMove(move.identity, { expectedGeneration: f.f.ledger.getCurrent(move.identity)!.generation });
      expect(f.f.ledger.copies(move.identity).find(copy => copy.corpusId === f.f.stores.internal!.corpusId))
        .toMatchObject({ state: 'superseded', supersededByGeneration: null });
    }
    personalHiddenCheck(f.f)();
    f.reopen();
    personalHiddenCheck(f.f)();

    const updatedBody = 'Synthetic orchard inventory updated with pears.';
    await f.f.stores.secure_local!.syncFromConnector(fixtureConnector(() => f.specs.map(spec => ({
      ...spec, text: updatedBody, version: 'v2', legacyDomain: 'secure_local' as const,
    }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const fresh = classifyItemTiers({ signals: { title: 'Synthetic' }, text: updatedBody });
    expect(fresh).toMatchObject({ metadataTier: 'private', contentTier: 'private', contentPending: false });
    for (const spec of f.specs) {
      expect(f.f.stores.secure_local!.localContent(localId(spec.id))?.chunks.join('')).toBe(updatedBody);
      f.f.ledger.recordRoutedPlacement(identityOf(spec.id), fresh, f.f.set.placementFor(fresh));
    }
    // Without replacement authority the older hidden text is still protected.
    for (const result of moveTieredItemsLowering(f.moves())) {
      expect(result).toHaveProperty('error');
      if ('error' in result) expect(String(result.error)).toContain('owner-approved');
    }
    personalHiddenCheck(f.f)();
    const moves = f.moves().map(move => ({
      ...move, replaceOwnSupersededCopy: true,
      beforeFlip: () => {
        expect(f.f.stores.internal!.localContent(localId(move.identity.providerItemId))?.chunks ?? []).toEqual([]);
      },
    }));
    if (retry === 'batch') {
      const results = moveTieredItemsLowering(moves);
      expect(results).toHaveLength(f.specs.length);
      for (const result of results) expect(result).toHaveProperty('result');
    } else {
      for (const move of moves) await moveTieredItem(move);
    }
    expect(f.f.ledger.listMoving()).toEqual([]);
    expect(f.f.stores.internal!.searchItems('pears', 20)).toHaveLength(f.specs.length);
    for (const spec of f.specs) {
      expect(f.f.ledger.getCurrent(identityOf(spec.id))).toMatchObject({ state: 'current', contentTier: 'private' });
      expect(f.f.stores.internal!.localContent(localId(spec.id))?.chunks.join('')).toBe(updatedBody);
    }
    await flushTierMoveNotes(f.f.ledger);
    const notes = (await readEmbeddingLedger(join(f.f.dir, 'notes.jsonl'))).entries
      .filter(note => note.entry_id?.startsWith('tier-move:'));
    expect(notes).toHaveLength(f.specs.length);
    expect(notes.every(note => note.what.includes('1 chunk(s) of older text'))).toBe(true);
  });
}

function serviceFor(f: TierFixture, autoMoves: Partial<NonNullable<ConstructorParameters<typeof TierSnifferService>[0]['autoMoves']>> = {}, otherSets: TierFixture[] = [], serviceOptions: Partial<ConstructorParameters<typeof TierSnifferService>[0]> = {}) {
  const installed = new InstalledTierClassification({ env: {} });
  const lines: string[] = [];
  const service = new TierSnifferService({
    installed, lane: BUILT_IN_SNIFFER_LANE, model: { async complete() { throw new Error('No model expected'); } },
    modelAvailable: () => false, stores: () => [f, ...otherSets].flatMap(set => set.set.openStores()),
    classificationLedgerPath: join(f.dir, 'classification.jsonl'),
    log: line => lines.push(line),
    ...serviceOptions,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(f.dir, 'notes.jsonl'), ...autoMoves },
  });
  cleanup.push(() => { service.stop(); installed.close(); });
  return { service, lines };
}

test('validation defers timer retries of failed raises, but new raises still run and failures retry afterward', async () => {
  const f = await fixture(0);
  const specs = ['stuck-raise', 'new-raise'].map(id => ({ id, name: 'Synthetic', text: body }));
  await f.f.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const { service } = serviceFor(f.f, {}, [], { intervalMs: 1 });
  const runtime = service as unknown as {
    trainingJudge: string; embeddingPrefilters: Map<string, EmbeddingPrefilter>; moving?: Promise<unknown>;
    drainMoves(): Promise<unknown>; finishTrainingValidation(signal: AbortSignal): Promise<void>;
  };
  let failures = 0;
  const originalCopy = f.f.stores.secure_local!.importItemCopy.bind(f.f.stores.secure_local!);
  const copy = spyOn(f.f.stores.secure_local!, 'importItemCopy').mockImplementation((...args) => {
    if (args[0].identity.providerItemId === 'stuck-raise') { failures++; throw new Error('Synthetic stuck raise'); }
    return originalCopy(...args);
  });
  const wake = spyOn(service, 'wake').mockImplementation(() => {});
  const run = spyOn(service, 'runOnce').mockResolvedValue({ state: 'skipped_running' });
  let pulse!: () => void;
  const originalInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
    expect(ms).toBe(1); pulse = callback;
    return originalInterval(() => {}, 60_000);
  }) as typeof setInterval);
  try { service.start(); } finally { interval.mockRestore(); }
  try {
    f.f.ledger.recordRoutedPlacement(identityOf('stuck-raise'), high, f.f.set.placementFor(high));
    await runtime.drainMoves();
    expect(failures).toBe(1);
    const filter = { trainingOwner: undefined as unknown as EmbeddingPrefilter, trainingFinalizing: true,
      async finishValidation() {
        const marker = f.f.ledger.changeMarker(true);
        for (let n = 0; n < 3; n++) { pulse(); await runtime.moving; }
        expect(failures).toBe(1);
        expect(f.f.ledger.changeMarker(true)).toBe(marker);
        f.f.ledger.recordRoutedPlacement(identityOf('new-raise'), high, f.f.set.placementFor(high));
        pulse(); await runtime.moving;
        expect(f.f.ledger.getCurrent(identityOf('new-raise'))).toMatchObject({ state: 'current', contentTier: 'secure' });
      } };
    filter.trainingOwner = filter as unknown as EmbeddingPrefilter;
    runtime.embeddingPrefilters.set(f.f.ledger.dbPath, filter as unknown as EmbeddingPrefilter);
    runtime.trainingJudge = 'synthetic';
    await runtime.finishTrainingValidation(new AbortController().signal);
    const before = failures;
    await runtime.drainMoves();
    expect(failures).toBe(before + 1);
    expect(f.f.ledger.getCurrent(identityOf('stuck-raise'))?.state).toBe('moving');
    expect(f.f.stores.internal!.localContent(localId('stuck-raise'))?.chunks ?? []).toEqual([]);
  } finally { service.stop(); copy.mockRestore(); wake.mockRestore(); run.mockRestore(); }
});

for (const interrupt of ['copies', 'flips'] as const) test(`interrupted lowering batch resumes after durable ${interrupt}, with one note per move`, async () => {
  const f = await fixture();
  if (interrupt === 'copies') {
    expect(() => moveTieredItemsLowering(f.moves(), { afterCopiesCommitted() { throw new Error('Synthetic interruption'); } })).toThrow();
  } else {
    const moves = f.moves();
    moves[2]!.afterVerified = () => { throw new Error('Synthetic interruption'); };
    expect(() => moveTieredItemsLowering(moves)).toThrow();
  }
  for (const spec of f.specs) {
    // Even copies committed before the ledger receipt are never released.
    expect(f.f.ledger.getCurrent(identityOf(spec.id))?.state).toBe('moving');
    expect(f.f.stores.internal!.localContent(localId(spec.id))?.chunks ?? []).toEqual([]);
    expect(f.f.stores.secure_local!.exportItemCopy(identityOf(spec.id))!.chunks.map(c => c.boundedText).join('')).toBe(body);
  }
  f.reopen();
  // Opening a set may already replay its durable receipts in maintenance.
  const pending = f.moves().filter(move => f.f.ledger.getCurrent(move.identity)?.state === 'moving');
  const results = moveTieredItemsLowering(pending);
  expect(results.length).toBe(pending.length);
  expect(results.every(result => 'result' in result)).toBe(true);
  await flushTierMoveNotes(f.f.ledger);
  await flushTierMoveNotes(f.f.ledger);
  const notes = (await readEmbeddingLedger(join(f.f.dir, 'notes.jsonl'))).entries.filter(entry => entry.entry_id?.startsWith('tier-move:'));
  expect(notes.length).toBe(f.specs.length);
  for (const spec of f.specs) {
    expect(f.f.ledger.getCurrent(identityOf(spec.id))?.state).toBe('current');
    expect(f.f.stores.internal!.localContent(localId(spec.id))?.chunks.join('')).toBe(body);
  }
});

test('every destination stays fenced until the whole flip batch commits', async () => {
  const f = await fixture();
  const other = new Database(f.f.paths.internal);
  other.exec('PRAGMA busy_timeout = 1');
  const moves = f.moves();
  let checked = false;
  moves[1]!.afterVerified = () => {
    // The first flip's individual fence has returned. Its destination still
    // cannot change while the outer ledger transaction has not committed.
    expect(() => other.query('UPDATE items SET title = ? WHERE local_item_id = ?')
      .run('Synthetic edit', localId(f.specs[0]!.id))).toThrow();
    checked = true;
  };
  try { expect(moveTieredItemsLowering(moves).every(result => 'result' in result)).toBe(true); }
  finally { other.close(); }
  expect(checked).toBe(true);
});

test('a refused stale lowering cannot prevent its batch neighbours from landing', async () => {
  const f = await fixture();
  const copy = f.f.stores.secure_local!.exportItemCopy(identityOf(f.specs[1]!.id))!;
  f.f.stores.secure_local!.importItemCopy({ ...copy, chunks: copy.chunks.map(chunk => ({ ...chunk, boundedText: 'Synthetic changed body.' })) },
    { trustTier: 'S4', syncConnectorId: 'synthetic-edit' });
  const results = moveTieredItemsLowering(f.moves());
  expect(results.map(result => 'result' in result)).toEqual([true, false, true, true]);
  expect(f.f.stores.internal!.localContent(localId(f.specs[1]!.id))?.chunks ?? []).toEqual([]);
});

test('a hide-first raise beats a lowering backlog even with a zero lowering slice', async () => {
  const f = await fixture(40);
  const raised = { id: 'synthetic-raise', name: 'Synthetic', text: body };
  await f.f.set.sync(fixtureConnector(() => [raised], { id: 'synthetic-new' }), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  f.f.ledger.recordRoutedPlacement(identityOf(raised.id), high, f.f.set.placementFor(high));
  expect(f.f.stores.internal!.localContent(localId(raised.id))?.chunks ?? []).toEqual([]);
  const { service } = serviceFor(f.f, { lowerSliceMs: 0 });
  await service.runOnce();
  expect(f.f.ledger.getCurrent(identityOf(raised.id))).toMatchObject({ state: 'current', contentTier: 'secure' });
  expect(f.f.ledger.listMoving({ limit: 100 }).length).toBe(40);
});

test('lowering slices stop before starting another item, and yield between bounded batches', async () => {
  const f = await fixture(12);
  const { service, lines } = serviceFor(f.f, { lowerBatchSize: 2, lowerBatchMs: 0, maxPerPass: 5 });
  let imports = 0;
  let importsAtYield = -1;
  const original = f.f.stores.internal!.importItemCopy.bind(f.f.stores.internal!);
  const spy = spyOn(f.f.stores.internal!, 'importItemCopy').mockImplementation((...args) => {
    imports++;
    if (imports === 1) setTimeout(() => { importsAtYield = imports; }, 0);
    return original(...args);
  });
  try { await service.runOnce(); } finally { spy.mockRestore(); }
  expect(imports).toBe(5);
  expect(importsAtYield).toBeGreaterThan(0);
  expect(importsAtYield).toBeLessThan(5);
  expect(f.f.ledger.listMoving({ limit: 100 }).length).toBe(7);
  expect(lines.some(line => /direction=lower.*export_ms=\d+.*stage_ms=\d+.*copy_ms=\d+.*vectors_ms=\d+.*verify_ms=\d+.*flip_ms=\d+.*purge_ms=\d+.*reread_ms=\d+.*notes_ms=\d+/.test(line))).toBe(true);
  expect(lines.every(line => !line.includes('synthetic-') && !line.includes(body))).toBe(true);
});

test('a lowering deadline expires without consuming the next queued item', async () => {
  const f = await fixture();
  let stop = false;
  const moves = f.moves();
  moves[0]!.beforeCopy = () => { stop = true; };
  const results = moveTieredItemsLowering(moves, { shouldStop: () => stop });
  expect(results.length).toBe(1);
  expect(f.f.ledger.listMoving().length).toBe(3);
  expect(moveTieredItemsLowering(f.moves().slice(1), { shouldStop: () => true })).toEqual([]);
});

test('the service stops its lowering slice at the deadline after an indivisible copy', async () => {
  const f = await fixture();
  const { service, lines } = serviceFor(f.f, { lowerSliceMs: 50, lowerBatchMs: 1000 });
  let clock = 0;
  let imports = 0;
  const time = spyOn(performance, 'now').mockImplementation(() => clock);
  const original = f.f.stores.internal!.importItemCopy.bind(f.f.stores.internal!);
  const copy = spyOn(f.f.stores.internal!, 'importItemCopy').mockImplementation((...args) => {
    imports++;
    clock += 60;
    return original(...args);
  });
  try { await service.runOnce(); } finally { copy.mockRestore(); time.mockRestore(); }
  expect(imports).toBe(1);
  expect(f.f.ledger.listMoving().length).toBe(3);
  expect(lines.some(line => line.includes('direction=lower elapsed_ms=60'))).toBe(true);
  // Notes not flushed before the deadline remain a durable obligation.
  expect(f.f.ledger.metaEntries('tier-move-note:').length).toBe(1);
});

test('raises are refused by the lowering batch and retain hide-first protection', async () => {
  const f = await fixture(1);
  moveTieredItemsLowering(f.moves());
  f.f.ledger.recordRoutedPlacement(identityOf(f.specs[0]!.id), high, f.f.set.placementFor(high));
  const results = moveTieredItemsLowering([{ ...f.moves()[0]!, target: high }]);
  expect(results[0]).toHaveProperty('error');
  expect(f.f.stores.internal!.localContent(localId(f.specs[0]!.id))?.chunks ?? []).toEqual([]);
  await moveTieredItem({ ...f.moves()[0]!, target: high });
  expect(f.f.ledger.getCurrent(identityOf(f.specs[0]!.id))?.state).toBe('current');
});

test('pending metadata survives upgrade, acknowledgement and reopen beside completed history', () => {
  const tmp = tempDir('synthetic-move-metadata-');
  const path = join(tmp.dir, 'ledger.sqlite');
  let ledger = new TierLedger({ dbPath: path });
  cleanup.push(() => { ledger.close(); tmp.cleanup(); });
  ledger.withMoveBatch(() => {
    for (let n = 0; n < 1000; n++) ledger.writeMeta(`tier-move-note:completed-${n}`, '');
    ledger.writeMeta('tier-move-note:pending-a', 'synthetic-a');
    ledger.writeMeta('tier-move-note:pending-b', 'synthetic-b');
  });
  expect(ledger.metaEntries('tier-move-note:', { limit: 1 })).toEqual([{ key: 'tier-move-note:pending-a', value: 'synthetic-a' }]);
  ledger.writeMeta('tier-move-note:pending-a', '');
  ledger.close();
  ledger = new TierLedger({ dbPath: path });
  expect(ledger.metaEntries('tier-move-note:')).toEqual([{ key: 'tier-move-note:pending-b', value: 'synthetic-b' }]);
  expect(ledger.readMeta('tier-move-note:completed-0')).toBe('');
});


test('raise and lower drains rotate stores independently under a one-item budget', async () => {
  const first = await fixture();
  const second = await fixture();
  const { service } = serviceFor(first.f, { maxPerPass: 1 }, [second.f]);
  for (let pass = 0; pass < 4; pass++) await service.runOnce();
  expect(first.f.ledger.listMoving().length).toBe(2);
  expect(second.f.ledger.listMoving().length).toBe(2);
});

for (const [passMs, fail] of [[18_000, false], [18_000, true], [300_000, false]] as const) test(`large backlog gets a capped adaptive slice; judge=${passMs}, failed copy=${fail}`, async () => {
  const f = await fixture(500, true);
  const { service, lines } = serviceFor(f.f, {}, [], {
    passTimeMs: passMs, modelAvailable: () => true, autoApproveBuiltIn: true, rejudgePerPass: 0,
  });
  let clock = 0;
  let imports = 0;
  const time = spyOn(performance, 'now').mockImplementation(() => clock);
  const original = f.f.stores.internal!.importItemCopy.bind(f.f.stores.internal!);
  const pass = spyOn(resolver, 'runSnifferPass').mockImplementation(async options => {
    expect(options.passTimeMs).toBe(passMs);
    expect(imports).toBe(0);
    clock += passMs;
    return { clearing: { tried: 3, cleared: 0, spotChecks: 0, skipped: { model_missing: 1, disabled: 2 } }, calls: 0, verdictsApplied: 0, heldLowering: 0 } as Awaited<ReturnType<typeof resolver.runSnifferPass>>;
  });
  const copy = spyOn(f.f.stores.internal!, 'importItemCopy').mockImplementation((...args) => {
    clock += 100;
    if (++imports === 3 && fail) throw new Error('Synthetic copy failure');
    return original(...args);
  });
  try { await service.runOnce(); expect(pass).toHaveBeenCalledTimes(1); }
  finally { copy.mockRestore(); time.mockRestore(); pass.mockRestore(); }
  // 6 s is one quarter of an 18 s judge + 6 s moves tick. The old 1 s
  // slice only starts ten copies at this synthetic cost.
  const expectedCopies = passMs === 18_000 ? 60 : 100;
  const expectedSlice = expectedCopies * 100;
  expect(imports).toBe(expectedCopies);
  expect(clock).toBe(passMs + expectedSlice);
  expect(f.f.ledger.listMoving({ limit: 1000 })).toHaveLength(500 - expectedCopies + Number(fail));
  if (fail) {
    expect(f.f.ledger.moveAttempts(identityOf('synthetic-2'))).toBe(1);
    expect(f.f.stores.internal!.localContent(localId('synthetic-2'))?.chunks ?? []).toEqual([]);
    expect(f.f.stores.secure_local!.localContent(localId('synthetic-2'))?.chunks.join('')).toBe(body);
  }
  expect(lines.some(line => line.includes(`direction=lower elapsed_ms=${expectedSlice} backlog=500 slice_ms=${expectedSlice}`))).toBe(true);
  expect(lines.some(line => line.includes('clearing: tried=3 cleared=0 spot_checks=0 skipped{disabled=2,model_missing=1}'))).toBe(true);
  expect(lines.every(line => !line.includes('synthetic-') && !line.includes(body))).toBe(true);
}, 15_000);

for (const count of [0, 4]) test(`backlog ${count} preserves the judge's full budget`, async () => {
  const f = await fixture(count, true);
  const pass = spyOn(resolver, 'runSnifferPass').mockImplementation(async options => {
    expect(options.passTimeMs).toBe(18_000);
    return { clearing: { tried: 0, cleared: 0, spotChecks: 0, skipped: {} }, calls: 0, verdictsApplied: 0 } as Awaited<ReturnType<typeof resolver.runSnifferPass>>;
  });
  const { service, lines } = serviceFor(f.f, {}, [], {
    passTimeMs: 18_000, modelAvailable: () => true, autoApproveBuiltIn: true, rejudgePerPass: 0,
  });
  try { await service.runOnce(); expect(pass).toHaveBeenCalledTimes(1); }
  finally { pass.mockRestore(); }
  expect(f.f.ledger.listMoving()).toHaveLength(0);
  expect(lines.some(line => line.includes(`backlog=${count} slice_ms=1000`))).toBe(true);
});

test('move note flush uses one durable append per path and retries without duplicates', async () => {
  const f = await fixture();
  moveTieredItemsLowering(f.moves());
  const original = fs.open;
  let appends = 0;
  const opened = spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof fs.open>) => {
    if (args[1] === 'a+') appends++;
    return original(...args);
  });
  try { await flushTierMoveNotes(f.f.ledger); await flushTierMoveNotes(f.f.ledger); }
  finally { opened.mockRestore(); }
  expect(appends).toBe(1);
  expect(f.f.ledger.metaEntries('tier-move-note:')).toHaveLength(0);
  const notes = await readEmbeddingLedger(join(f.f.dir, 'notes.jsonl'));
  expect(notes.entries.filter(note => note.entry_id?.startsWith('tier-move:'))).toHaveLength(4);
});

test('failed grouped note fsync keeps obligations, and malformed notes do not block neighbours', async () => {
  const f = await fixture();
  moveTieredItemsLowering(f.moves());
  f.f.ledger.writeMeta('tier-move-note:bad', JSON.stringify({ path: join(f.f.dir, 'notes.jsonl'), entry: null }));
  const original = fs.open;
  const opened = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[1] === 'a+') spyOn(handle, 'sync').mockImplementation(async () => { throw new Error('Synthetic fsync failure'); });
    return handle;
  });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await flushTierMoveNotes(f.f.ledger);
    expect(f.f.ledger.metaEntries('tier-move-note:')).toHaveLength(5);
    opened.mockRestore();
    await flushTierMoveNotes(f.f.ledger);
    expect(f.f.ledger.metaEntries('tier-move-note:')).toHaveLength(1);
    const notes = await readEmbeddingLedger(join(f.f.dir, 'notes.jsonl'));
    expect(notes.entries.filter(note => note.entry_id?.startsWith('tier-move:'))).toHaveLength(4);
  } finally { opened.mockRestore(); warn.mockRestore(); }
});

for (const state of ['none', 'new', 'ineligible'] as const) test(`timer preempts lowerings only for eligible new raises: ${state}`, async () => {
  const f = await fixture(100, true);
  const raising = state === 'ineligible' ? await fixture(0) : f;
  const raised = { id: 'synthetic-timer-raise', name: 'Synthetic', text: body };
  await raising.f.set.sync(fixtureConnector(() => [raised], { id: 'synthetic-timer-new' }), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const { service } = serviceFor(f.f, { lowerSliceMs: 6000 }, state === 'ineligible' ? [raising.f] : [], { passTimeMs: 18_000 });
  const authority = state === 'ineligible'
    ? spyOn(raising.f.stores.secure_local!, 'embeddingAuthorities').mockReturnValue([
      { provider: 'synthetic-external', modelId: 'synthetic', backend: 'local', dimension: 1, epochId: 'synthetic' },
    ]) : undefined;
  let pulse!: () => void;
  const originalInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    pulse = callback;
    return originalInterval(() => {}, 60_000);
  }) as typeof setInterval);
  try { service.start(); } finally { interval.mockRestore(); }
  let clock = 0;
  let imports = 0;
  let pulsed = false;
  const time = spyOn(performance, 'now').mockImplementation(() => clock);
  const original = f.f.stores.internal!.importItemCopy.bind(f.f.stores.internal!);
  const copy = spyOn(f.f.stores.internal!, 'importItemCopy').mockImplementation((...args) => {
    clock += 100;
    if (++imports === 1) setTimeout(() => {
      if (state !== 'none') raising.f.ledger.recordRoutedPlacement(identityOf(raised.id), high, raising.f.set.placementFor(high));
      pulsed = true;
      pulse(); // Run the real start() timer callback while the slice yields.
    }, 0);
    return original(...args);
  });
  try {
    await service.runOnce();
    // Wait for the timer's raise request too, if it preempted the lowering.
    await (service as unknown as { drainMoves(): Promise<unknown> }).drainMoves();
  } finally { service.stop(); copy.mockRestore(); time.mockRestore(); authority?.mockRestore(); }
  expect(pulsed).toBe(true);
  if (state === 'new') {
    expect(imports).toBeLessThan(60);
    expect(f.f.ledger.getCurrent(identityOf(raised.id))).toMatchObject({ state: 'current', contentTier: 'secure' });
  } else {
    expect(imports).toBe(60);
    if (state === 'ineligible') expect(raising.f.ledger.getCurrent(identityOf(raised.id))?.state).toBe('moving');
  }
}, 15_000);

test('timer preempts only for a raise the next drain takes under the shared budget (#1013)', async () => {
  const stuck = await fixture(0);
  const fresh = await fixture(0);
  const failing = ['stuck-a', 'stuck-b'].map(id => ({ id, name: 'Synthetic', text: body }));
  await stuck.f.set.sync(fixtureConnector(() => failing), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const raised = { id: 'fresh-raise', name: 'Synthetic', text: body };
  await fresh.f.set.sync(fixtureConnector(() => [raised], { id: 'synthetic-fresh' }), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  for (const spec of failing) stuck.f.ledger.recordRoutedPlacement(identityOf(spec.id), high, stuck.f.set.placementFor(high));
  const { service } = serviceFor(stuck.f, { maxPerPass: 2 }, [fresh.f]);
  const runtime = service as unknown as { drainMoves(): Promise<unknown>; newRaisesQueued(): boolean };
  const copy = spyOn(stuck.f.stores.secure_local!, 'importItemCopy').mockImplementation(() => { throw new Error('Synthetic stuck raise'); });
  try {
    // Two drains: the first set leads, then the second; the next leads with the first again.
    await runtime.drainMoves();
    await runtime.drainMoves();
    fresh.f.ledger.recordRoutedPlacement(identityOf(raised.id), high, fresh.f.set.placementFor(high));
    // The known failures fill the whole budget first, so no preemption.
    expect(runtime.newRaisesQueued()).toBe(false);
    await runtime.drainMoves();
    expect(fresh.f.ledger.getCurrent(identityOf(raised.id))?.state).toBe('moving');
    // Rotation now puts the new raise first, and the drain takes it.
    expect(runtime.newRaisesQueued()).toBe(true);
    await runtime.drainMoves();
    expect(fresh.f.ledger.getCurrent(identityOf(raised.id))).toMatchObject({ state: 'current', contentTier: 'secure' });
  } finally { copy.mockRestore(); }
});

test('a failed backlog count does not block other ledgers', async () => {
  const first = await fixture();
  const second = await fixture();
  const { service } = serviceFor(first.f, {}, [second.f]);
  const count = spyOn(first.f.ledger, 'countMoving').mockImplementation(() => { throw new Error('Synthetic unreadable count'); });
  try { await service.runOnce(); } finally { count.mockRestore(); }
  expect(second.f.ledger.listMoving()).toHaveLength(0);
});

for (const passTimeMs of [0, NaN]) test(`disabled or invalid judge budget keeps moves bounded: ${passTimeMs}`, async () => {
  const f = await fixture(100, true);
  const { service } = serviceFor(f.f, { lowerSliceMs: NaN }, [], { passTimeMs });
  let clock = 0;
  let imports = 0;
  const time = spyOn(performance, 'now').mockImplementation(() => clock);
  const original = f.f.stores.internal!.importItemCopy.bind(f.f.stores.internal!);
  const copy = spyOn(f.f.stores.internal!, 'importItemCopy').mockImplementation((...args) => {
    imports++;
    clock += 100;
    return original(...args);
  });
  try { await service.runOnce(); } finally { copy.mockRestore(); time.mockRestore(); }
  expect(imports).toBe(25);
  expect(clock).toBe(2500);
});

test('a failed raise is retried ahead of lowerings without repeatedly cutting their slice', async () => {
  const f = await fixture(100, true);
  const raised = { id: 'synthetic-stuck-raise', name: 'Synthetic', text: body };
  await f.f.set.sync(fixtureConnector(() => [raised], { id: 'synthetic-stuck-new' }), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  f.f.ledger.recordRoutedPlacement(identityOf(raised.id), high, f.f.set.placementFor(high));
  const { service } = serviceFor(f.f, { lowerSliceMs: 6000 }, [], { passTimeMs: 18_000 });
  let pulse!: () => void;
  const originalInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    pulse = callback;
    return originalInterval(() => {}, 60_000);
  }) as typeof setInterval);
  try { service.start(); } finally { interval.mockRestore(); }
  let clock = 0;
  let imports = 0;
  let raises = 0;
  const time = spyOn(performance, 'now').mockImplementation(() => clock);
  const original = f.f.stores.internal!.importItemCopy.bind(f.f.stores.internal!);
  const copy = spyOn(f.f.stores.internal!, 'importItemCopy').mockImplementation((...args) => {
    expect(raises).toBeGreaterThan(0);
    clock += 100;
    if (++imports === 1) setTimeout(pulse, 0);
    return original(...args);
  });
  const raiseCopy = spyOn(f.f.stores.secure_local!, 'importItemCopy').mockImplementation(() => {
    raises++;
    throw new Error('Synthetic stuck raise');
  });
  try { await service.runOnce(); }
  finally { service.stop(); copy.mockRestore(); raiseCopy.mockRestore(); time.mockRestore(); }
  expect(imports).toBe(60);
  expect(f.f.ledger.getCurrent(identityOf(raised.id))?.state).toBe('moving');
  expect(f.f.stores.internal!.localContent(localId(raised.id))?.chunks ?? []).toEqual([]);
}, 15_000);

test('the backlog counts queued lowerings that automatic moves will run, never raises', async () => {
  const f = await fixture(3, true);
  expect(f.f.ledger.listMoving({ direction: 'lower' })).toHaveLength(3);
  // Judged Personal, still in Private until the move: out of a remote agent's reach.
  expect(serviceFor(f.f).service.backlog()).toMatchObject({ pendingItems: 0, lowerMovesQueued: 3 });
  // A move left for the owner's approval is not "still checking".
  expect(serviceFor(f.f, { localEmbeddingsOnly: () => false }).service.backlog().lowerMovesQueued).toBe(0);
  for (const move of f.moves()) await moveTieredItem(move);
  const service = serviceFor(f.f).service;
  expect(service.backlog().lowerMovesQueued).toBe(0);
  for (const spec of f.specs) f.f.ledger.recordRoutedPlacement(identityOf(spec.id), high, f.f.set.placementFor(high));
  expect(f.f.ledger.listMoving({ direction: 'raise' })).toHaveLength(3);
  expect(serviceFor(f.f).service.backlog().lowerMovesQueued).toBe(0);
});

test('reads within a minute reuse the lowering count instead of counting again', async () => {
  const f = await fixture(3, true);
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const { service } = serviceFor(f.f, {}, [], { now: () => new Date(clock) });
  expect(service.backlog().lowerMovesQueued).toBe(3);
  // The moves land, but every read inside the minute is served the counted value: no query per search.
  for (const move of f.moves()) await moveTieredItem(move);
  for (let read = 0; read < 5; read++) expect(service.backlog().lowerMovesQueued).toBe(3);
  clock += 59_000;
  expect(service.backlog().lowerMovesQueued).toBe(3);
  clock += 2_000;
  expect(service.backlog().lowerMovesQueued).toBe(0);
});

test('a cached zero lowering count is not reused once a pending item is queued to lower (#1121)', async () => {
  const f = await fixture(1, true);
  for (const move of f.moves()) await moveTieredItem(move);
  const id = identityOf(f.specs[0]!.id);
  // Back in Private and waiting on the judge: nothing is queued to lower yet.
  await moveTieredItem({ set: f.f.set, identity: id, target: high });
  const pending = { ...high, contentPending: true, state: 'pending' as const };
  f.f.ledger.recordRoutedPlacement(id, pending, f.f.set.placementFor(pending));
  const clock = createTestClock();
  const { service } = serviceFor(f.f, {}, [], { now: () => clock.date() });
  expect(service.backlog()).toMatchObject({ pendingItems: 1, lowerMovesQueued: 0 });
  // Judged Personal inside the cache window: pending reaches 0 and the
  // item waits in Private for its move. The note must not drop.
  await clock.advance(5_000);
  f.f.ledger.recordRoutedPlacement(id, lower, f.f.set.placementFor(lower));
  expect(f.f.ledger.getCurrent(id)).toMatchObject({ state: 'moving' });
  expect(service.backlog()).toMatchObject({ pendingItems: 0, lowerMovesQueued: 1 });
  // Once counted, reads in the window reuse that count again.
  for (const move of f.moves()) await moveTieredItem(move);
  expect(service.backlog().lowerMovesQueued).toBe(1);
});
