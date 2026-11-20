// Counts-only diagnostics over synthetic stores. No live data or identifiers in logs.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { embedPendingChunks, LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { CONNECTOR_STORE_EMBEDDING_LEASE_SUFFIX } from '../src/workers/connector-store/local-index.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createExclusiveRunner, guardAccountBoundLanes } from '../src/workers/source-account-guard.ts';
import { EMBEDDING_SWEEP_IDLE_BACKOFF_ENV, EMBEDDING_SWEEP_IDLE_FULL_PASS_MS, SourceScheduler, withEmbeddingSweep, type SourceSchedulerTask } from '../src/workers/source-scheduler.ts';
import { TransientSourceEmbeddingError } from '../src/workers/source-index/embeddings.ts';
import { fileLeaseHeld, FileLeaseBusyError } from '../src/core/file-lease.ts';
import { EMBEDDING_SWEEP_IDLE_SUFFIX, readEmbeddingSweepIdle, writeEmbeddingSweepIdle } from '../src/core/embedding-sweep-idle.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, localProvider, RecordingProvider, tempDir } from './helpers/tier-fixtures.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture(options: {
  accountScope?: string;
  empty?: boolean;
  holdForAsk?: () => boolean;
  operatorItemId?: string;
  storeDeadlineMs?: number;
  guard?: ReturnType<typeof createExclusiveRunner>;
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
  const sourceId = 'synthetic-source-id';
  const createScheduler = () => {
    const { store, provider, set } = runtime;
    const tasks: SourceSchedulerTask[] = [];
    const item = options.operatorItemId;
    if (item) tasks.push({
      id: 'pull', kind: 'sync', writer: true, cadence: 'manual',
      async run() {
        await set.sync(fixtureConnector(() => [{ id: item, name: 'Pulled.txt', text: 'A newly pulled body.' }]),
          { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
        return { status: 'progress' };
      },
    });
    if (options.holdForAsk) tasks.push({
      id: 'watch', kind: 'watch', writer: true,
      async run() { return { status: 'idle' }; },
    });
    let sources = withEmbeddingSweep([{ sourceId, corpusId: store.corpusId, cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 24, tasks }], () => () => [{
      store, provider, wholeStore: true, ...(options.accountScope !== undefined ? { accountScope: options.accountScope } : {}),
    }], options.storeDeadlineMs === undefined ? {} : { storeDeadlineMs: options.storeDeadlineMs });
    if (options.guard) sources = guardAccountBoundLanes(sources, new Map([[sourceId, { run: options.guard, assertAccount: async () => {} }]]));
    return new SourceScheduler({
      enabled: true, tickMs: 60_000, errorBackoffMs: 1_000, maxTransientRetries: 1,
      sources, now: () => now, ...(options.holdForAsk ? { holdForAsk: options.holdForAsk } : {}),
    });
  };
  let scheduler = createScheduler();
  const restart = (provider = localProvider(), whileClosed?: () => void) => {
    runtime.close();
    whileClosed?.();
    runtime = open(provider);
    scheduler = createScheduler();
  };
  const walks = { inventory: 0, workList: 0 };
  const pass = async (provenance: 'scheduled' | 'operator' = 'scheduled') => {
    log.mockClear();
    walks.inventory = 0;
    walks.workList = 0;
    setReadPoolObserverForTests((path, read) => {
      if (path !== dbPath || !read.sql.includes('c.chunk_pk > ? AND c.chunk_pk <= ?')) return;
      if (read.sql.includes('AS in_scope')) walks.inventory++;
      if (read.sql.includes('AS first_chunk_pk')) walks.workList++;
    }, { snapshots: true });
    const running = provenance === 'operator' ? scheduler.runSource(sourceId, now, provenance) : scheduler.runDueTasks();
    const status = await running.finally(() => setReadPoolObserverForTests());
    const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[olympus:embedding-sweep] '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/synthetic|fixture|personal:|corpus|source_id|item_id/);
    const record = JSON.parse(lines[0]!.slice('[olympus:embedding-sweep] '.length));
    expect(record).toMatchObject({ source_index: 0, store_index: 0 });
    const embed = status.sources[0]!.tasks.find(task => task.kind === 'embed')!;
    expect(record.next_run_at).toBe(embed.next_run_at);
    const sweep = embed.embedding_sweep?.[0];
    expect(sweep?.counts).toBeDefined();
    expect(record).toMatchObject(sweep!.counts);
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
    pass, restart, walks, status: () => scheduler.status(),
  };
}

test('a queued vector is committed before inventory and before a finder that outlasts the pass budget', async () => {
  const f = await fixture();
  const queued = localId('synthetic-id');
  await f.set.sync(fixtureConnector(() => [{ id: 'older', name: 'older.txt', text: 'Older note.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  f.store.completeQueuedEmbedding([localId('older')]);
  expect(f.store.queuedEmbeddingItemIds()).toEqual([queued]);
  const inventory = f.store.embeddingSweepInventory.bind(f.store);
  const vectorCount = () => f.store.exportItemCopy(identityOf('synthetic-id'))!.vectors.length;
  let vectorsAtInventory: number | undefined;
  f.store.embeddingSweepInventory = (...args) => {
    vectorsAtInventory = vectorCount();
    return inventory(...args);
  };
  const stopAtMs = Date.now() + 60_000;
  let vectorsAtDeadline: number | undefined;
  f.store.missingEmbeddingItemIdsInTurns = async () => {
    const now = spyOn(Date, 'now').mockReturnValue(stopAtMs);
    cleanups.push(() => now.mockRestore());
    vectorsAtDeadline = vectorCount();
    return [localId('older')];
  };
  const [run] = await embedPendingChunks([{ store: f.store, provider: f.provider, wholeStore: true }],
    { maxItems: 3, stopAtMs, diagnostics: true });
  expect(vectorsAtDeadline).toBe(1);
  expect(vectorsAtInventory).toBe(1);
  expect(run).toMatchObject({ queued_first_items: 1, itemsAttempted: 1, chunksEmbedded: 1, stoppedAtDeadline: true });
  expect(f.store.exportItemCopy(identityOf('older'))!.vectors).toHaveLength(0);
});

test('a finder that returns a queued item again dispatches only the other item', async () => {
  const f = await fixture();
  const queued = localId('synthetic-id');
  const older = localId('older');
  await f.set.sync(fixtureConnector(() => [{ id: 'older', name: 'older.txt', text: 'Older note.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  f.store.completeQueuedEmbedding([localId('older')]);
  expect(f.store.queuedEmbeddingItemIds()).toEqual([queued]);
  const selections = spyOn(f.store, 'embedChunks');
  const finder = spyOn(f.store, 'missingEmbeddingItemIdsInTurns').mockResolvedValue([queued, older]);
  expect(await f.pass()).toMatchObject({ queued_first_items: 1, chunks_embedded: 2, items_attempted: 2,
    rested: 0, not_resting: 'items_attempted' });
  expect(finder).toHaveBeenCalledTimes(1);
  expect(selections.mock.calls.map(([options]) => options.localItemIds)).toEqual([[queued], [older]]);
  expect(f.provider.inputs).toHaveLength(2);
  expect(await f.pass()).toMatchObject({ queued_first_items: 0, rested: 0 });
  expect(await f.pass()).toMatchObject({ queued_first_items: 0, rested: 1 });
});

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
  expect(await f.store.embeddingSweepInventory(f.provider)).toMatchObject({ eligible_chunks: 1, pending_chunks: 1 });
  expect(await f.pass()).toMatchObject({ eligible_chunks: 0, pending_chunks: 0, skipped_held_chunks: 0, held_for_judgment_chunks: 1, queued_first_items: 1, chunks_embedded: 1 });
  expect(await f.pass()).toMatchObject({ eligible_chunks: 0, pending_chunks: 0, chunks_embedded: 0, held_for_judgment_chunks: 1, held_for_judgment_items: 1 });
  expect(f.ledger.getCurrent(identityOf('synthetic-id'))?.contentPending).toBe(true);
});

test('per-store sweep receipts count held items and chunks by reason', async () => {
  const f = await fixture({ empty: true });
  const ids = ['for-judgment', 'decided', 'unread', 'moving'];
  await f.set.sync(fixtureConnector(() => ids.map(id => ({ id, name: 'Sample.txt', text: 'Sample text.' }))),
    { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  f.store.usePersonalEmbeddingProvider(() => undefined);
  const db = new Database(f.ledger.dbPath);
  try {
    db.query("UPDATE tier_items SET state = 'current', metadata_pending = 0, content_pending = 0 WHERE provider_item_id = 'decided'").run();
    db.query("UPDATE tier_items SET content_read = 0 WHERE provider_item_id = 'unread'").run();
    db.query("UPDATE tier_items SET state = 'moving' WHERE provider_item_id = 'moving'").run();
  } finally {
    db.close();
  }
  const holds = {
    held_for_judgment_chunks: 1, held_for_judgment_items: 1,
    held_after_decision_chunks: 1, held_after_decision_items: 1,
    held_while_text_is_unread_chunks: 1, held_while_text_is_unread_items: 1,
    held_while_moving_chunks: 1, held_while_moving_items: 1,
    held_for_other_reasons_chunks: 0, held_for_other_reasons_items: 0,
  };
  expect(await f.pass()).toMatchObject({ ...holds, pending_chunks: 4, eligible_chunks: 0, inventory_complete: 1 });
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
  f.store.queueEmbedding([localId('synthetic-id')], f.provider);
  expect(await f.pass()).toMatchObject({ items_attempted: 1, queued_first_items: 0, skipped_out_of_scope_chunks: 1, skipped_out_of_scope_recent_chunks: 1, eligible_chunks: 0, chunks_embedded: 0 });
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
  expect(await f.store.embeddingSweepInventory(f.provider)).toMatchObject({ skipped_moving_chunks: 0, eligible_chunks: 1 });
  expect(await f.pass()).toMatchObject({ skipped_moving_chunks: 0, eligible_chunks: 0, queued_first_items: 1, chunks_embedded: 1 });
});

test('a spent diagnostic budget explicitly reports an incomplete inventory', async () => {
  const f = await fixture();
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1 });
  const inventory = f.store.embeddingSweepInventory.bind(f.store);
  f.store.embeddingSweepInventory = (provider, scope) => inventory(provider, scope, Date.now() - 1);
  expect(await f.pass()).toMatchObject({ inventory_complete: 0, pending_chunks: 0, rested: 0, not_resting: 'inventory_incomplete' });
  expect(f.walks).toEqual({ inventory: 0, workList: 1 });
  expect(existsSync(f.statePath)).toBe(false);
});

test('provider deferral and lease contention log their backoff and exact next run', async () => {
  const f = await fixture();
  const embed = f.store.embedChunks.bind(f.store);
  f.store.embedChunks = async () => { throw new TransientSourceEmbeddingError('built-in', 'timeout', 1, 1_000); };
  expect(await f.pass()).toMatchObject({ stores_deferred: 1, backoff_ms: 120_000, skipped_deferred_items: 1, not_resting: 'deferred' });
  f.store.embedChunks = async () => { throw new FileLeaseBusyError('synthetic'); };
  expect(await f.pass()).toMatchObject({ stores_deferred: 1, backoff_ms: 240_000, skipped_lease_busy_items: 1, not_resting: 'busy' });
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

test('the quiet sweep ignores another leg but wakes for a local ledger-only visibility change', async () => {
  const f = await fixture();
  await f.pass();
  await f.pass();
  const walks = spyOn(f.store, 'embeddingSweepInventory');
  const db = (f.ledger as unknown as { db: Database }).db;
  db.query("INSERT INTO tier_visibility_changes (provider, account_scope, conversation_key, provider_item_id) VALUES ('fixture', 'fixture', '', 'unrelated')").run();
  expect(await f.pass()).toMatchObject({ rested: 1 });
  expect(walks).not.toHaveBeenCalled();

  db.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE corpus_id = ?").run(f.store.corpusId);
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'visibility' });
  expect(walks).toHaveBeenCalledTimes(1);
});

async function catchUp(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0, wake: 'none_remembered', not_resting: 'items_attempted' });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
  expect(existsSync(f.statePath)).toBe(false);
  const idle = await f.pass();
  expect(idle).toMatchObject({ inventory_complete: 1, pending_chunks: 0, rested: 0, wake: 'none_remembered' });
  expect(idle).not.toHaveProperty('not_resting');
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
  const receipts = await readEmbeddingSweepIdle(f.statePath);
  expect(receipts.size).toBe(1);
  expect([...receipts.values()][0]).toMatchObject({ writes: sequence, visibilityHash: expect.stringMatching(/^[a-f0-9]{16}$/) });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
  f.restart();
  expect(f.store.writeSequence()).toBe(sequence);
  expect(f.store.visibilityMarker()).toBe(visibility);
  const rested = await f.pass();
  expect(rested).toMatchObject({
    inventory_complete: 1, rested: 1, chunks_embedded: 0,
    held_for_judgment_items: 1, held_for_judgment_chunks: 1,
  });
  expect(rested).not.toHaveProperty('wake');
  expect(rested).not.toHaveProperty('not_resting');
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
  expect(await f.pass()).toMatchObject({ chunks_embedded: 1, rested: 0, wake: 'writes' });
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
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'visibility' });
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
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'expired' });
  expect(f.walks).toEqual({ inventory: 1, workList: 0 });
});

test('a key change with the same writes and visibility reports a build change', async () => {
  const f = await fixture();
  await catchUp(f);
  const receipts = await readEmbeddingSweepIdle(f.statePath);
  for (const receipt of receipts.values()) receipt.key = '0'.repeat(64);
  await writeEmbeddingSweepIdle(f.statePath, receipts);
  f.restart();
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'build' });
});

