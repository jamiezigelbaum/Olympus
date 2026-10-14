import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxOwnerBridge, manageLinuxOwnerBridge, randomOwnerHostname } from '../src/core/linux-owner-bridge.ts';
import { prepareWorkerSocket, bindWorkerSocket } from '../src/core/worker-transport.ts';
import { openLinuxOwnerTicketFile } from '../src/core/linux-desktop-opener.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { loadOrCreateDashboardSessionSecret } from '../src/core/dashboard-session-secret.ts';
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

test('no cookie, forged headers, stolen cross-port cookie and another-runtime cookie cannot read or approve', async () => {
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
  const second = fixture().bridge;
  const r = await second.handle(new Request(second.origin + '/dashboard', { headers: { Host: new URL(second.origin).host, Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }));
  expect(r.status).toBe(403);
  expect(await r.text()).toContain('<p>This Olympus window is out of date, usually because Olympus restarted. Close it and open Olympus again.</p>');
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
  await openLinuxOwnerTicketFile(f.opened(), { trustExecutable: path => path !== '/usr/bin/omarchy-launch-webapp', readiness: () => ({ ready: true, kind: 'wayland', environment: { XDG_RUNTIME_DIR: f.root }, displaySocket: '/fixture' }),
    launch: async args => { argv = args; return { established: true, stderr: '' }; } });
  expect(argv.slice(-2)).toEqual(['/usr/bin/xdg-open', f.opened()]); expect(argv.join(' ')).not.toContain(value); expect(argv.join(' ')).not.toContain(f.bridge.hostname);
});

test('on Omarchy the ticket opens in its own app window, and in the browser when that launch fails', async () => {
  const f = fixture(); await f.bridge.openTicket('/dashboard');
  const html = readFileSync(f.opened(), 'utf8'); const value = html.match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const readiness = () => ({ ready: true as const, kind: 'wayland' as const, environment: { XDG_RUNTIME_DIR: f.root }, displaySocket: '/fixture' });
  const launches: (readonly string[])[] = [];
  await openLinuxOwnerTicketFile(f.opened(), { trustExecutable: () => true, readiness,
    launch: async args => { launches.push(args); return { established: true, stderr: '' }; } });
  expect(launches.map(args => args.slice(-2))).toEqual([['/usr/bin/omarchy-launch-webapp', `file://${f.opened()}`]]);
  expect(launches[0]!.join(' ')).not.toContain(value); expect(launches[0]!.join(' ')).not.toContain(f.bridge.hostname);

  launches.length = 0;
  await openLinuxOwnerTicketFile(f.opened(), { trustExecutable: () => true, readiness,
    launch: async args => { launches.push(args); return { established: args.includes('/usr/bin/xdg-open'), stderr: '' }; } });
  expect(launches.map(args => args.at(-2))).toEqual(['/usr/bin/omarchy-launch-webapp', '/usr/bin/xdg-open']);

  await expect(openLinuxOwnerTicketFile(f.opened(), { trustExecutable: () => true, readiness,
    launch: async () => ({ established: false, stderr: '' }) })).rejects.toThrow('did not open');
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

test('only owner-proven requests can outlive the TCP idle deadline', async () => {
  const f = fixture(); let admitted = 0;
  let bridge!: LinuxOwnerBridge;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 1, fetch: (r, s) => bridge.handle(r, () => { admitted++; s.timeout(r, 0); }) });
  bridge = new LinuxOwnerBridge({ ...f.options, port: server.port!, fetchSocket: async () => { await Bun.sleep(1500); return new Response('completed owner operation'); } });
  cleanup.push(() => { bridge.close(); server.stop(true); });
  const host = new URL(bridge.origin).host;
  const entry = `http://127.0.0.1:${server.port}`;
  expect((await fetch(entry + '/dashboard', { headers: { Host: host } })).status).toBe(403); expect(admitted).toBe(0);
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const proved = await fetch(entry + '/owner-proof', { method: 'POST', headers: { Host: host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const { proof } = await proved.json() as { proof: string };
  expect(admitted).toBe(0);
  const response = await fetch(entry + '/dashboard', { headers: { Host: host, Cookie: proved.headers.get('set-cookie')!.split(';')[0]!, 'X-Olympus-Owner-Proof': proof } });
  expect(await response.text()).toBe('completed owner operation'); expect(admitted).toBe(1);
});

// Independent of the bridge: which inline script a CSP list lets run.
function allowsInline(policy: string, script: string): boolean {
  const directives = policy.split(';').map(s => s.trim().split(/\s+/));
  const list = (directives.find(d => d[0] === 'script-src') ?? directives.find(d => d[0] === 'default-src'))?.slice(1);
  if (!list) return true;
  const hash = `'sha256-${new Bun.CryptoHasher('sha256').update(script).digest('base64')}'`;
  if (list.includes(hash)) return true;
  if (list.some(s => /^'(sha256|sha384|sha512|nonce)-/.test(s))) return false;
  return list.includes("'unsafe-inline'");
}

test('bridged pages keep every inline script the worker allowed, and the bootstrap always runs', async () => {
  const pageScript = 'window.controls=1';
  const pageHash = `'sha256-${new Bun.CryptoHasher('sha256').update(pageScript).digest('base64')}'`;
  const cases: [string | undefined, boolean][] = [
    ["frame-ancestors 'none'", true], // the Agents page: no script restriction at all
    [undefined, true],
    [`default-src 'none'; script-src ${pageHash}; frame-ancestors 'none'`, true],
    ["default-src 'none'; script-src 'unsafe-inline'", true],
    ["default-src 'self'", false],
    ["default-src 'none'", false],
  ];
  for (const [upstream, pageAllowed] of cases) {
    const f = fixture(async () => new Response(`<!doctype html><html><head><title>t</title></head><body><script>${pageScript}</script></body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...(upstream ? { 'Content-Security-Policy': upstream } : {}) } }));
    const owner = await prove(f);
    const response = await f.bridge.handle(f.request('/dashboard?agents', { headers: { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }));
    const html = await response.text();
    const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    for (const policy of [response.headers.get('content-security-policy')!, meta]) {
      expect([upstream, allowsInline(policy, pageScript)]).toEqual([upstream, pageAllowed]);
      expect([upstream, allowsInline(policy, bootstrap)]).toEqual([upstream, true]);
      expect(policy).toContain("worker-src 'none'");
    }
    expect(meta).not.toContain('frame-ancestors');
  }
});

const statePath = (f: ReturnType<typeof fixture>) => join(f.root, 'olympus', 'owner-bridge-sessions.json');
function restart(f: ReturnType<typeof fixture>) {
  f.bridge.close();
  const bridge = new LinuxOwnerBridge(f.options);
  cleanup.push(() => bridge.close());
  return bridge;
}

test('worker restart retains origin and hashed owner sessions, never tickets or raw secrets', async () => {
  const f = fixture(); const owner = await prove(f);
  f.advance(10_001); await f.bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const text = readFileSync(statePath(f), 'utf8');
  for (const value of [owner.cookie.split('=')[1]!, owner.proof, owner.ticket, ticket]) expect(text).not.toContain(value);
  expect(text).not.toContain('ticket');
  expect(statSync(statePath(f)).mode & 0o777).toBe(0o600);
  const bridge = restart(f);
  expect(bridge.origin).toBe(f.bridge.origin);
  const headers = { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof };
  expect((await bridge.handle(f.request('/dashboard.json', { headers }))).status).toBe(200);
  expect((await bridge.handle(f.request('/dashboard/control/save', { method: 'POST', headers: { ...headers, Origin: bridge.origin }, body: '{}' }))).status).toBe(200);
  expect((await bridge.handle(f.post('/owner-proof', { ticket }))).status).toBe(403);
  expect((await bridge.handle(f.request('/dashboard.json', { headers: { ...headers, 'X-Olympus-Owner-Proof': 'forged' } }))).status).toBe(403);
});

test('restart drops expired sessions without extending their lifetime; cap is fifteen', async () => {
  const f = fixture(); const owners = [await prove(f)];
  for (let i = 0; i < 15; i++) { f.advance(10_001); owners.push(await prove(f)); }
  let bridge = restart(f);
  expect(JSON.parse(readFileSync(statePath(f), 'utf8')).sessions).toHaveLength(15);
  const read = (o: typeof owners[number]) => bridge.handle(f.request('/dashboard.json', { headers: { Cookie: o.cookie, 'X-Olympus-Owner-Proof': o.proof } }));
  expect((await read(owners[0]!)).status).toBe(403);
  expect((await read(owners.at(-1)!)).status).toBe(200);
  bridge.close(); f.advance(12 * 60 * 60 * 1000);
  bridge = new LinuxOwnerBridge(f.options); cleanup.push(() => bridge.close());
  expect((await read(owners.at(-1)!)).status).toBe(403);
  expect(JSON.parse(readFileSync(statePath(f), 'utf8')).sessions).toEqual([]);
});

for (const damage of ['malformed', 'digest', 'origin', '0644', 'symlink']) {
  test(`restart rejects and deletes ${damage} session state, retaining today's refusal`, async () => {
    const f = fixture(); const owner = await prove(f); f.bridge.close();
    const path = statePath(f);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (damage === 'malformed') writeFileSync(path, '{');
    if (damage === 'digest') { state.sessions[0].cookieHash = 'forged'; writeFileSync(path, JSON.stringify(state)); }
    if (damage === 'origin') { state.origin = 'http://evil.invalid:18010'; writeFileSync(path, JSON.stringify(state)); }
    if (damage === '0644') chmodSync(path, 0o644);
    if (damage === 'symlink') { rmSync(path); symlinkSync(join(f.root, 'foreign-target'), path); }
    const bridge = new LinuxOwnerBridge(f.options); cleanup.push(() => bridge.close());
    expect(existsSync(path)).toBe(false);
    expect(bridge.origin).not.toBe(f.bridge.origin);
    expect((await bridge.handle(f.request('/dashboard.json', { headers: { Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }))).status).toBe(421);
    expect((await bridge.handle(new Request(bridge.origin + '/dashboard.json', { headers: { Host: new URL(bridge.origin).host, Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof } }))).status).toBe(403);
  });
}

test('foreign-owned session state is deleted and cannot restore owner presence', async () => {
  const f = fixture(); const owner = await prove(f); f.bridge.close();
  // A synthetic persisted record makes this refusal test fail even on a
  // bridge that has no persistence implementation yet.
  writeFileSync(statePath(f), JSON.stringify({ version: 1, origin: f.bridge.origin, sessions: [{
    cookieHash: new Bun.CryptoHasher('sha256').update(owner.cookie.split('=')[1]!).digest('hex'),
    proofHash: new Bun.CryptoHasher('sha256').update(owner.proof).digest('hex'), expires: 100_000 + 12 * 60 * 60 * 1000,
  }] }), { mode: 0o600 });
  const fstat = fs.fstatSync;
  const custody = spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => new Proxy(fstat(...args), { get: (stat, key) => key === 'uid' ? process.getuid!() + 1 : Reflect.get(stat, key) })) as typeof fs.fstatSync);
  let bridge!: LinuxOwnerBridge;
  try { bridge = new LinuxOwnerBridge(f.options); } finally { custody.mockRestore(); }
  cleanup.push(() => bridge.close());
  expect(bridge.origin).not.toBe(f.bridge.origin); expect(existsSync(statePath(f))).toBe(false);
});

test('Linux dashboard cookie and CSRF survive bridge and worker auth-wrapper restart end to end', async () => {
  const f = fixture();
  const secretPath = join(f.root, 'dashboard-session.secret');
  const worker = () => withRequestPeer(withWorkerBearerAuth(async r => Response.json({ csrf: r.headers.get('X-Olympus-Control-Session-CSRF') }), {
    authToken: 'fixture-bearer', requireOwnerSocket: true, sessionSecret: loadOrCreateDashboardSessionSecret({ path: secretPath }).secret,
  }), true);
  let handler = worker();
  f.options.fetchSocket = async r => handler(r, { requestIP: () => null });
  const bridge = new LinuxOwnerBridge({ ...f.options, establishDashboard: async () => {
    const r = await handler(new Request(f.bridge.entryOrigin + '/dashboard/control/session', { method: 'POST', headers: { Host: new URL(f.bridge.entryOrigin).host, Origin: f.bridge.entryOrigin, Authorization: 'Bearer fixture-bearer' } }), { requestIP: () => null });
    expect(r.status).toBe(200); return r.headers.getSetCookie();
  } });
  cleanup.push(() => bridge.close());
  const request = (path: string, init: RequestInit = {}) => new Request(bridge.origin + path, { ...init, headers: { Host: new URL(bridge.origin).host, ...Object.fromEntries(new Headers(init.headers)) } });
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const proved = await bridge.handle(request('/owner-proof', { method: 'POST', headers: { Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) }));
  const proof = (await proved.json() as { proof: string }).proof;
  const cookies = proved.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const headers = { Cookie: cookies, 'X-Olympus-Owner-Proof': proof };
  const before = await bridge.handle(request('/dashboard', { headers }));
  const csrf = (await before.json() as { csrf: string }).csrf; expect(csrf).toBeTruthy();
  bridge.close(); handler = worker();
  const next = new LinuxOwnerBridge(f.options); cleanup.push(() => next.close());
  expect(next.origin).toBe(bridge.origin);
  const after = await next.handle(request('/dashboard', { headers }));
  expect(after.status).toBe(200); expect((await after.json() as { csrf: string }).csrf).toBe(csrf);
  expect((await next.handle(request('/dashboard/control/session/lock', { method: 'POST', headers: { ...headers, Origin: next.origin, 'X-Olympus-CSRF': csrf } }))).status).toBe(200);
});

test('starting headless after a worker restart revokes the previous desktop epoch', async () => {
  const f = fixture(); await prove(f); const origin = f.bridge.origin; f.bridge.close(); f.ready(false);
  const manager = manageLinuxOwnerBridge({ ...f.options, platform: 'linux', listen: () => ({ stop() {} }) }); cleanup.push(() => manager.close());
  expect(existsSync(statePath(f))).toBe(false);
  f.ready(true); manager.refresh(); expect(manager.status().origin).not.toBe(origin);
});
