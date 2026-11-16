// A large text's secret scan made on the second thread must give the same
// kinds the classifier would have found itself, and be what it then reuses.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  detectSecretFindingKinds,
  scanSecretFindingKinds,
  secretScanRemembered,
} from '../src/workers/classification/engine.ts';
import { configureSecretScannerForTests, scanSecretsAhead } from '../src/workers/classification/secret-scan-off-thread.ts';

import { createTestClock } from './helpers/test-clock.ts';

afterEach(() => configureSecretScannerForTests());

// Assembled here so the repository holds no key-shaped literal (credential-pattern check).
const AWS_KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

// Over the 256 KiB reuse threshold; the filler differs per test so no two share a scan.
function large(tag: string, secret: string): string {
  const filler = `Meeting notes ${tag}: lunch on Friday, the venue, the agenda.\n`.repeat(6_000);
  return `${filler}${secret}\n${filler}`;
}

describe('secret scan ahead, off the worker thread', () => {
  test('a large text with a key is remembered with the kinds the scan finds', async () => {
    const text = large('a', `my aws key is ${AWS_KEY_ID}`);
    expect(text.length).toBeGreaterThan(256 * 1024);
    expect(secretScanRemembered(text)).toBe(false);
    await scanSecretsAhead(text);
    expect(secretScanRemembered(text)).toBe(true);
    // Written expectation: an AWS access key id is a secret kind.
    expect(detectSecretFindingKinds(text)).toContain('aws_access_key_id');
    expect(detectSecretFindingKinds(text)).toEqual(scanSecretFindingKinds(text));
  });

  test('a large clean text is remembered as clean', async () => {
    const text = large('b', 'nothing secret here');
    await scanSecretsAhead(text);
    expect(secretScanRemembered(text)).toBe(true);
    expect(detectSecretFindingKinds(text)).toEqual([]);
  });

  test('a small text is left to the classifier', async () => {
    const text = `my aws key is ${AWS_KEY_ID}`;
    await scanSecretsAhead(text);
    expect(secretScanRemembered(text)).toBe(false);
    expect(detectSecretFindingKinds(text)).toContain('aws_access_key_id');
  });
});

function scannerHarness() {
  const clock = createTestClock();
  const logs: string[] = [];
  let progress: Int32Array;
  const requests: Array<{ id: number; text: string }> = [];
  let terminated = false;
  let closed: (() => void) | undefined;
  const worker = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    onerror: undefined as ((event: { message: string }) => void) | undefined,
    postMessage(message: { op?: string; buffer?: SharedArrayBuffer; id: number; text: string }) {
      if (message.op === 'progress') progress = new Int32Array(message.buffer!);
      else requests.push(message);
    },
    addEventListener(event: string, callback: () => void) { if (event === 'close') closed = callback; },
    terminate() { terminated = true; },
  };
  configureSecretScannerForTests({
    clock: { setTimeout: clock.setTimeout, clearTimeout: (timer) => clock.clearTimeout(timer as Parameters<typeof clock.clearTimeout>[0]) },
    workerFactory: () => worker as unknown as Worker,
    log: (line) => logs.push(line),
  });
  return { clock, logs, requests, worker, terminated: () => terminated,
    running: (id: number) => Atomics.store(progress!, 0, id),
    finished: (id: number) => { Atomics.store(progress!, 1, id); Atomics.store(progress!, 0, 0); },
    reply: (id: number) => worker.onmessage?.({ data: { id, ok: true, kinds: [] } }),
    close: () => closed?.(),
  };
}

describe('scan progress and lost replies', () => {
  test('a running scan and a queued scan survive multiple old timeout windows', async () => {
    const h = scannerHarness();
    const first = large('running', 'clean');
    const second = large('queued', 'clean');
    let settled = 0;
    const a = scanSecretsAhead(first).then(() => settled++);
    const b = scanSecretsAhead(second).then(() => settled++);
    h.running(h.requests[0]!.id);
    await h.clock.advance(5 * 120_000);
    expect(settled).toBe(0);
    expect(h.terminated()).toBe(false);
    h.finished(h.requests[0]!.id);
    h.reply(h.requests[0]!.id);
    h.finished(h.requests[1]!.id);
    h.reply(h.requests[1]!.id);
    await Promise.all([a, b]);
    expect(secretScanRemembered(first)).toBe(true);
    expect(secretScanRemembered(second)).toBe(true);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  test('a finished scan with no reply falls back and names the reply it waited for', async () => {
    const h = scannerHarness();
    const text = large('lost', 'clean');
    let settled = false;
    const pending = scanSecretsAhead(text).then(() => { settled = true; });
    h.finished(h.requests[0]!.id);
    await h.clock.advance(120_000);
    expect(settled).toBe(false);
    await h.clock.advance(120_000);
    await pending;
    expect(h.terminated()).toBe(true);
    expect(secretScanRemembered(text)).toBe(false);
    expect(h.logs[0]).toContain(`worker finished secret scan request ${h.requests[0]!.id}, but its reply was not delivered`);
  });

  test('recovering a lost reply leaves a later scan running', async () => {
    const h = scannerHarness();
    const a = scanSecretsAhead(large('lost-before-running', 'clean'));
    const later = large('running-after-lost', 'clean');
    const b = scanSecretsAhead(later);
    h.finished(h.requests[0]!.id);
    h.running(h.requests[1]!.id);
    await h.clock.advance(2 * 120_000);
    await a;
    expect(h.terminated()).toBe(false);
    h.finished(h.requests[1]!.id);
    h.reply(h.requests[1]!.id);
    await b;
    expect(secretScanRemembered(later)).toBe(true);
  });

  for (const event of ['error', 'close']) {
    test(`a dead scan worker (${event}) falls back immediately and names the wait`, async () => {
      const h = scannerHarness();
      const text = large(`dead-${event}`, 'clean');
      const pending = scanSecretsAhead(text);
      if (event === 'error') h.worker.onerror?.({ message: 'worker exited' });
      else h.close();
      await pending;
      expect(secretScanRemembered(text)).toBe(false);
      expect(h.terminated()).toBe(true);
      expect(h.logs[0]).toContain('waiting for off-thread secret scan reply');
      expect(h.clock.pendingTimers()).toBe(0);
    });
  }
});
