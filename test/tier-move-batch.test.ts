import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { flushTierMoveNotes, moveTieredItem, moveTieredItemsLowering, type TierMoveOptions } from '../src/workers/connector-store/tier-move.ts';
import { readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
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
    const notes = (await readEmbeddingLedger(join(f.f.dir, 'notes.jsonl'))).entries;
    expect(notes).toHaveLength(f.specs.length);
    expect(notes.every(note => note.what.includes('1 chunk(s) of older text'))).toBe(true);
  });
}

function serviceFor(f: TierFixture, autoMoves: Partial<NonNullable<ConstructorParameters<typeof TierSnifferService>[0]['autoMoves']>> = {}, otherSets: TierFixture[] = []) {
  const installed = new InstalledTierClassification({ env: {} });
  const lines: string[] = [];
  const service = new TierSnifferService({
    installed, lane: BUILT_IN_SNIFFER_LANE, model: { async complete() { throw new Error('No model expected'); } },
    modelAvailable: () => false, stores: () => [f, ...otherSets].flatMap(set => set.set.openStores()),
    classificationLedgerPath: join(f.dir, 'classification.jsonl'),
    log: line => lines.push(line),
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(f.dir, 'notes.jsonl'), ...autoMoves },
  });
  cleanup.push(() => { service.stop(); installed.close(); });
  return { service, lines };
}

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
