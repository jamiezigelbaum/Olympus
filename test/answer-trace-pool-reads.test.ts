// #1305: the Ask trace says, per lane, how long its store reads waited for a
// read-pool thread and ran on one, and how each one ended. Sparta's traces
// showed every lane timing out with nothing to say whether the pool was the
// cause; these fields are what tell a pool-bound lane from a slow store.

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { routeSourceIndexSearch, type SourceIndexCorpusSearchAdapter } from '../src/core/source-index/router.ts';
import { createConnectorStoreCorpusAdapter, LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import {
  readOnPool,
  readPoolThreadsForTests,
  shutdownReadPool,
  type StoreRead,
} from '../src/workers/connector-store/off-thread-reads.ts';
import {
  createSourceAnswerTrace,
  observeSourceAnswerRetrievalAttempt,
  observeSourceAnswerRoutedQuery,
  poolSqlSite,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';
import { buildSourceAnswerLatencyTraceRecord } from '../src/workers/source-index/answer-latency-log.ts';
import { waitFor } from './helpers/test-clock.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';

const roots: string[] = [];
afterEach(async () => {
  shutdownReadPool();
  await waitFor(() => readPoolThreadsForTests().live + readPoolThreadsForTests().stopping === 0, { description: 'the pool stopped', timeoutMs: 30_000 });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 40_000);

function storeFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-trace-pool-'));
  roots.push(root);
  const path = join(root, 'store.sqlite');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (n INTEGER); INSERT INTO items VALUES (1), (2), (3);');
  db.close();
  return path;
}

const COUNT: StoreRead = { mode: 'get', sql: 'SELECT COUNT(*) AS c FROM items', params: [] };
// Runs for seconds on its thread without returning a batch: a silent store.
const SLOW: StoreRead = {
  mode: 'get',
  sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000000) SELECT COUNT(*) AS c FROM n',
  params: [],
};

function poolAdapter(path: string, reads: StoreRead[]): SourceIndexCorpusSearchAdapter {
  return async (request) => {
    for (const read of reads) {
      await readOnPool(path, read, request.deadlineAtMs !== undefined ? { deadlineAtMs: request.deadlineAtMs } : {});
    }
    return { hits: [], latencyMs: 1, rawExposed: false };
  };
}

test('each lane reports its pool reads; a lane whose statement outruns the silence limit is waited for, not dropped', async () => {
  const path = storeFile();
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: 'public_safe.quick', family: 'file', trustDomain: 'public_safe' }),
    defineSourceIndexCorpus({ corpusId: 'public_safe.stuck', family: 'file', trustDomain: 'public_safe' }),
  ]);
  const trace = createSourceAnswerTrace();
  await runWithSourceAnswerTrace(trace, () => observeSourceAnswerRetrievalAttempt('keyword', () =>
    observeSourceAnswerRoutedQuery(1, () => routeSourceIndexSearch({
      registry,
      laneTimeoutMs: 400,
      adapters: {
        'public_safe.quick': poolAdapter(path, [COUNT, COUNT]),
        'public_safe.stuck': poolAdapter(storeFile(), [SLOW]),
      },
      request: { query: 'q', maxResults: 5, context: { allowedTrustDomains: ['public_safe'], allowCloudQueries: true } },
    }))));

  const [query] = snapshotSourceAnswerTrace(trace).retrievalAttempts[0]!.queries;
  const byCorpus = new Map(query!.corpus_timings.map((timing) => [timing.corpus_id, timing]));
  const quick = byCorpus.get('public_safe.quick')!;
  expect(quick.outcome).toBe('success');
  expect(quick.pool).toMatchObject({ reads: 2, refused: 0, dropped_queued: 0, past_deadline_running: 0, errors: 0 });
  // A statement running on a read worker is work in progress (owner rule,
  // 2026-11-16): the lane is waited for well past its 400 ms silence limit,
  // and nothing is given up at a deadline.
  const stuck = byCorpus.get('public_safe.stuck')!;
  expect(stuck.outcome).toBe('success');
  expect(stuck.elapsed_ms).toBeGreaterThan(400);
  expect(stuck.pool).toMatchObject({ reads: 1, past_deadline_running: 0, dropped_queued: 0, errors: 0 });
  const slow = stuck.pool!.slowest_sql![0]!;
  expect(slow.sql_ms).toBeGreaterThan(400);
  if (typeof process.threadCpuUsage === 'function') {
    expect(stuck.pool!.thread_cpu_available).toBe(true);
    expect(slow.sql_cpu_ms).toBeGreaterThan(0);
    expect(slow.sql_cpu_max_ms).toBe(slow.sql_cpu_ms!);
  } else {
    expect(stuck.pool!.thread_cpu_available).toBe(false);
    expect(slow.sql_cpu_ms).toBeUndefined();
  }
});

