import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxOwnerBridge, manageLinuxOwnerBridge, randomOwnerHostname } from '../src/core/linux-owner-bridge.ts';
import { prepareWorkerSocket, bindWorkerSocket } from '../src/core/worker-transport.ts';
import { openLinuxOwnerTicketFile } from '../src/core/linux-desktop-opener.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { withRequestPeer } from '../src/core/request-peer.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(fetchSocket: (r: Request) => Promise<Response> = async () => new Response('private dashboard')) {
  const root = mkdtempSync(join(tmpdir(), 'owner-bridge-'));
  const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const socketPath = prepareWorkerSocket(transport)!;
  const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: () => new Response('socket') }));
  let opened = '', ready = true, now = 100_000;
  const options = { port: 18010, socketPath, transport, ready: () => ready, now: () => now,
    fetchSocket, openFile: async (path: string) => { opened = path; } };
  const bridge = new LinuxOwnerBridge(options);
  cleanup.push(() => { socket.stop(true); rmSync(root, { recursive: true, force: true }); });
  cleanup.push(() => bridge.close());
  const request = (path: string, init: RequestInit = {}) => new Request(bridge.origin + path, {
    ...init, headers: { Host: new URL(bridge.origin).host, ...Object.fromEntries(new Headers(init.headers)) },
  });
  const post = (path: string, body: object) => request(path, { method: 'POST', headers: { Origin: bridge.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(body) });
  return { bridge, options, request, post, root, opened: () => opened, ready: (v: boolean) => { ready = v; }, advance: (v: number) => { now += v; } };
}
async function prove(f: ReturnType<typeof fixture>, target = '/dashboard') {
  await f.bridge.openTicket(target);
  const html = readFileSync(f.opened(), 'utf8');
  const ticket = html.match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const response = await f.bridge.handle(f.post('/owner-proof', { ticket }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const data = await response.json() as { proof: string; target: string };
  return { ticket, cookie, proof: data.proof, response, target: data.target };
}

test('128 bits encoded in a fresh base32 localhost label', () => {
  const names = new Set(Array.from({ length: 100 }, randomOwnerHostname));
  expect(names.size).toBe(100);
  for (const name of names) expect(name).toMatch(/^[a-z2-7]{25}[aeimquy4]\.localhost$/);
});

test('entry only redirects intact OAuth query; arbitrary and stale Hosts are refused', async () => {
  const f = fixture();
  const query = '/connect/authorize?state=a%2Bb&client_id=one&code_challenge=two';
  const response = await f.bridge.handle(new Request(f.bridge.entryOrigin + query, { headers: { Host: new URL(f.bridge.entryOrigin).host } }));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(f.bridge.origin + query);
  expect(await response.text()).toBe(''); expect(response.headers.has('set-cookie')).toBe(false);
  for (const host of ['evil.invalid:18010', randomOwnerHostname() + ':18010', new URL(f.bridge.entryOrigin).host]) {
    expect((await f.bridge.handle(f.request('/dashboard', { headers: { Host: host } }))).status).toBe(421);
  }
});

test('ticket is 0600, single use, expiring, bounded and never returned publicly', async () => {
  const f = fixture(); const owner = await prove(f, '/connect/authorize?state=original%2Bstate');
  expect(owner.target).toBe('/connect/authorize?state=original%2Bstate');
  expect(existsSync(f.opened())).toBe(false);
  expect(owner.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
  expect(owner.response.headers.get('set-cookie')).not.toMatch(/Domain=/i);
  expect((await f.bridge.handle(f.post('/owner-proof', { ticket: owner.ticket }))).status).toBe(403);
  await expect(f.bridge.openTicket('/dashboard')).rejects.toThrow('ten seconds');
  f.advance(10_001); await f.bridge.openTicket('/dashboard');
  expect(statSync(f.opened()).mode & 0o777).toBe(0o600); expect(statSync(join(f.root, 'olympus')).mode & 0o777).toBe(0o700);
  const file = readFileSync(f.opened(), 'utf8'); expect(file).toContain('cannot reach the private *.localhost');
  const value = file.match(/owner-proof#([A-Za-z0-9_-]{43})/)![1];
  f.advance(60_001); expect((await f.bridge.handle(f.post('/owner-proof', { ticket: value }))).status).toBe(403);
});

test('no cookie, forged headers, stolen cross-port cookie and previous-instance cookie cannot read or approve', async () => {
  const seen: Request[] = []; const f = fixture(async r => { seen.push(r); return new Response('private dashboard'); });
  const owner = await prove(f);
  for (const path of ['/dashboard', '/dashboard.json', '/connect/authorize', '/dashboard/control/session/local']) {
    for (const headers of [ {}, { Cookie: owner.cookie }, { 'X-Olympus-Owner-Proof': owner.proof },
      { Cookie: 'olympus_desktop_owner=forged', 'X-Olympus-Owner-Proof': owner.proof },
      { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof, 'X-Forwarded-For': '127.0.0.1' } ]) {
      const r = await f.bridge.handle(f.request(path, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', ...headers } }));
      expect(r.status).toBe(403); expect(await r.text()).not.toContain('private dashboard');
    }
  }
  expect(seen.length).toBe(0);
  const second = new LinuxOwnerBridge(f.options); cleanup.push(() => second.close());
  const r = await second.handle(new Request(second.origin + '/dashboard', { headers: { Host: new URL(second.origin).host, Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }));
  expect(r.status).toBe(403);
  const shell = await f.bridge.handle(f.request('/dashboard', { headers: { Cookie: owner.cookie, Accept: 'text/html' } }));
  const text = await shell.text(); expect(text).toContain("Confirm it's you"); expect(text).not.toContain(owner.proof); expect(text).not.toContain('private dashboard');
});

test('valid owner proof preserves socket CSRF and original query; host/origin checked before rewrite', async () => {
  const seen: Request[] = []; const f = fixture(async r => { seen.push(r); return new Response('private dashboard'); });
  const owner = await prove(f);
  const headers = { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof };
  expect((await f.bridge.handle(f.request('/dashboard?original=a%2Bb', { headers }))).status).toBe(200);
  expect(seen[0]!.url).toBe(f.bridge.entryOrigin + '/dashboard?original=a%2Bb');
  expect(seen[0]!.headers.has('X-Olympus-Owner-Proof')).toBe(false);
  expect(seen[0]!.headers.get('cookie')).not.toContain(owner.cookie);
  for (const origin of ['http://evil.invalid', 'null', f.bridge.entryOrigin]) {
    expect((await f.bridge.handle(f.request('/connect/authorize', { method: 'POST', headers: { ...headers, Origin: origin } }))).status).toBe(403);
  }
  const form = new URLSearchParams({ csrf: 'backend-csrf', decision: 'approve', _olympus_owner_proof: owner.proof });
  const formResponse = await f.bridge.handle(f.request('/connect/authorize', { method: 'POST', body: form.toString(), headers: {
    Cookie: owner.cookie, Origin: f.bridge.origin, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate',
  } }));
  expect(formResponse.status).toBe(200); expect(await seen[1]!.text()).toBe('csrf=backend-csrf&decision=approve');
  expect(seen[1]!.headers.get('origin')).toBe(f.bridge.entryOrigin);
});

test('service-worker script requests refused and every page forbids workers', async () => {
  const f = fixture(); const owner = await prove(f);
  for (const path of ['/owner-proof', '/dashboard', '/sw.js']) {
    const response = await f.bridge.handle(f.request(path, { headers: { 'Service-Worker': 'script', Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }));
    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toContain("worker-src 'none'");
  }
  expect((await f.bridge.handle(f.request('/owner-proof'))).headers.get('content-security-policy')).toContain("worker-src 'none'");
});

test('logout revokes in-flight publication, removes tickets and stops listener; no headless/Mac listener', async () => {
  const f = fixture(async () => { f.ready(false); return new Response('private dashboard'); });
  const owner = await prove(f);
  expect((await f.bridge.handle(f.request('/dashboard', { headers: { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }))).status).toBe(503);
  let starts = 0, stops = 0;
  const manager = manageLinuxOwnerBridge({ ...f.options, platform: 'linux', listen: () => { starts++; return { stop: () => { stops++; } }; } }); cleanup.push(() => manager.close());
  expect(starts).toBe(0); f.ready(true); manager.refresh(); const origin = manager.status().origin;
  expect(starts).toBe(1); f.ready(false); manager.refresh(); expect(stops).toBe(1);
  f.ready(true); manager.refresh(); expect(manager.status().origin).not.toBe(origin);
  const mac = manageLinuxOwnerBridge({ ...f.options, platform: 'darwin', listen: () => { throw new Error('Mac must not bind'); } }); mac.close();
});

test('port collision reported without replacing listener', () => {
  const f = fixture(); const manager = manageLinuxOwnerBridge({ ...f.options, listen: () => { throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); } }); cleanup.push(() => manager.close());
  expect(manager.status().state).toBe('port_in_use'); expect(manager.status().remedy).toContain('SSH socket forward');
});

test('redirects never leave on a proof-bearing fetch; native forms keep their redirect', async () => {
  const f = fixture(async () => new Response(null, { status: 303, headers: { Location: 'http://localhost:9999/callback' } })); const owner = await prove(f);
  const r = await f.bridge.handle(f.request('/connect/authorize', { headers: { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }));
  expect(r.status).toBe(200); expect(r.headers.has('location')).toBe(false); expect(r.headers.get('X-Olympus-Owner-Location')).toBe('http://localhost:9999/callback');
});

test('ticket opener passes only a private filename, never either secret, to systemd/xdg-open', async () => {
  const f = fixture(); await f.bridge.openTicket('/dashboard');
  const html = readFileSync(f.opened(), 'utf8'); const value = html.match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  let argv: readonly string[] = [];
  await openLinuxOwnerTicketFile(f.opened(), { trustExecutable: () => true, readiness: () => ({ ready: true, kind: 'wayland', environment: { XDG_RUNTIME_DIR: f.root }, displaySocket: '/fixture' }),
    launch: async args => { argv = args; return { established: true, stderr: '' }; } });
  expect(argv.slice(-2)).toEqual(['/usr/bin/xdg-open', f.opened()]); expect(argv.join(' ')).not.toContain(value); expect(argv.join(' ')).not.toContain(f.bridge.hostname);
});

test('real socket auth wrapper still requires CSRF after owner proof', async () => {
  const handler = withRequestPeer(withWorkerBearerAuth(async () => new Response('private dashboard'), { authToken: 'test-worker', requireOwnerSocket: true }), true);
  const f = fixture(async r => handler(r, { requestIP: () => null })); const owner = await prove(f);
  const response = await f.bridge.handle(f.request('/dashboard/control/session/local', { method: 'POST', headers: { Origin: f.bridge.origin, Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }));
  expect(response.status).toBe(200);
  const dashboardCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const denied = await f.bridge.handle(f.request('/dashboard/control/session/lock', { method: 'POST', headers: { Origin: f.bridge.origin, Cookie: owner.cookie + '; ' + dashboardCookie, 'X-Olympus-Owner-Proof': owner.proof } }));
  expect(denied.status).toBe(403);
});

test('dashboard session establishment follows ticket consumption and cannot publish after revocation', async () => {
  const f = fixture(); let calls = 0;
  const bridge = new LinuxOwnerBridge({ ...f.options, establishDashboard: async () => { calls++; f.ready(false); return ['olympus_dashboard_control=fixture; HttpOnly; Path=/dashboard']; } });
  cleanup.push(() => bridge.close());
  const request = (value: string) => new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: { Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: value }) });
  expect((await bridge.handle(request('forged'))).status).toBe(403); expect(calls).toBe(0);
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const response = await bridge.handle(request(ticket));
  expect(calls).toBe(1); expect(response.status).toBe(503); expect(response.headers.has('Set-Cookie')).toBe(false);
  f.ready(true); expect((await bridge.handle(request(ticket))).status).toBe(403);
});

test('closing the manager is terminal even if an already pending readiness probe later refreshes it', async () => {
  const f = fixture(); let starts = 0, stops = 0;
  const manager = manageLinuxOwnerBridge({ ...f.options, listen: () => { starts++; return { stop: () => { stops++; } }; } });
  let resolveProbe!: () => void;
  const pendingProbe = new Promise<void>(resolve => { resolveProbe = resolve; }).finally(() => manager.refresh());
  expect(starts).toBe(1);
  manager.close(); resolveProbe(); await pendingProbe;
  expect(stops).toBe(1); expect(starts).toBe(1); expect(manager.status().state).toBe('headless');
  await expect(manager.open('/dashboard')).rejects.toThrow();
  manager.refresh(); expect(starts).toBe(1);
});
