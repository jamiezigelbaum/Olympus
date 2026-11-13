// #1583: a rerank that times out falls back to the fused cut. That must show
// per answer (the answer trace and its latency log line) and in aggregate
// (a count since start in /health), never vanish.
import { expect, test } from 'bun:test';
import { rerankCandidates, rerankOutcomeCounts, type EvidenceReranker } from '../src/core/evidence-reranker.ts';
import { buildSourceAnswerLatencyTraceRecord } from '../src/workers/source-index/answer-latency-log.ts';
import { createSourceAnswerTrace, recordSourceAnswerRerank, runWithSourceAnswerTrace, snapshotSourceAnswerTrace } from '../src/workers/source-index/answer-latency-trace.ts';
import { createTestClock } from './helpers/test-clock.ts';

const items = ['a', 'b', 'c'];
const run = (reranker: EvidenceReranker, clock = createTestClock()) => rerankCandidates({
  reranker, query: 'q', items, keep: 2, passageOf: (item) => item,
  timers: {
    now: () => clock.now(),
    setTimeout: (callback: () => void, ms: number) => clock.setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]),
  },
});
const reranker = (score: EvidenceReranker['score']): EvidenceReranker => ({ id: 'fixture', localOnly: true, poolSize: 3, score });

test('every rerank outcome is counted since start', async () => {
  const before = rerankOutcomeCounts();
  await run(reranker(async () => [1, 2, 3]));
  await run(reranker(async () => { throw Error('model gone'); }));
  const clock = createTestClock();
  const pending = run(reranker(() => new Promise(() => {})), clock);
  await clock.advance(5_000);
  expect((await pending).audit.outcome).toBe('timed_out');
  const after = rerankOutcomeCounts();
  expect(after.applied - before.applied).toBe(1);
  expect(after.failed - before.failed).toBe(1);
  expect(after.timed_out - before.timed_out).toBe(1);
});

test('the answer trace and its log line carry the rerank outcome', async () => {
  const trace = createSourceAnswerTrace();
  await runWithSourceAnswerTrace(trace, () => recordSourceAnswerRerank({ rerankerId: 'fixture', outcome: 'timed_out', scored: 0, kept: 12, promoted: 0, elapsedMs: 5_000 }));
  const snapshot = snapshotSourceAnswerTrace(trace);
  expect(snapshot.rerank).toEqual({ rerankerId: 'fixture', outcome: 'timed_out', scored: 0, kept: 12, promoted: 0, elapsedMs: 5_000 });
  const record = buildSourceAnswerLatencyTraceRecord({ trace: snapshot, outcome: 'success' }) as unknown as Record<string, unknown>;
  expect(record.rerank).toEqual({ reranker_id: 'fixture', outcome: 'timed_out', scored: 0, kept: 12, promoted: 0, elapsed_ms: 5_000 });
});
