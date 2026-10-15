import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineServicePaths } from '../src/core/engine-service.ts';
import { prepareWorkerSocket, workerSocketPath } from '../src/core/worker-transport.ts';
import { startLinuxOwnerBridgeHost, OWNER_BRIDGE_HOST_ENV } from '../src/core/linux-owner-bridge-host.ts';

async function waitFor<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 10_000;
  do { try { const value = await read(); if (value) return value as NonNullable<T>; } catch {} await Bun.sleep(25); } while (Date.now() < deadline);
  throw new Error('Lifecycle fixture did not become ready.');
}

for (const release of ['stop', 'SIGKILL', 'logout', 'server-mode']) {
  test(`host-owned listener: reload and worker kills retain it; ${release} releases and rotates`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-host-'));
    const runtime = join(root, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
    const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtime, OLYMPUS_WORKER_AUTH_TOKEN: 'fixture', OLYMPUS_SERVER_MODE: 'auto' };
    const paths = engineServicePaths({ homeDir: root, env, platform: 'linux' });
    mkdirSync(join(paths.configPath, '..'), { recursive: true, mode: 0o700 });
    // Reserve a test-selected free port, then give it to the actual host.
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port!; await reservation.stop(true);
    const entry = `http://127.0.0.1:${port}`;
    // The configured host name varies; the bridge's canonical origin does not.
    const configured = { stop: '127.0.0.1', SIGKILL: '[::1]', logout: 'localhost', 'server-mode': '127.0.0.1' }[release]!;
    writeFileSync(paths.configPath, JSON.stringify({ email: { baseUrl: `http://${configured}:${port}/v1` }, remote: { enabled: false }, worker: { service: { enabled: true } } }));
    writeFileSync(join(root, 'desktop'), 'ready');
    const children: ChildProcess[] = [];
    const launch = async (mode: string, extra = {}) => {
      const child = spawn(process.execPath, [join(import.meta.dir, 'helpers/linux-owner-bridge-process.ts'), mode], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
      await waitFor(() => { if (child.exitCode !== null) throw new Error(output); return output.includes(mode === 'host' ? 'host-started' : mode === 'startup' ? 'worker-startup' : 'worker-ready'); });
      return child;
    };
    const kill = async (child: ChildProcess, signal: NodeJS.Signals) => { const done = once(child, 'exit'); child.kill(signal); await done; };
    const socketPath = workerSocketPath({ platform: 'linux', env })!;
    try {
      let host = await launch('host');
      const control = () => join(runtime, 'olympus', readdirSync(join(runtime, 'olympus')).find(n => /^owner-host-.*\.sock$/.test(n))!);
      const controlRequest = (path: string, method = 'GET') => fetch('http://localhost' + path, { unix: control(), method } as RequestInit);
      const currentOrigin = async () => {
        const r = await fetch(entry + '/dashboard', { redirect: 'manual' });
        return r.status === 303 ? new URL(r.headers.get('location')!).origin : undefined;
      };
      let worker = await launch('worker', { [OWNER_BRIDGE_HOST_ENV]: control() });
      await waitFor(async () => (await (await controlRequest('/status')).json() as { state: string }).state === 'listening');
      const origin = await waitFor(currentOrigin);
      expect((await controlRequest('/open?target=/dashboard', 'POST')).status).toBe(200);
      const ticketPath = readFileSync(join(root, 'opened'), 'utf8');
      const ticket = readFileSync(ticketPath, 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
      const request = (path: string, init: RequestInit = {}) => fetch(entry + path, { ...init, headers: { Host: new URL(origin).host, ...Object.fromEntries(new Headers(init.headers)) } });
      // The real host's establishDashboard callback traverses the owner socket.
      const proofResponse = await request('/owner-proof', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
      expect(proofResponse.status).toBe(200);
      const { proof } = await proofResponse.json() as { proof: string };
      const cookie = proofResponse.headers.getSetCookie().find(c => c.startsWith('olympus_desktop_owner='))!.split(';')[0]!;
      const headers = { Cookie: cookie, 'X-Olympus-Owner-Proof': proof };
      expect(await (await request('/dashboard.json', { headers })).text()).toBe('PRIVATE OWNER DATA');
      expect((await request('/owner-proof', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })).status).toBe(403);
      // A second foreground worker stopped before readiness cannot revoke host state.
      const startup = await launch('startup', { [OWNER_BRIDGE_HOST_ENV]: control() }); await kill(startup, 'SIGTERM');
      expect(await (await request('/dashboard.json', { headers })).text()).toBe('PRIVATE OWNER DATA');
      // Exercise the production signal/reload wiring, including SIGTERM DURING drain.
      await fetch(entry + '/reload', { unix: socketPath } as RequestInit);
      await waitFor(() => readFileSync(join(root, 'reloading'), 'utf8'));
      await kill(worker, 'SIGTERM');
      // Start an independent process as the prospective squatter.
      const squatter = Bun.spawn([process.execPath, '-e', `try { Bun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>new Response('squatter')});process.exit(1) } catch(e) { process.exit(e.code==='EADDRINUSE'?0:2) }`], { stdout: 'pipe', stderr: 'pipe' });
      expect(await squatter.exited).toBe(0);
      const gap = await request('/dashboard.json', { headers });
      expect(gap.status).toBe(503); expect(gap.headers.has('Set-Cookie')).toBe(false);
      const gapText = await gap.text(); expect(gapText).toContain('Olympus is restarting…');
      for (const value of [proof, cookie, ticket, 'PRIVATE OWNER DATA', 'localStorage']) expect(gapText).not.toContain(value);
      // Restart the worker alone: socket custody is deliberately settled in the fixture.
      rmSync(socketPath, { force: true }); worker = await launch('worker', { [OWNER_BRIDGE_HOST_ENV]: control() });
      await waitFor(async () => (await request('/dashboard.json', { headers })).status === 200);
      expect(await currentOrigin()).toBe(origin);
      const reloaded = once(worker, 'exit');
      await fetch(entry + '/reload', { unix: socketPath } as RequestInit);
      expect((await reloaded)[0]).toBe(75);
      rmSync(socketPath, { force: true }); worker = await launch('worker', { [OWNER_BRIDGE_HOST_ENV]: control() });
      await waitFor(async () => (await request('/dashboard.json', { headers })).status === 200);
      expect(await currentOrigin()).toBe(origin);
      await kill(worker, 'SIGKILL');
      expect((await request('/dashboard.json', { headers })).status).toBe(503);
      if (release === 'stop' || release === 'SIGKILL') {
        const oldControl = control(); await kill(host, release === 'stop' ? 'SIGTERM' : 'SIGKILL');
        rmSync(socketPath, { force: true }); rmSync(oldControl, { force: true });
        host = await launch('host');
      } else {
        if (release === 'logout') writeFileSync(join(root, 'desktop'), 'away');
        else writeFileSync(paths.workerEnvPath, 'OLYMPUS_SERVER_MODE=on\n', { mode: 0o600 });
        await waitFor(async () => (await (await controlRequest('/status')).json() as { state: string }).state === 'headless');
        await expect(fetch(entry, { redirect: 'manual' })).rejects.toThrow();
        writeFileSync(join(root, 'desktop'), 'ready'); writeFileSync(paths.workerEnvPath, 'OLYMPUS_SERVER_MODE=auto\n', { mode: 0o600 });
      }
      rmSync(socketPath, { force: true }); worker = await launch('worker', { [OWNER_BRIDGE_HOST_ENV]: control() });
      const nextOrigin = await waitFor(currentOrigin); expect(nextOrigin).not.toBe(origin);
      await waitFor(async () => (await (await controlRequest('/status')).json() as { state: string }).state === 'listening');
      expect((await fetch(entry + '/dashboard.json', { headers: { Host: new URL(nextOrigin).host, ...headers } })).status).toBe(403);
      expect((await request('/dashboard.json', { headers })).status).toBe(421);
    } finally {
      await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(async c => { const done = once(c, 'exit'); c.kill('SIGKILL'); await done; }));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
}

test('a hung worker health probe cannot postpone logout or resurrect a closed host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-probe-'));
  const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const socketPath = prepareWorkerSocket(transport)!;
  const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reserve.port!; await reserve.stop(true);
  let ready = true, releaseHealth!: (value: boolean) => void;
  const health = new Promise<boolean>(resolve => { releaseHealth = resolve; });
  const host = startLinuxOwnerBridgeHost({ port, socketPath, transport, desktopReady: async () => ready,
    workerReady: () => health, fetchSocket: async () => new Response('private') });
  try {
    await waitFor(() => host.status().state === 'restarting');
    const origin = host.status().origin;
    ready = false; await host.probe();
    expect(host.status().state).toBe('headless');
    await expect(fetch(`http://127.0.0.1:${port}`, { redirect: 'manual' })).rejects.toThrow();
    ready = true; await host.probe();
    expect(host.status().origin).not.toBe(origin);
    host.close(); releaseHealth(true); await Bun.sleep(10);
    expect(host.status().state).toBe('headless');
    await expect(fetch(`http://127.0.0.1:${port}`, { redirect: 'manual' })).rejects.toThrow();
  } finally { host.close(); releaseHealth(false); rmSync(root, { recursive: true, force: true }); }
});

