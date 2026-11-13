// The upgrade's and the rollback's health check says why it failed (#1563:
// rc.4's VM run failed it against a front that was serving, and the message
// said only that the worker "did not answer"). Spawning tests carry an
// explicit timeout (test/spawn-timeout-guard.test.ts). Synthetic data only.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workerHealthCheck } from '../src/core/lifecycle.ts';
import { workerSocketPath } from '../src/core/worker-transport.ts';

const saved = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  // Assigning undefined would store the string "undefined", which later tests
  // read as a runtime directory (#1629).
  if (saved.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = saved.XDG_RUNTIME_DIR;
});

// The check runs synchronously (spawnSync), so the server is its own process.
async function serveHealth(answers: string[]): Promise<string> {
  const runtime = mkdtempSync(join('/tmp', 'ohc-'));
  chmodSync(runtime, 0o700);
  process.env.XDG_RUNTIME_DIR = runtime;
  const socket = workerSocketPath({ platform: 'linux' })!;
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  // Each request gets the next answer, as [status, body].
  const script = `const answers = ${JSON.stringify(answers)}; let n = 0;
    Bun.serve({ unix: ${JSON.stringify(socket)}, fetch() { const [status, body] = JSON.parse(answers[Math.min(n++, answers.length - 1)]); return new Response(body, { status }); } });
    require('node:fs').chmodSync(${JSON.stringify(socket)}, 0o600); console.log('up');`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' });
  const reader = child.stdout.getReader();
  await reader.read();
  cleanups.push(() => { child.kill('SIGKILL'); rmSync(runtime, { recursive: true, force: true }); });
  return 'http://127.0.0.1:1/v1/health';
}
const answer = (status: number, body: unknown) => JSON.stringify([status, typeof body === 'string' ? body : JSON.stringify(body)]);

test.skipIf(process.platform !== 'linux')('a healthy answer over the worker socket passes', async () => {
  const url = await serveHealth([answer(200, { reachable: true, status: 'ok' })]);
  expect(workerHealthCheck(url, process.execPath)).toBeUndefined();
}, 30_000);

test.skipIf(process.platform !== 'linux')('each kind of failure is named', async () => {
  const url = await serveHealth([
    answer(503, 'busy'),
    answer(200, '<html>'),
    answer(200, { status: 'ok' }),
    answer(200, { reachable: true, engine_background: 'unreachable' }),
  ]);
  expect(workerHealthCheck(url, process.execPath)).toBe('status 503');
  expect(workerHealthCheck(url, process.execPath)).toBe('an answer that is not JSON');
  expect(workerHealthCheck(url, process.execPath)).toBe('an answer without reachable: true');
  expect(workerHealthCheck(url, process.execPath)).toBe('the front answered, but its background did not');
}, 30_000);

test.skipIf(process.platform !== 'linux')('a missing socket is named, not a silent false', () => {
  const runtime = mkdtempSync(join('/tmp', 'ohc-'));
  chmodSync(runtime, 0o700);
  cleanups.push(() => rmSync(runtime, { recursive: true, force: true }));
  process.env.XDG_RUNTIME_DIR = runtime;
  mkdirSync(dirname(workerSocketPath({ platform: 'linux' })!), { recursive: true, mode: 0o700 });
  expect(workerHealthCheck('http://127.0.0.1:1/v1/health', process.execPath)).toStartWith('the worker socket did not check out');
}, 30_000);
