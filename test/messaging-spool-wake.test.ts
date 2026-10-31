import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { createSpoolChangeSubscription } from '../src/workers/messaging-spool-wake.ts';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}

test('watches a spool created after subscription, then new and appended message files, and closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spool-wake-'));
  const spool = join(root, 'new', 'spool');
  let wakes = 0;
  const close = createSpoolChangeSubscription(spool)(() => { wakes++; });
  try {
    await Bun.sleep(100);
    mkdirSync(spool, { recursive: true });
    await until(() => wakes > 0);
    let before = wakes;
    writeFileSync(join(spool, '2026-10-31.jsonl'), '{}\n');
    await until(() => wakes > before);
    before = wakes;
    appendFileSync(join(spool, '2026-10-31.jsonl'), '{}\n');
    await until(() => wakes > before);
    close();
    before = wakes;
    appendFileSync(join(spool, '2026-10-31.jsonl'), '{}\n');
    await Bun.sleep(100);
    expect(wakes).toBe(before);
  } finally { close(); rmSync(root, { recursive: true, force: true }); }
});

test('retries failed setup and rearms after a watcher error, then stops retrying on close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spool-retry-'));
  let attempts = 0;
  const opened: Array<EventEmitter & { close: () => void }> = [];
  const fakeWatch = (() => {
    attempts++;
    if (attempts === 1) throw new Error('EMFILE');
    const watcher = Object.assign(new EventEmitter(), { close: () => {} });
    opened.push(watcher);
    return watcher;
  }) as unknown as typeof import('node:fs').watch;
  let wakes = 0;
  const close = createSpoolChangeSubscription(root, { watch: fakeWatch, retryInitialMs: 10, retryMaxMs: 20 })(() => { wakes++; });
  try {
    await until(() => opened.length >= 2);
    expect(wakes).toBeGreaterThan(0);
    opened[1]!.emit('error', new Error('watch failed'));
    await until(() => opened.length >= 4);
    expect(wakes).toBeGreaterThan(1);
    opened[3]!.emit('error', new Error('watch failed'));
    close();
    const before = attempts;
    await Bun.sleep(60);
    expect(attempts).toBe(before);
  } finally { close(); rmSync(root, { recursive: true, force: true }); }
});