test('a worker-disabled engine starts no desktop bridge and leaves the port free', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-host-off-'));
  const runtime = join(root, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
  const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtime, OLYMPUS_WORKER_AUTH_TOKEN: 'fixture', OLYMPUS_SERVER_MODE: 'auto' };
  const paths = engineServicePaths({ homeDir: root, env, platform: 'linux' });
  mkdirSync(join(paths.configPath, '..'), { recursive: true, mode: 0o700 });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port!; await reservation.stop(true);
  writeFileSync(paths.configPath, JSON.stringify({ email: { baseUrl: `http://127.0.0.1:${port}/v1` }, remote: { enabled: false }, worker: { service: { enabled: false } } }));
  writeFileSync(join(root, 'desktop'), 'ready');
  const child = spawn(process.execPath, [join(import.meta.dir, 'helpers/linux-owner-bridge-process.ts'), 'host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
  try {
    await waitFor(() => { if (child.exitCode !== null) throw new Error(output); return output.includes('host-started'); });
    await Bun.sleep(300);
    // The port stays free for anything else, and no owner-host control socket exists.
    const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }); await probe.stop(true);
    let entries: string[] = []; try { entries = readdirSync(join(runtime, 'olympus')); } catch {}
    expect(entries.some(name => /^owner-host-.*\.sock$/.test(name))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test('worker health requires two consecutive failures, success resets them; logout is immediate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-health-'));
  const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const socketPath = prepareWorkerSocket(transport)!;
  const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reserve.port!; await reserve.stop(true);
  let healthy = true, desktop = true;
  const host = startLinuxOwnerBridgeHost({ port, socketPath, transport, desktopReady: async () => desktop,
    workerReady: async () => healthy, fetchSocket: async () => new Response() });
  const probe = async () => { await host.probe(); await Bun.sleep(5); };
  try {
    await waitFor(() => host.status().state === 'listening');
    const origin = host.status().origin;
    healthy = false; await probe(); expect(host.status().state).toBe('listening');
    healthy = true; await probe();
    healthy = false; await probe(); expect(host.status().state).toBe('listening');
    await probe(); expect(host.status().state).toBe('restarting');
    healthy = true; await probe(); expect(host.status().state).toBe('listening');
    expect(host.status().origin).toBe(origin);
    desktop = false; await probe(); expect(host.status().state).toBe('headless');
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});
