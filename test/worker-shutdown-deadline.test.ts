import { expect, test } from 'bun:test';
import { installWorkerShutdownSignals } from '../src/core/worker-shutdown.ts';

// A worker whose shutdown cannot finish (a first import's pass still running)
// exits on its own instead of waiting for the service manager's kill, which
// left the owner socket behind (Sparta, 2026-11-03).
test('a signalled worker exits after the deadline even while work keeps it alive', async () => {
  const exits: number[] = [];
  const signals = installWorkerShutdownSignals({ closeOwnerBridge: () => {}, exit: (code) => exits.push(code), deadlineMs: 30 });
  let handled = 0;
  signals.setShutdown(() => { handled += 1; });
  const keepAlive = setInterval(() => {}, 5);
  try {
    process.emit('SIGTERM', 'SIGTERM');
    expect(handled).toBe(1);
    expect(exits).toEqual([]);
    await Bun.sleep(80);
    expect(exits).toEqual([143]);
  } finally {
    clearInterval(keepAlive);
    signals.dispose();
  }
});
