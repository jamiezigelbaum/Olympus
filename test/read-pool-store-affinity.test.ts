// #1305: an abandoned SQLite statement retains its store's only executor.
// Fake workers make deadlines and completion deterministic; no real-clock sleeps.
import { afterEach, expect, test } from 'bun:test';
import { readOnPool, readPoolDiagnostics, readPoolThreadsForTests, setReadPoolClockForTests,
  setReadPoolWorkerFactoryForTests, shutdownReadPool, OffThreadReadBusyError, releaseOffThreadReads } from '../src/workers/connector-store/off-thread-reads.ts';
import { createTestClock } from './helpers/test-clock.ts';

class ControlledWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  sent: Array<Record<string, any>> = [];
  closes: Array<() => void> = [];
  terminated = false;
  postMessage(message: Record<string, any>) { this.sent.push(message); }
  addEventListener(event: string, listener: () => void) { if (event === 'close') this.closes.push(listener); }
  unref() {}
  terminate() { this.terminated = true; }
  close() { this.closes.forEach(fn => fn()); }
  reply(message = this.sent.find(m => m.op === 'query')!) {
    this.onmessage?.({ data: { id: message.id, ok: true, rows: [{ n: 1 }] } } as MessageEvent);
  }
}
const workers: ControlledWorker[] = [];
function setup() {
  const clock = createTestClock(); setReadPoolClockForTests(clock);
  setReadPoolWorkerFactoryForTests(() => { const worker = new ControlledWorker(); workers.push(worker); return worker as unknown as Worker; });
  return clock;
}
afterEach(() => {
  shutdownReadPool();
  // shutdown can dispatch while another close releases a place; drain any such workers too.
  while (workers.length) workers.shift()!.close();
  setReadPoolClockForTests(); setReadPoolWorkerFactoryForTests();
  expect(readPoolThreadsForTests()).toEqual({ live: 0, stopping: 0 });
});
const READ = { mode: 'all' as const, sql: 'SELECT n FROM items', params: [] };

test('three back-to-back Asks never hand more work to a store with abandoned SQL', async () => {
  const clock = setup();
  const before = readPoolDiagnostics();
  for (let ask = 0; ask < 3; ask++) {
    const lanes = Array.from({ length: 3 }, () => readOnPool('/tmp/olympus-gate5-stuck.sqlite', READ,
      { deadlineAtMs: clock.now()+1000 }).catch(error => error));
    await clock.advance(1000);
    for (const outcome of await Promise.all(lanes)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent.filter(m => m.op === 'query')).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    expect(readPoolDiagnostics().stores['/tmp/olympus-gate5-stuck.sqlite']).toMatchObject({ inFlight: 1, abandoned: 1, queued: 0 });
  }
  // An unrelated store can still read, and the abandoned store reuses its worker only AFTER completion.
  const other = readOnPool('/tmp/olympus-gate5-other.sqlite', READ);
  expect(workers).toHaveLength(2); workers[1]!.reply(); await other;
  workers[0]!.reply(); await Promise.resolve(); await Promise.resolve();
  const next = readOnPool('/tmp/olympus-gate5-stuck.sqlite', READ);
  expect(workers).toHaveLength(2);
  workers[0]!.reply(workers[0]!.sent.filter(m => m.op === 'query').at(-1));
  expect(await next).toEqual([{ n: 1 }]);
  expect(readPoolDiagnostics().terminations - before.terminations).toBe(0);
});

test('a crashed or explicitly stopped worker retains the store slot until close', async () => {
  setup();
  const before = readPoolDiagnostics();
  const first = readOnPool('/tmp/olympus-gate5-crash.sqlite', READ).catch(error => error);
  workers[0]!.onerror?.({ message: 'synthetic crash' } as ErrorEvent);
  expect(await first).toBeInstanceOf(OffThreadReadBusyError);
  const next = readOnPool('/tmp/olympus-gate5-crash.sqlite', READ);
  expect(workers).toHaveLength(1);
  workers[0]!.close();
  expect(workers).toHaveLength(2);
  workers[1]!.reply(); await next;
  expect(readPoolDiagnostics().restarts - before.restarts).toBe(1);
});

test('releasing a store cannot reopen it behind an abandoned statement', async () => {
  const clock = setup();
  const read = readOnPool('/tmp/olympus-gate5-release.sqlite', READ, { deadlineAtMs: clock.now()+1000 }).catch(error => error);
  await clock.advance(1000); expect(await read).toBeInstanceOf(OffThreadReadBusyError);
  releaseOffThreadReads('/tmp/olympus-gate5-release.sqlite');
  const later = readOnPool('/tmp/olympus-gate5-release.sqlite', READ);
  expect(workers).toHaveLength(1);
  workers[0]!.reply(); await Promise.resolve(); await Promise.resolve();
  // The released worker is stopped after its outstanding SQL, and its replacement waits for close.
  expect(workers[0]!.terminated).toBe(true);
  expect(workers).toHaveLength(1);
  workers[0]!.close(); expect(workers).toHaveLength(2);
  workers[1]!.reply(); await later;
});


test('search SQL is governed by its caller, without a hidden 120 s send watchdog', async () => {
  const clock = setup();
  const read = readOnPool('/tmp/olympus-gate5-long-budget.sqlite', READ, { deadlineAtMs: clock.now()+300_000 });
  await clock.advance(120_001);
  expect(workers[0]!.terminated).toBe(false);
  expect(readPoolDiagnostics().stores['/tmp/olympus-gate5-long-budget.sqlite']).toMatchObject({ inFlight: 1, abandoned: 0 });
  workers[0]!.reply();
  expect(await read).toEqual([{ n: 1 }]);
});
