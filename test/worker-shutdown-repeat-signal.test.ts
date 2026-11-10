// Under the worker service's own unit with the engine split on, a worker can
// get SIGTERM twice: once from systemd's control-group kill and once from the
// supervisor stopping it. The second must not cut its teardown short.
import { afterEach, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from './helpers/test-clock.ts';

const CHILD = join(import.meta.dir, 'fixtures', 'worker-shutdown-child.ts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a second SIGTERM during the teardown is ignored; the drain completes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-shutdown-'));
  roots.push(root);
  const events = join(root, 'events');
  const read = () => { try { return readFileSync(events, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const child = childProcess.spawn(process.execPath, [CHILD], { env: { ...process.env, EVENTS_PATH: events }, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => read().includes('ready') ? true : undefined);
    child.kill('SIGTERM');
    await waitFor(() => read().includes('teardown-started') ? true : undefined);
    child.kill('SIGTERM');
    // Let the second signal land before the teardown may finish.
    await waitFor(() => child.kill(0) ? true : undefined);
    child.stdin!.write('go\n');
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(read()).toEqual(['ready', 'teardown-started', 'drained']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 30_000);
