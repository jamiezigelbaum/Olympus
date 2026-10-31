import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