test('old receipts can still rest and a changed key reports key_changed', async () => {
  const f = await fixture();
  await catchUp(f);
  const receipts = await readEmbeddingSweepIdle(f.statePath);
  for (const receipt of receipts.values()) {
    delete receipt.writes;
    delete receipt.visibilityHash;
  }
  await writeEmbeddingSweepIdle(f.statePath, receipts);
  f.restart();
  expect(await f.pass()).toMatchObject({ rested: 1 });
  for (const receipt of receipts.values()) receipt.key = '0'.repeat(64);
  await writeEmbeddingSweepIdle(f.statePath, receipts);
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'key_changed' });
});

test('a marker change during an otherwise idle walk prevents remembering it', async () => {
  const f = await fixture();
  await catchUp(f);
  const marker = spyOn(f.store, 'embeddingSweepVisibilityMarker')
    .mockReturnValueOnce('synthetic marker before')
    .mockReturnValue('synthetic marker after');
  cleanups.push(() => marker.mockRestore());
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'visibility', not_resting: 'marker_moved_during_pass' });
  expect(existsSync(f.statePath)).toBe(true);
  expect((await readEmbeddingSweepIdle(f.statePath)).size).toBe(0);
});

test('a deferral wakes an otherwise fresh receipt', async () => {
  const f = await fixture();
  await catchUp(f);
  f.store.setEmbeddingDeferral('embedding_provider_unavailable');
  expect(await f.pass()).toMatchObject({ rested: 0, wake: 'deferred', not_resting: 'deferred' });
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
    const record = await f.pass();
    expect(record).not.toHaveProperty('wake');
    expect(record).not.toHaveProperty('not_resting');
    expect(record.rested).toBe(0);
    expect(f.walks).toEqual({ inventory: 1, workList: 0 });
  }
});

