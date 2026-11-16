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
import { routeSourceIndexSearch, type SourceIndexCorpusSearchAdapter } from '../src/core/source-index/router.ts';
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
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';
import { waitFor } from './helpers/test-clock.ts';

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

test('each lane reports its pool reads; a lane dropped for silence is a timeout, and its read is not cut by a clock', async () => {
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
  const stuck = byCorpus.get('public_safe.stuck')!;
  expect(stuck.outcome).toBe('timeout');
  // No deadline rides the read any more (owner rule, 2026-11-16): the lane is
  // named as unfinished after 400 ms of silence, and the read itself runs on
  // its worker, so nothing was given up at a deadline.
  expect(stuck.pool?.past_deadline_running ?? 0).toBe(0);
});

test('a read made outside a traced Ask lane is not counted', async () => {
  const path = storeFile();
  const trace = createSourceAnswerTrace();
  await runWithSourceAnswerTrace(trace, () => observeSourceAnswerRetrievalAttempt('keyword', () =>
    observeSourceAnswerRoutedQuery(1, () => readOnPool(path, COUNT))));
  const [query] = snapshotSourceAnswerTrace(trace).retrievalAttempts[0]!.queries;
  expect(query!.corpus_timings).toEqual([]);
});
