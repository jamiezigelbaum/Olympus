import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAgent } from '../scripts/release-check/run.ts';
import { SOCKET_READY } from '../scripts/release-check/fresh-install.ts';
import type { Machine } from '../scripts/release-check/machine.ts';
import { startOwnerBridge } from '../scripts/release-check/web-clients.ts';

function localMachine(home: string): Machine {
  return {
    os: 'linux', handle: 'local', label: 'local', driver: 'test',
    put: async () => {}, get: async () => {}, upgrade: async () => {},
    exec: async script => {
      const child = Bun.spawn(['bash', '-c', script], { env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home }, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr, timedOut: false, ms: 0 };
    },
  };
}

test('an active desktop listener is reused and closing the browser leaves it running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-bridge-desktop-'));
  const desktop = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('desktop bridge') });
  try {
    // There is deliberately no ~/rc or agent bundle: reusing a listener must not need either.
    const stop = await startOwnerBridge(localMachine(home), desktop.port!);
    expect(await (await fetch(`http://127.0.0.1:${desktop.port}/private`)).text()).toBe('desktop bridge');
    await stop();
    expect(await (await fetch(`http://127.0.0.1:${desktop.port}/health`)).text()).toBe('desktop bridge');
    expect(existsSync(join(home, 'rc'))).toBe(false);
  } finally { desktop.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 30_000);

test('without a desktop, the existing agent forwards dashboard and OAuth traffic to the owner socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-bridge-headless-'));
  const machine = localMachine(home);
  mkdirSync(join(home, 'rc'));
  mkdirSync(join(home, 'olympus'));
  const worker = Bun.serve({ unix: join(home, 'olympus/worker.sock'), fetch: async request => new Response(new URL(request.url).pathname) });
  const available = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = available.port!;
  available.stop(true);
  const pidFile = join(home, 'bridge.pid');
  let stop: (() => Promise<void>) | undefined;
  try {
    const agent = await bundleAgent(home);
    await Bun.write(join(home, 'rc/agent.js'), Bun.file(agent));
    // Readiness succeeds before a TCP listener exists, and cannot mistake TCP for a healthy worker.
    expect((await machine.exec(SOCKET_READY)).code).toBe(0);
    stop = await startOwnerBridge(machine, port, pidFile);
    expect(existsSync(pidFile)).toBe(true);
    for (const path of ['/dashboard', '/oauth/callback/gmail?code=synthetic&state=synthetic', '/oauth/callback/dropbox?code=synthetic&state=synthetic']) {
      expect(await (await fetch(`http://127.0.0.1:${port}${path}`)).text()).toBe(path.split('?')[0]!);
    }
    worker.stop(true);
    expect((await machine.exec(SOCKET_READY)).code).not.toBe(0);
    await stop(); stop = undefined;
    expect(existsSync(pidFile)).toBe(false);
  } finally { await stop?.(); worker.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 30_000);
