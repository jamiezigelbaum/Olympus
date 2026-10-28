// After pairing, capture starts only when the worker that runs it rereads the grant. On a standalone install that
// worker is the engine's: restarting the legacy worker unit left capture off (#588, test-mac 2026-10-28).
import { describe, expect, test } from 'bun:test';
import { restartCaptureWorker } from '../src/cli.ts';

describe('the restart that starts capture after pairing', () => {
  test('with the engine loaded, the engine restarts and the legacy worker unit is left alone', () => {
    const calls: string[] = [];
    const result = restartCaptureWorker({
      platform: 'darwin',
      engineLoaded: () => true,
      restartEngine: () => calls.push('engine'),
      restartWorker: () => { calls.push('worker'); return { ok: true }; },
    });
    expect(calls).toEqual(['engine']);
    expect(result.ok).toBe(true);
  });

  test('an engine that refuses to restart now says why and what to run', () => {
    const result = restartCaptureWorker({
      platform: 'linux',
      engineLoaded: () => true,
      restartEngine: () => { throw new Error('A zkAPI question is in flight.'); },
    });
    expect(result).toEqual({ ok: false, next: 'A zkAPI question is in flight. Then run: olympus engine restart' });
  });

  test('without the engine (an OpenClaw host), the managed worker restarts', () => {
    const calls: string[] = [];
    const result = restartCaptureWorker({
      platform: 'linux',
      engineLoaded: () => false,
      restartEngine: () => calls.push('engine'),
      restartWorker: () => { calls.push('worker'); return { ok: true }; },
    });
    expect(calls).toEqual(['worker']);
    expect(result.ok).toBe(true);
  });
});
