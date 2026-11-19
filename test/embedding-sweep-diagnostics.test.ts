// Counts-only diagnostics over synthetic stores. No live data or identifiers in logs.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { EMBEDDING_SWEEP_IDLE_BACKOFF_ENV, EMBEDDING_SWEEP_IDLE_FULL_PASS_MS, SourceScheduler, withEmbeddingSweep } from '../src/workers/source-scheduler.ts';
import { TransientSourceEmbeddingError } from '../src/workers/source-index/embeddings.ts';
import { FileLeaseBusyError } from '../src/core/file-lease.ts';
import { EMBEDDING_SWEEP_IDLE_SUFFIX } from '../src/core/embedding-sweep-idle.ts';
import { createStandBack, STAND_BACK_MAX_MS, STAND_BACK_SHARE_MS, type BackgroundWalkPause } from '../src/workers/engine/stand-back.ts';
import { createExclusiveRunner, guardAccountBoundLanes } from '../src/workers/source-account-guard.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, localProvider, RecordingProvider, tempDir } from './helpers/tier-fixtures.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture(options: {
  accountScope?: string;
  empty?: boolean;
  pauseForAsk?: BackgroundWalkPause;
  onWindow?: (walk: 'inventory' | 'workList', count: number) => void;
  guard?: ReturnType<typeof createExclusiveRunner>;
  onSync?: () => void;
} = {}) {
  const tmp = tempDir();
  const dbPath = `${tmp.dir}/private.sqlite`;
  const open = (provider: RecordingProvider) => {
    const ledger = new TierLedger({ dbPath: `${tmp.dir}/tiers.sqlite` });
    const secrets = new SecretLocationsIndex({ dbPath: `${tmp.dir}/secrets.sqlite` });
    const personal = new LocalConnectorStore({ dbPath: `${tmp.dir}/personal.sqlite`, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: ledger });
    const store = new LocalConnectorStore({ dbPath, corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local', tierLedger: ledger });
    const set = new TieredStoreSet({ setId: 'synthetic', ledger, secretLocations: secrets,
      tierClassification: { holdContentUntilJudged: true, sniffer: { id: 'synthetic', judge: () => ({ verdict: 'undecided', queued: true }) } },
      legs: [
        { trustDomain: 'internal', corpusId: personal.corpusId, store: personal, embeddingProvider: provider },
        { trustDomain: 'secure_local', corpusId: store.corpusId, store, embeddingProvider: provider },
      ],
    });
    return { ledger, store, personal, provider, set, close: () => { personal.close(); store.close(); secrets.close(); ledger.close(); } };
  };
  let runtime = open(localProvider());
  cleanups.push(() => { runtime.close(); tmp.cleanup(); });
  if (!options.empty) {
    await runtime.set.sync(fixtureConnector(() => [{ id: 'synthetic-id', name: 'synthetic-name.txt', text: 'Synthetic body marker.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  }
  const log = spyOn(console, 'info').mockImplementation(() => {});
  cleanups.push(() => log.mockRestore());
  let now = new Date('2026-11-07T15:00:00Z');
  const createScheduler = () => {
    const { store, provider } = runtime;
    const tasks = options.onSync ? [{
      id: 'synthetic_sync', kind: 'sync' as const, writer: true as const,
      async run() { options.onSync?.(); return { status: 'idle' as const }; },
    }] : [];
    let sources = withEmbeddingSweep([{ sourceId: 'synthetic-source-id', corpusId: store.corpusId, cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 24, tasks }], () => () => [{
      store, provider, wholeStore: true, ...(options.accountScope !== undefined ? { accountScope: options.accountScope } : {}),
    }], options.pauseForAsk ? { pauseForAsk: options.pauseForAsk } : {});
    if (options.guard) sources = guardAccountBoundLanes(sources, new Map([['synthetic-source-id', { run: options.guard, assertAccount: async () => {} }]]));
    return new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 1_000, maxTransientRetries: 1, sources, now: () => now });
  };
  let scheduler = createScheduler();
  const restart = (provider = localProvider(), whileClosed?: () => void) => {
    runtime.close();
    whileClosed?.();
    runtime = open(provider);
    scheduler = createScheduler();
  };
  const walks = { inventory: 0, workList: 0 };
  const pass = async () => {
    log.mockClear();
    walks.inventory = 0;
    walks.workList = 0;
    setReadPoolObserverForTests((path, read) => {
      if (path !== dbPath || !read.sql.includes('c.chunk_pk > ? AND c.chunk_pk <= ?')) return;
      const walk = read.sql.includes('AS in_scope') ? 'inventory' : read.sql.includes('AS first_chunk_pk') ? 'workList' : undefined;
      if (walk) {
        walks[walk]++;
        options.onWindow?.(walk, walks[walk]);
      }
    }, { snapshots: true });
    const status = await scheduler.runDueTasks().finally(() => setReadPoolObserverForTests());
    const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[olympus:embedding-sweep] '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/synthetic|fixture|personal:|corpus|source_id|item_id/);
    const record = JSON.parse(lines[0]!.slice('[olympus:embedding-sweep] '.length));
    expect(record).toMatchObject({ source_index: 0, store_index: 0 });
    expect(record.next_run_at).toBe(status.sources[0]!.tasks.find(task => task.kind === 'embed')!.next_run_at);
    now = new Date(record.next_run_at);
    return record;
  };
  return {
    get ledger() { return runtime.ledger; },
    get store() { return runtime.store; },
    get personal() { return runtime.personal; },
    get provider() { return runtime.provider; },
    get set() { return runtime.set; },
    statePath: `${dbPath}${EMBEDDING_SWEEP_IDLE_SUFFIX}`,
    pass, restart, walks,
    runOperator: () => scheduler.runSource('synthetic-source-id', undefined, 'operator'),
  };
}

test('the sweep parks both window walks in place, keeps its budget and resumes at the share bound', async () => {
  const clock = createTestClock(Date.now());
  const mocked = spyOn(Date, 'now').mockImplementation(clock.now);
  cleanups.push(() => mocked.mockRestore());
  const seed = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await f.set.sync(fixtureConnector(() => ['one', 'two', 'three'].map(id => ({ id, name: `${id}.txt`, text: `Synthetic text ${id}` }))),
      { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
    const inventory = f.store.embeddingSweepInventory.bind(f.store);
    f.store.embeddingSweepInventory = (provider, scope, stopAtMs, _window, pacing) => inventory(provider, scope, stopAtMs, 1, pacing);
    const missing = f.store.missingEmbeddingItemIdsInTurns.bind(f.store);
    f.store.missingEmbeddingItemIdsInTurns = (provider, limit, scope, _window, checkpoint) => missing(provider, limit, scope, 1, checkpoint);
  };
  const reference = await fixture({ empty: true });
  await seed(reference);
  const expected = await reference.pass();
  expect(expected).toMatchObject({ eligible_chunks: 3, chunks_embedded: 3, inventory_complete: 1, stopped_at_deadline: 0 });

  let reason: string | undefined;
  const standBack = createStandBack({ reason: () => reason, now: clock.now, sleep: clock.sleep, log: () => {} });
  const guard = createExclusiveRunner();
  let synced = 0;
  const f = await fixture({
    empty: true, guard,
    pauseForAsk: () => standBack.pause('embed'),
    onSync: () => { synced++; },
    onWindow: (_walk, count) => { if (count === 1) reason = 'question in the front'; },
  });
  await seed(f);
  // Leave just enough active budget to run the inventory. The first pause
  // alone advances the wall past this deadline.
  const inventory = f.store.embeddingSweepInventory.bind(f.store);
  f.store.embeddingSweepInventory = (provider, scope, _stopAtMs, window, pacing) =>
    inventory(provider, scope, clock.now() + 500, window, pacing);
  const pass = f.pass();
  try {
    await waitFor(() => standBack.counts().embed?.holding, { description: 'inventory parked after the first window' });
    await clock.advance(2_000);
    expect(f.walks).toEqual({ inventory: 1, workList: 0 });
    expect(standBack.counts().embed).toMatchObject({ holding: true, reason, held_ms: 2_000 });
    // The same account runner can serve a foreground operation while parked.
    expect(synced).toBe(1);
    await waitFor(() => f.runOperator(), { description: 'foreground sync gets the source turn and account guard' });
    expect(synced).toBe(2);
    reason = undefined;
    await clock.advance(100);
    await waitFor(() => standBack.counts().embed?.holds === 2, { description: 'missing-vector walk parked after the first window' });
    expect(f.walks).toEqual({ inventory: 3, workList: 1 });
    await clock.advance(STAND_BACK_MAX_MS - 1);
    expect(f.walks.workList).toBe(1);
    expect(standBack.counts().embed?.holding).toBe(true);
    await clock.advance(1);
    const actual = await pass;
    expect(actual).toEqual(expected);
    expect(f.walks).toEqual({ inventory: 3, workList: 3 });
    expect(standBack.counts().embed).toMatchObject({ holding: false, bound_reached: 1 });
    expect(standBack.holds('embed')).toBe(false);
    await clock.advance(STAND_BACK_SHARE_MS);
    expect(standBack.holds('embed')).toBe(true);
  } finally {
    reason = undefined;
    await clock.advance(STAND_BACK_MAX_MS);
    await pass;
  }
}, 25_000);

test('a superseded-only Private backlog is an explained idle pass, never revived or sent', async () => {
  const f = await fixture();
  for (const pass of ['metadata', 'content'] as const) f.ledger.applySnifferVerdict(identityOf('synthetic-id'), {
    pass, tier: 'private', reason: 'synthetic', modelId: 'synthetic',
  }, { placementFor: decision => f.set.placementFor(decision) });
  await moveTieredItem({ set: f.set, identity: identityOf('synthetic-id'), target: { metadataTier: 'private', contentTier: 'private' }, vectorIdentities: { internal: f.provider } });
  const before = f.store.exportItemCopy(identityOf('synthetic-id'))!;
  expect(before.chunks.length).toBe(1);
  expect(before.vectors).toHaveLength(0);
  for (let i = 0; i < 2; i++) expect(await f.pass()).toMatchObject({
    eligible_chunks: 0, pending_chunks: 1, skipped_hidden_chunks: 1, chunks_embedded: 0,
    skipped_held_chunks: 0, skipped_moving_chunks: 0, stores_deferred: 0, backoff_ms: 0,
  });
  expect(f.provider.inputs).toHaveLength(0);
  expect(f.store.exportItemCopy(identityOf('synthetic-id'))).toEqual(before);
});

test('pending judgments embed early under the shared local identity and idle is still logged after completion', async () => {
  const f = await fixture();
  expect(await f.pass()).toMatchObject({ eligible_chunks: 1, pending_chunks: 1, skipped_held_chunks: 0, chunks_embedded: 1 });
  expect(await f.pass()).toMatchObject({ eligible_chunks: 0, pending_chunks: 0, chunks_embedded: 0 });
  expect(f.ledger.getCurrent(identityOf('synthetic-id'))?.contentPending).toBe(true);
});

test('held, moving and failed reasons remain distinct', async () => {
  const f = await fixture();
  f.store.usePersonalEmbeddingProvider(() => undefined);
  expect(await f.pass()).toMatchObject({ skipped_held_chunks: 1, eligible_chunks: 0 });
  f.store.usePersonalEmbeddingProvider(() => f.provider);
  const db = (f.ledger as unknown as { db: Database }).db;
  db.query("UPDATE tier_items SET state = 'moving'").run();
  expect(await f.pass()).toMatchObject({ skipped_moving_chunks: 1, eligible_chunks: 0 });
  db.query("UPDATE tier_items SET state = 'pending'").run();
  f.store.markEmbeddingFailed(localId('synthetic-id'), 'synthetic');
  expect(await f.pass()).toMatchObject({ skipped_failed_chunks: 1, eligible_chunks: 0 });
});

test('a scope exclusion is counted without widening the embedding scope', async () => {
  const f = await fixture({ accountScope: 'outside-synthetic-scope' });
  expect(await f.pass()).toMatchObject({ skipped_out_of_scope_chunks: 1, skipped_out_of_scope_recent_chunks: 1, eligible_chunks: 0, chunks_embedded: 0 });
  expect(f.provider.inputs).toHaveLength(0);
});

test('a moving item whose current copy remains eligible is not reported as skipped', async () => {
  const f = await fixture();
  for (const pass of ['metadata', 'content'] as const) f.ledger.applySnifferVerdict(identityOf('synthetic-id'), {
    pass, tier: 'secure', reason: 'synthetic', modelId: 'synthetic',
  }, { placementFor: decision => f.set.placementFor(decision) });
  const record = f.ledger.getCurrent(identityOf('synthetic-id'))!;
  f.ledger.beginMove(identityOf('synthetic-id'), { metadataTier: 'private', contentTier: 'private' }, record.generation);
  expect(f.ledger.copies(identityOf('synthetic-id')).some(copy => copy.state === 'current' && !copy.embedHold)).toBe(true);
  expect(await f.pass()).toMatchObject({ skipped_moving_chunks: 0, eligible_chunks: 1, chunks_embedded: 1 });
});

test('a spent diagnostic budget explicitly reports an incomplete inventory', async () => {
  const f = await fixture();
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1 });
  const inventory = f.store.embeddingSweepInventory.bind(f.store);
  f.store.embeddingSweepInventory = (provider, scope) => inventory(provider, scope, Date.now() - 1);
  expect(await f.pass()).toMatchObject({ inventory_complete: 0, pending_chunks: 0, rested: 0 });
  expect(f.walks).toEqual({ inventory: 0, workList: 1 });
  expect(existsSync(f.statePath)).toBe(false);
});

test('provider deferral and lease contention log their backoff and exact next run', async () => {
  const f = await fixture();
  const embed = f.store.embedChunks.bind(f.store);
  f.store.embedChunks = async () => { throw new TransientSourceEmbeddingError('built-in', 'timeout', 1, 1_000); };
  expect(await f.pass()).toMatchObject({ stores_deferred: 1, backoff_ms: 120_000, skipped_deferred_items: 1 });
  f.store.embedChunks = async () => { throw new FileLeaseBusyError('synthetic'); };
  expect(await f.pass()).toMatchObject({ stores_deferred: 1, backoff_ms: 240_000, skipped_lease_busy_items: 1 });
  f.store.embedChunks = embed;
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, stores_deferred: 0, backoff_ms: 0 });
});

test('a caught-up store rests until something changes, and a new item is embedded on the next pass', async () => {
  const f = await fixture();
  const walks = spyOn(f.store, 'embeddingSweepInventory');
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1 });
  expect(await f.pass()).toMatchObject({ eligible_chunks: 0, pending_chunks: 0, chunks_embedded: 0 });
  const settled = walks.mock.calls.length;
  for (let i = 0; i < 3; i++) expect(await f.pass()).toMatchObject({ eligible_chunks: 0, pending_chunks: 0, chunks_embedded: 0, rested: 1 });
  expect(walks.mock.calls.length).toBe(settled);
  await f.set.sync(fixtureConnector(() => [
    { id: 'synthetic-id', name: 'synthetic-name.txt', text: 'Synthetic body marker.' },
    { id: 'synthetic-id-2', name: 'synthetic-name-2.txt', text: 'A second synthetic body.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
  expect(walks.mock.calls.length).toBeGreaterThan(settled);
  expect(await f.pass()).toMatchObject({ pending_chunks: 0, chunks_embedded: 0 });
  const rested = walks.mock.calls.length;
  await f.pass();
  expect(walks.mock.calls.length).toBe(rested);
  const real = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => real + EMBEDDING_SWEEP_IDLE_FULL_PASS_MS + 1);
  cleanups.push(() => clock.mockRestore());
  await f.pass();
  expect(walks.mock.calls.length).toBeGreaterThan(rested);
});

async function catchUp(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 1 });
  expect(await f.pass()).toMatchObject({ inventory_complete: 1, pending_chunks: 0, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
  expect(existsSync(f.statePath)).toBe(true);
}

test('the first pass after reopening the scheduler, ledger and store runs no chunk-window statements', async () => {
  const f = await fixture();
  const sequenceBefore = f.store.writeSequence();
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1 });
  expect(f.store.writeSequence()).not.toBe(sequenceBefore);
  const sequence = f.store.writeSequence();
  const visibility = f.store.visibilityMarker();
  expect(await f.pass()).toMatchObject({ pending_chunks: 0, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
  f.restart();
  expect(f.store.writeSequence()).toBe(sequence);
  expect(f.store.visibilityMarker()).toBe(visibility);
  expect(await f.pass()).toMatchObject({ inventory_complete: 1, rested: 1, chunks_embedded: 0 });
  expect(f.walks).toEqual({ inventory: 0, workList: 0 });
});

test('a new item invalidates the remembered idle pass and is embedded on the first pass after restart', async () => {
  const f = await fixture();
  await catchUp(f);
  await f.set.sync(fixtureConnector(() => [
    { id: 'synthetic-id', name: 'synthetic-name.txt', text: 'Synthetic body marker.' },
    { id: 'synthetic-new', name: 'synthetic-new.txt', text: 'New body after the idle pass.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  f.restart();
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 1 });
  expect(f.store.exportItemCopy(identityOf('synthetic-new'))?.vectors).toHaveLength(1);
});

test('a vector write wakes the first pass even when visibility is unchanged', async () => {
  const f = await fixture();
  await catchUp(f);
  const sequence = f.store.writeSequence();
  const visibility = f.store.visibilityMarker();
  const db = (f.store as unknown as { db: Database }).db;
  db.query('DELETE FROM chunk_embeddings').run();
  f.restart();
  expect(f.store.writeSequence()).not.toBe(sequence);
  expect(f.store.visibilityMarker()).toBe(visibility);
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 1 });
});

test('a ledger visibility write wakes the first pass even when the store write sequence is unchanged', async () => {
  const f = await fixture();
  await catchUp(f);
  const sequence = f.store.writeSequence();
  const visibility = f.store.visibilityMarker();
  const db = (f.ledger as unknown as { db: Database }).db;
  db.query("UPDATE tier_items SET state = 'moving'").run();
  f.restart();
  expect(f.store.writeSequence()).toBe(sequence);
  expect(f.store.visibilityMarker()).not.toBe(visibility);
  expect(await f.pass()).toMatchObject({ rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
});

test.each(['model', 'epoch'] as const)('a changed embedding %s invalidates the remembered idle pass', async (changed) => {
  const f = await fixture();
  await catchUp(f);
  const { provider, modelId, backend, dimension, epochId } = f.provider;
  f.restart(new RecordingProvider(provider, changed === 'model' ? 'synthetic-new-model' : modelId, backend, dimension,
    changed === 'epoch' ? 'synthetic-new-epoch' : epochId));
  expect(await f.pass()).toMatchObject({ rested: 0 });
  expect(f.walks.inventory).toBe(1);
});

test('an identical database restored by replacing the file forces a walk', async () => {
  const f = await fixture();
  await catchUp(f);
  const { dbPath } = f.store;
  const sequence = f.store.writeSequence();
  const visibility = f.store.visibilityMarker();
  f.restart(f.provider, () => {
    copyFileSync(dbPath, `${dbPath}.restore`);
    renameSync(`${dbPath}.restore`, dbPath);
  });
  expect(f.store.writeSequence()).toBe(sequence);
  expect(f.store.visibilityMarker()).toBe(visibility);
  expect(await f.pass()).toMatchObject({ rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
});

test('the full pass is due at 30 minutes of wall time across restarts', async () => {
  const clock = createTestClock(Date.now());
  const mocked = spyOn(Date, 'now').mockImplementation(clock.now);
  cleanups.push(() => mocked.mockRestore());
  const f = await fixture();
  await catchUp(f);
  await clock.advance(EMBEDDING_SWEEP_IDLE_FULL_PASS_MS - 1);
  f.restart();
  expect(await f.pass()).toMatchObject({ rested: 1 });
  expect(f.walks).toEqual({ inventory: 0, workList: 0 });
  await clock.advance(1);
  f.restart();
  expect(await f.pass()).toMatchObject({ rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
});

test('unreadable remembered state forces a walk on restart', async () => {
  const f = await fixture();
  await catchUp(f);
  writeFileSync(f.statePath, '{');
  f.restart();
  expect(await f.pass()).toMatchObject({ rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
});

test('a write during an apparently empty inventory keeps the work list walk', async () => {
  const f = await fixture();
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1 });
  const inventory = f.store.embeddingSweepInventory.bind(f.store);
  const db = (f.store as unknown as { db: Database }).db;
  f.store.embeddingSweepInventory = async (...args) => {
    const counts = await inventory(...args);
    db.query('DELETE FROM chunk_embeddings').run();
    return counts;
  };
  expect(await f.pass()).toMatchObject({ pending_chunks: 0, chunks_embedded: 1 });
  expect(f.walks).toEqual({ inventory: 1, workList: 1 });
  expect(existsSync(f.statePath)).toBe(false);
});

test('with the idle back-off switched off, every pass walks the store', async () => {
  const f = await fixture();
  await catchUp(f);
  const before = process.env[EMBEDDING_SWEEP_IDLE_BACKOFF_ENV];
  process.env[EMBEDDING_SWEEP_IDLE_BACKOFF_ENV] = 'off';
  cleanups.push(() => { if (before === undefined) delete process.env[EMBEDDING_SWEEP_IDLE_BACKOFF_ENV]; else process.env[EMBEDDING_SWEEP_IDLE_BACKOFF_ENV] = before; });
  f.restart();
  for (let i = 0; i < 2; i++) {
    await f.pass();
    expect(f.walks).toEqual({ inventory: 1, workList: 0 });
  }
});

test('a deferred pass invalidates the previous idle pass before the queue is lost on restart', async () => {
  const f = await fixture();
  await catchUp(f);
  const before = f.store.writeSequence();
  f.store.queueEmbedding([localId('synthetic-id')], f.provider);
  f.store.embedChunks = async () => { throw new TransientSourceEmbeddingError('built-in', 'timeout', 1, 1_000); };
  expect(await f.pass()).toMatchObject({ stores_deferred: 1, rested: 0 });
  expect(f.store.writeSequence()).toBe(before);
  f.restart();
  expect(await f.pass()).toMatchObject({ pending_chunks: 0, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
});

test('failed passes and idle passes that rely on failed-item exclusions do not survive a restart', async () => {
  const f = await fixture();
  f.store.embedChunks = async () => { throw new Error('synthetic permanent failure'); };
  expect(await f.pass()).toMatchObject({ items_failed: 1, rested: 0 });
  expect(existsSync(f.statePath)).toBe(false);
  expect(await f.pass()).toMatchObject({ skipped_failed_chunks: 1, rested: 0 });
  expect(existsSync(f.statePath)).toBe(false);
  f.restart();
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
  expect(f.walks).toEqual({ inventory: 1, workList: 1 });
});

test('a brand-new store without a write sequence picks up its first write', async () => {
  const f = await fixture({ empty: true });
  expect(f.store.writeSequence()).toBeUndefined();
  expect(await f.pass()).toMatchObject({ eligible_chunks: 0, rested: 0 });
  await f.set.sync(fixtureConnector(() => [
    { id: 'synthetic-id', name: 'synthetic-name.txt', text: 'The first synthetic body.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  expect(f.store.writeSequence()).toBeGreaterThan(0);
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
});

test('an item that failed for good does not keep its store walked, stays reported, and a change wakes the store', async () => {
  const f = await fixture();
  f.store.markEmbeddingFailed(localId('synthetic-id'), 'synthetic');
  const walks = spyOn(f.store, 'embeddingSweepInventory');
  expect(await f.pass()).toMatchObject({ skipped_failed_chunks: 1, eligible_chunks: 0, rested: 0 });
  const settled = walks.mock.calls.length;
  for (let i = 0; i < 2; i++) expect(await f.pass()).toMatchObject({ skipped_failed_chunks: 1, items_failed: 0, rested: 1 });
  expect(walks.mock.calls.length).toBe(settled);
  expect(f.store.embeddingFailedItemCount()).toBe(1);
  await f.set.sync(fixtureConnector(() => [
    { id: 'synthetic-id', name: 'synthetic-name.txt', text: 'Synthetic body marker.' },
    { id: 'synthetic-id-3', name: 'synthetic-name-3.txt', text: 'A third synthetic body.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0 });
});
