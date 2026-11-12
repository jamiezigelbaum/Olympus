import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { withIdleStoreReclaim, withStoreReadPriority } from '../src/core/store-reclaim-admission.ts';
import { waitFor } from './helpers/test-clock.ts';

test('a nested read keeps its own priority when it outlives the request that started it', async () => {
  let started = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let nested: Promise<void> | undefined;
  try {
    await withStoreReadPriority(async () => {
      nested = withStoreReadPriority(async () => { started = true; await held; });
      await waitFor(() => started, { description: 'nested reader is admitted' });
    });
    let ran = false;
    expect(await withIdleStoreReclaim(async () => { ran = true; })).toBeUndefined();
    expect(ran).toBe(false);
  } finally { release(); await nested; }
  expect(await withIdleStoreReclaim(async () => 'idle')).toBe('idle');
});

test('the split front holds Ask priority across processes, while another Ask can still read', async () => {
  const module = join(import.meta.dir, '../src/core/store-reclaim-admission.ts');
  const child = Bun.spawn([process.execPath, '-e', `
    import { withStoreReadPriority } from ${JSON.stringify(module)};
    await withStoreReadPriority(async () => {
      console.log('reading');
      await new Promise(resolve => {
        const keepAlive = setInterval(() => {}, 60_000);
        process.stdin.resume(); process.stdin.on('end', () => { clearInterval(keepAlive); resolve(); });
      });
    });`], { env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let reading = false;
  const output = (async () => { for await (const chunk of child.stdout) reading ||= new TextDecoder().decode(chunk).includes('reading'); })();
  try {
    await waitFor(() => reading, { description: 'front holds Ask priority' });
    expect(child.exitCode).toBeNull();
    let reclaimed = false;
    expect(await withIdleStoreReclaim(async () => { reclaimed = true; })).toBeUndefined();
    expect(reclaimed).toBe(false);
    expect(await withStoreReadPriority(() => 'another Ask')).toBe('another Ask');
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await output;
    expect(await withIdleStoreReclaim(async () => 'idle')).toBe('idle');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
}, 20_000);
