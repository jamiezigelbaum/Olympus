import { expect, test } from 'bun:test';
import { createExtractionReadinessLedger } from '../src/workers/file-extraction/readiness-ledger.ts';

// A background snapshot runs in a timer, where a throw would be uncaught and
// stop the worker (Codex on #838). It must keep the last snapshot instead.
test('a background snapshot that throws keeps the last snapshot and does not escape', async () => {
  let fail = false;
  const uncaught: unknown[] = [];
  const onError = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', onError);
  let clock = 0;
  try {
    const ledger = createExtractionReadinessLedger({
      corpusReadiness: () => { throw new Error('unused'); },
      scopedReadiness: () => ({ jobs: {}, items: {} } as never),
    }, {
      lanesForCorpus: () => {
        if (fail) throw new Error('scope changed');
        return [];
      },
      now: () => clock,
    });
    expect(ledger.snapshotForCorpus('c', { maxAgeMs: 10 })).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = ledger.snapshotForCorpus('c', { maxAgeMs: 10 });
    expect(first).toBeDefined();
    fail = true;
    clock = 100;
    expect(ledger.snapshotForCorpus('c', { maxAgeMs: 10 })).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ledger.snapshotForCorpus('c', { maxAgeMs: 10 })).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(uncaught).toEqual([]);
  } finally {
    process.off('uncaughtException', onError);
  }
});
