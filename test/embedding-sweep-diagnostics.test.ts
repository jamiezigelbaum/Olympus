// Counts-only diagnostics over synthetic stores. No live data or identifiers in logs.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { SourceScheduler, withEmbeddingSweep } from '../src/workers/source-scheduler.ts';
import { TransientSourceEmbeddingError } from '../src/workers/source-index/embeddings.ts';
import { FileLeaseBusyError } from '../src/core/file-lease.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, localProvider, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture(options: { accountScope?: string } = {}) {
  const tmp = tempDir();
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/tiers.sqlite` });
  const secrets = new SecretLocationsIndex({ dbPath: `${tmp.dir}/secrets.sqlite` });
  const personal = new LocalConnectorStore({ dbPath: `${tmp.dir}/personal.sqlite`, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: ledger });
  const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/private.sqlite`, corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local', tierLedger: ledger });
  const provider = localProvider();
  const set = new TieredStoreSet({ setId: 'synthetic', ledger, secretLocations: secrets,
    tierClassification: { holdContentUntilJudged: true, sniffer: { id: 'synthetic', judge: () => ({ verdict: 'undecided', queued: true }) } },
    legs: [
      { trustDomain: 'internal', corpusId: personal.corpusId, store: personal, embeddingProvider: provider },
      { trustDomain: 'secure_local', corpusId: store.corpusId, store, embeddingProvider: provider },
    ],
  });
  cleanups.push(() => { personal.close(); store.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  await set.sync(fixtureConnector(() => [{ id: 'synthetic-id', name: 'synthetic-name.txt', text: 'Synthetic body marker.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
  const log = spyOn(console, 'info').mockImplementation(() => {});
  cleanups.push(() => log.mockRestore());
  let now = new Date('2026-11-07T15:00:00Z');
  const sources = withEmbeddingSweep([{ sourceId: 'synthetic-source-id', corpusId: store.corpusId, cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 24, tasks: [] }], () => () => [{ store, provider, wholeStore: true, ...options }]);
  const scheduler = new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 1_000, maxTransientRetries: 1, sources, now: () => now });
  const pass = async () => {
    log.mockClear();
    const status = await scheduler.runDueTasks();
    const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[olympus:embedding-sweep] '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/synthetic|fixture|personal:|corpus|source_id|item_id/);
    const record = JSON.parse(lines[0]!.slice('[olympus:embedding-sweep] '.length));
    expect(record).toMatchObject({ source_index: 0, store_index: 0 });
    expect(record.next_run_at).toBe(status.sources[0]!.tasks[0]!.next_run_at);
    now = new Date(record.next_run_at);
    return record;
  };
  return { ledger, store, personal, provider, set, pass };
}

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
  expect(await f.pass()).toMatchObject({ skipped_out_of_scope_chunks: 1, eligible_chunks: 0, chunks_embedded: 0 });
  expect(f.provider.inputs).toHaveLength(0);
});

test('a spent diagnostic budget explicitly reports an incomplete inventory', async () => {
  const f = await fixture();
  expect(await f.store.embeddingSweepInventory(f.provider, {}, Date.now() - 1)).toMatchObject({ inventory_complete: 0, pending_chunks: 0 });
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
