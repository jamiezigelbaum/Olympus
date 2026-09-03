import { describe, expect, test } from 'bun:test';
import { runBoundedEvalProcess } from '../eval/process-boundary.ts';

describe('real eval process boundary', () => {
  test('terminates a synchronously blocked child at the parent deadline', async () => {
    const result = await runBoundedEvalProcess({
      command: [process.execPath, '-e', 'while (true) {}'],
      env: { ...process.env },
      timeoutMs: 100,
      stderr: 'ignore',
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  test('returns an ordinary child exit without waiting for the deadline', async () => {
    const result = await runBoundedEvalProcess({
      command: [process.execPath, '-e', 'process.exit(7)'],
      env: { ...process.env },
      timeoutMs: 2_000,
      stderr: 'ignore',
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(7);
  });
});