test('a deferred pass invalidates the previous idle pass before the queue is lost on restart', async () => {
  const f = await fixture();
  await catchUp(f);
  const before = f.store.writeSequence();
  f.store.queueEmbedding([localId('synthetic-id')], f.provider);
  f.store.embedChunks = async () => { throw new TransientSourceEmbeddingError('built-in', 'timeout', 1, 1_000); };
  expect(await f.pass()).toMatchObject({ stores_deferred: 1, rested: 0, wake: 'queued', not_resting: 'deferred' });
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
  expect(await f.pass()).toMatchObject({ eligible_chunks: 0, rested: 0, wake: 'marker_unavailable', not_resting: 'marker_unavailable' });
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

test('a store overrun releases the account without reporting a provider outage', async () => {
  const guard = createExclusiveRunner();
  const f = await fixture({ guard, storeDeadlineMs: 1_000 });
  const lease = f.store.dbPath + CONNECTOR_STORE_EMBEDDING_LEASE_SUFFIX;
  const embed = f.provider.embed.bind(f.provider);
  let sent = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stalled = spyOn(f.provider, 'embed').mockImplementationOnce(async inputs => {
    sent = true;
    await gate;
    return embed(inputs);
  });
  const sweep = f.pass();
  try {
    await waitFor(() => sent, { description: 'the guarded pass entered the provider' });
    expect(await sweep).toMatchObject({
      pass_overran: 1, stores_deferred: 0, rested: 0, wake: 'none_remembered', not_resting: 'overrun', backoff_ms: 0,
    });
    expect(f.status().sources[0]!.tasks.find(task => task.kind === 'embed')).toMatchObject({
      next_run_at: '2026-11-07T15:01:00.000Z', last_result: { counts: { stores_overran: 1 } },
    });
    expect(f.store.embeddingDeferredReason()).toBeUndefined();
    expect(await guard(async () => fileLeaseHeld(lease))).toBe(true);
    expect(f.store.exportItemCopy(identityOf('synthetic-id'))!.vectors).toHaveLength(0);
  } finally {
    release();
    await sweep;
    await waitFor(() => !fileLeaseHeld(lease), { description: 'the unfinished batch released its store lease' });
    stalled.mockRestore();
  }
  expect(f.store.exportItemCopy(identityOf('synthetic-id'))!.vectors).toHaveLength(1);
  expect(await f.pass()).toMatchObject({ chunks_embedded: 0, stores_deferred: 0, backoff_ms: 0 });
  expect(f.provider.inputs).toHaveLength(1);
}, 25_000);

test('a continuing Ask allows the mixed sweep and a same-account operator pull with a first vector', async () => {
  const f = await fixture({
    operatorItemId: 'operator-arrival', guard: createExclusiveRunner(), holdForAsk: () => true,
  });
  f.store.completeQueuedEmbedding([localId('synthetic-id')]);
  await f.set.sync(fixtureConnector(() => [{ id: 'arrival', name: 'Arrival.txt', text: 'A fresh note.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  expect(f.store.queuedEmbeddingItemIds()).toEqual([localId('arrival')]);

  expect(await f.pass()).toMatchObject({ queued_first_items: 1, chunks_embedded: 2, rested: 0 });
  expect(f.status().sources[0]!.tasks.find(task => task.kind === 'watch')).toMatchObject({ wait_reason: 'owner_ask' });
  expect(f.provider.inputs).toEqual([expect.stringContaining('A fresh note.'), expect.stringContaining('Synthetic body marker.')]);
  expect(f.store.exportItemCopy(identityOf('arrival'))!.vectors).toHaveLength(1);
  expect(f.store.exportItemCopy(identityOf('synthetic-id'))!.vectors).toHaveLength(1);

  expect(await f.pass('operator')).toMatchObject({ queued_first_items: 1, chunks_embedded: 1, rested: 0 });
  expect(f.store.exportItemCopy(identityOf('operator-arrival'))!.vectors).toHaveLength(1);
});

test('the stop callback preserves committed backlog batches and gives back the store lease', async () => {
  const f = await fixture({ empty: true });
  const embed = f.provider.embed.bind(f.provider);
  let stop = false;
  const firstBatch = spyOn(f.provider, 'embed').mockImplementationOnce(async inputs => {
    stop = true;
    return embed(inputs);
  });
  const target = { store: f.store, provider: f.provider, wholeStore: true };
  await f.set.sync(fixtureConnector(() => [{
    id: 'long', name: 'long.txt', text: Array.from({ length: 100 }, () => 'word '.repeat(790)).join('\n\n'),
  }]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  f.store.completeQueuedEmbedding([localId('long')]);
  try {
    const [stopped] = await embedPendingChunks([target], { maxItems: 1, shouldStop: () => stop });
    expect(stopped).toMatchObject({ queued_first_items: 0, chunksEmbedded: 32, stoppedAtDeadline: true });
    expect(firstBatch).toHaveBeenCalledTimes(1);
    expect(f.store.exportItemCopy(identityOf('long'))!.vectors).toHaveLength(32);
    expect(fileLeaseHeld(f.store.dbPath + CONNECTOR_STORE_EMBEDDING_LEASE_SUFFIX)).toBe(false);
    // The caller can resume the backlog in another turn.
    stop = false;
    const [resumed] = await embedPendingChunks([target], { maxItems: 1 });
    expect(resumed!.chunksEmbedded).toBeGreaterThan(0);
  } finally {
    firstBatch.mockRestore();
  }
});