test('statements sharing a 120-character prefix are counted separately', async () => {
  const path = storeFile();
  const corpus = defineSourceIndexCorpus({ corpusId: 'public_safe.fixture', family: 'file', trustDomain: 'public_safe' });
  const prefix = 'SELECT COUNT(*) AS c FROM items WHERE ' + 'n > 0 AND '.repeat(12);
  const lower: StoreRead = { mode: 'get', sql: prefix + 'n < ?', params: [2] };
  const upper: StoreRead = { mode: 'get', sql: prefix + 'n > ?', params: [2] };
  const trace = createSourceAnswerTrace();
  await runWithSourceAnswerTrace(trace, () => observeSourceAnswerRetrievalAttempt('keyword', () =>
    observeSourceAnswerRoutedQuery(1, () => routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([corpus]),
      adapters: { [corpus.corpusId]: poolAdapter(path, [lower, upper]) },
      request: { query: 'q', maxResults: 5, context: { allowedTrustDomains: ['public_safe'], allowCloudQueries: true } },
    }))));
  const pool = snapshotSourceAnswerTrace(trace).retrievalAttempts[0]!.queries[0]!.corpus_timings[0]!.pool!;
  expect(poolSqlSite(lower.sql).slice(0, 120)).toBe(poolSqlSite(upper.sql).slice(0, 120));
  expect(pool.slowest_sql).toHaveLength(2);
  expect(new Set(pool.slowest_sql!.map(entry => entry.site))).toEqual(new Set([poolSqlSite(lower.sql), poolSqlSite(upper.sql)]));
  expect(pool.slowest_sql!.map(entry => entry.reads)).toEqual([1, 1]);
});

test('a routed hybrid chat search logs the adapter wall time, digest work and cold or memoized concept counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-trace-hybrid-'));
  roots.push(root);
  const corpus = defineSourceIndexCorpus({ corpusId: 'internal.trace.chat', family: 'chat', trustDomain: 'internal' });
  const store = new LocalConnectorStore({
    dbPath: join(root, 'store.sqlite'), corpusId: corpus.corpusId, family: 'chat', trustDomain: 'internal', tierLedger: null,
  });
  try {
    const provider = new RecordingProvider('built-in', 'trace-model', 'local');
    const question = 'kestrel boatyard invoice';
    const items: RawItem[] = [question, 'boatyard invoice', 'invoice total'].map((text, index) => ({
      identity: { provider: 'fixture', family: 'chat', accountScope: 'a', providerItemId: String(index), localItemId: String(index) },
      mimeType: 'text/plain',
      content: { kind: 'text', text },
      metadata: { sentAt: '2026-11-01T00:00:00Z' },
      fetchedAt: '2026-11-01T00:00:00Z',
    }));
    const connector: SourceConnector = {
      id: 'trace-chat', family: 'chat', async authenticate() {},
      async *listItems() { yield { items, done: true }; },
      async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; },
      classificationSignals() { return {}; },
    };
    await store.syncFromConnector(connector, { fetchContent: true, placement: { trustTier: 'S3', trustDomain: 'internal' } });
    expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(3);
    await store.ensureVectorDigestReady(provider.modelId, 4096);
    const adapter = createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider, retrievalMode: 'hybrid' });
    const trace = createSourceAnswerTrace();
    const route = () => routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([corpus]),
      adapters: { [corpus.corpusId]: adapter },
      request: { query: question, maxResults: 5, context: { allowedTrustDomains: ['internal'] } },
    });
    await runWithSourceAnswerTrace(trace, () => observeSourceAnswerRetrievalAttempt('hybrid', async () => {
      const cold = await observeSourceAnswerRoutedQuery(1, route);
      const warm = await observeSourceAnswerRoutedQuery(2, route);
      expect(warm.hits).toEqual(cold.hits);
      expect(cold.hits).toHaveLength(3);
    }));
    const record = buildSourceAnswerLatencyTraceRecord({ trace: snapshotSourceAnswerTrace(trace), outcome: 'success' });
    const [cold, warm] = record.retrieval_attempts[0]!.queries.map(query => query.corpus_timings[0]!);
    for (const timing of [cold!, warm!]) {
      expect(timing.outcome).toBe('success');
      const stages = timing.adapter_stages!;
      expect(stages.join_wait_ms! + 0.001).toBeGreaterThanOrEqual(Math.max(stages.keyword_lane_ms, stages.vector_lane_ms!));
      const critical = stages.join_wait_ms! + stages.post_join_setup_ms! + stages.keyword_relaxation_ms
        + stages.keyword_revalidation_ms + stages.vector_revalidation_ms! + stages.vector_summary_ms!
        + stages.recency_read_ms + stages.fusion_ms + stages.finalize_ms + stages.unattributed_ms;
      expect(critical).toBeCloseTo(stages.adapter_elapsed_ms, 2);
      expect(stages.recency_read_ms).toBeGreaterThan(0);
      expect(timing.pool!.vector_work).toMatchObject({ digest_pages_read: 1, digest_rows_scanned: 3, full_vectors_rescored: 3 });
      expect(timing.pool!.vector_work!.digest_unpack_score_ms).toBeGreaterThan(0);
    }
    const counts = (memo_hit: boolean) => [1, 2, 3].map(matched_items => ({ matched_items, memo_hit }));
    expect(cold!.pool!.keyword_concept_counts).toEqual([counts(false)]);
    expect(warm!.pool!.keyword_concept_counts).toEqual([counts(true)]);
    expect(JSON.stringify(record)).not.toContain(question);
  } finally {
    store.close();
  }
});

test('a read made outside a traced Ask lane is not counted', async () => {
  const path = storeFile();
  const trace = createSourceAnswerTrace();
  await runWithSourceAnswerTrace(trace, () => observeSourceAnswerRetrievalAttempt('keyword', () =>
    observeSourceAnswerRoutedQuery(1, () => readOnPool(path, COUNT))));
  const [query] = snapshotSourceAnswerTrace(trace).retrievalAttempts[0]!.queries;
  expect(query!.corpus_timings).toEqual([]);
});
