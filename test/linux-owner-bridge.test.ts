import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
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
  // The owner's own opens are never refused, even straight after another (an olympus:// link right after the launcher).
  await f.bridge.openTicket('/dashboard');
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

test('a proven upload piece reaches the worker byte for byte, however large; an unproven one is refused unread', async () => {
  let received: Uint8Array | undefined; let type = null as string | null;
  const f = fixture(async r => { received = new Uint8Array(await r.arrayBuffer()); type = r.headers.get('content-type'); return Response.json({ ok: true }); });
  const owner = await prove(f);
  // 8 MiB (a whole piece) that is not text: four bytes no UTF-8 reader accepts, then binary noise.
  const piece = new Uint8Array(8 * 1024 * 1024);
  piece.set([0xff, 0xfe, 0xc3, 0x28]);
  for (let at = 4; at < piece.length; at += 4096) piece[at] = at % 251;
  const upload = (headers: Record<string, string>) => f.bridge.handle(f.request('/dashboard/archive-import/upload-file', {
    method: 'POST', body: piece, headers: { Origin: f.bridge.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream', ...headers },
  }));
  expect((await upload({ Cookie: owner.cookie })).status).toBe(403);
  expect(received).toBeUndefined();
  const response = await upload({ Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof });
  expect(response.status).toBe(200);
  expect(type).toBe('application/octet-stream');
  expect(received!.length).toBe(piece.length);
  expect(Buffer.from(received!).equals(Buffer.from(piece))).toBe(true);
});

test('an upload piece whose sender goes away ends at the worker too', async () => {
  let forwarded: AbortSignal | undefined;
  const f = fixture(async r => { forwarded = r.signal; return Response.json({ ok: true }); });
  const owner = await prove(f);
  const sender = new AbortController();
  await f.bridge.handle(f.request('/dashboard/archive-import/upload-file', {
    method: 'POST', body: new Uint8Array([1, 2, 3]), signal: sender.signal,
    headers: { Origin: f.bridge.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream', Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof },
  }));
  expect(forwarded?.aborted).toBe(false);
  sender.abort();
  expect(forwarded?.aborted).toBe(true);
});

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

test('opening view stays in the launched window and owner redemption refuses absent presence and replay', async () => {
  const f = fixture(); await f.bridge.openTicket('/dashboard');
  const file = readFileSync(f.opened(), 'utf8');
  const proofView = await (await f.bridge.handle(f.request('/owner-proof'))).text();
  for (const html of [file, proofView]) {
    expect(html).toContain('<h1>Olympus</h1>');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/window\.(open|close)\(/);
  }
  const ticket = file.match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  f.ready(false);
  const refused = await f.bridge.handle(f.post('/owner-proof', { ticket }));
  expect(refused.status).toBe(503); expect(refused.headers.has('Set-Cookie')).toBe(false);
  f.ready(true);
  expect((await f.bridge.handle(f.post('/owner-proof', { ticket }))).status).toBe(200);
  expect((await f.bridge.handle(f.post('/owner-proof', { ticket }))).status).toBe(403);
});

test('a released listener can never restore an epoch, even from a legacy session file', async () => {
  const f = fixture(); const owner = await prove(f);
  f.bridge.close();
  writeFileSync(join(f.root, 'olympus', 'owner-bridge-sessions.json'), JSON.stringify({ version: 1, origin: f.bridge.origin, sessions: [{
    cookieHash: new Bun.CryptoHasher('sha256').update(owner.cookie.split('=')[1]!).digest('hex'),
    proofHash: new Bun.CryptoHasher('sha256').update(owner.proof).digest('hex'), expires: 100_000 + 12 * 60 * 60 * 1000,
  }] }), { mode: 0o600 });
  const next = new LinuxOwnerBridge(f.options); cleanup.push(() => next.close());
  expect(next.origin).not.toBe(f.bridge.origin);
  expect((await next.handle(new Request(next.origin + '/dashboard.json', { headers: {
    Host: new URL(next.origin).host, Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof,
  } }))).status).toBe(403);
});

test('in-memory owner sessions expire at twelve hours and cap at fifteen', async () => {
  const f = fixture(); const owners = [await prove(f)];
  for (let i = 0; i < 15; i++) { f.advance(10_001); owners.push(await prove(f)); }
  const read = (o: typeof owners[number]) => f.bridge.handle(f.request('/dashboard.json', { headers: { Cookie: o.cookie, 'X-Olympus-Owner-Proof': o.proof } }));
  expect((await read(owners[0]!)).status).toBe(403);
  expect((await read(owners.at(-1)!)).status).toBe(200);
  f.advance(12 * 60 * 60 * 1000);
  expect((await read(owners.at(-1)!)).status).toBe(403);
});

test('Linux dashboard cookie and CSRF survive worker auth-wrapper reload behind a held listener', async () => {
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
  handler = worker();
  const next = bridge;
  expect(next.origin).toBe(bridge.origin);
  const after = await next.handle(request('/dashboard', { headers }));
  expect(after.status).toBe(200); expect((await after.json() as { csrf: string }).csrf).toBe(csrf);
  expect((await next.handle(request('/dashboard/control/session/lock', { method: 'POST', headers: { ...headers, Origin: next.origin, 'X-Olympus-CSRF': csrf } }))).status).toBe(200);
});

test('engine-hosted dashboard waiting page reports a data-owner conflict and clears after readiness', async () => {
  const f = fixture(); let ready = false;
  const bridge = new LinuxOwnerBridge({ ...f.options, workerReady: () => ready, workerConflict: () => ready ? undefined : 'data' });
  cleanup.push(() => bridge.close());
  await bridge.openTicket('/dashboard');
  const response = await bridge.handle(new Request(bridge.origin + '/dashboard', { headers: { Host: new URL(bridge.origin).host } }));
  expect(response.status).toBe(503);
  expect(response.headers.get('X-Olympus-Worker-Conflict')).toBe('data');
  expect(await response.text()).toContain('olympus worker uninstall');
  // The private ticket waits for the challenge before navigation; it must
  // show the conflict there too, rather than loop forever on 'restarting'.
  expect(readFileSync(f.opened(), 'utf8')).toContain('X-Olympus-Worker-Conflict');
  const proof = await bridge.handle(new Request(bridge.origin + '/owner-proof', { headers: { Host: new URL(bridge.origin).host } }));
  const proofHtml = await proof.text();
  expect(proofHtml).toContain('X-Olympus-Worker-Conflict');
  for (const html of [readFileSync(f.opened(), 'utf8'), proofHtml]) {
    const message = { textContent: '' };
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    // Exercise the emitted waiting script with the real 503 headers. Keep its
    // retry timer pending so it cannot navigate or spend a ticket in this test.
    runInNewContext(script, { document: { getElementById: () => message },
      location: { hash: '#fixture', pathname: '/owner-proof' }, history: { replaceState() {} },
      fetch: async () => new Response(null, { status: 503, headers: { 'Retry-After': '1', 'X-Olympus-Worker-Conflict': 'data' } }),
      setTimeout() {} });
    await Bun.sleep(0);
    expect(message.textContent).toContain('another process owns its data');
    expect(message.textContent).toContain('olympus worker uninstall');
  }
  ready = true;
  const after = await bridge.handle(new Request(bridge.origin + '/dashboard', { headers: { Host: new URL(bridge.origin).host } }));
  expect(await after.text()).not.toContain('olympus worker uninstall');
});

test('listener challenge authenticates only the live ticket, including restart retries', async () => {
  const f = fixture(); let workerReady = false;
  const bridge = new LinuxOwnerBridge({ ...f.options, workerReady: () => workerReady });
  cleanup.push(() => bridge.close());
  await bridge.openTicket('/dashboard');
  const html = readFileSync(f.opened(), 'utf8');
  const ticket = html.match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const challenge = html.match(/owner-proof\?challenge=([A-Za-z0-9_-]{43})/)![1]!;
  const get = (suffix: string) => bridge.handle(new Request(bridge.origin + suffix, { headers: { Host: new URL(bridge.origin).host } }));
  const retry = await get('/owner-proof?challenge=' + challenge);
  expect(retry.status).toBe(503);
  expect(retry.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(retry.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After, X-Olympus-Worker-Conflict');
  expect(await retry.text()).not.toContain(ticket);
  // Navigation must load the ticket redemption logic even during a restart.
  const navigation = await get('/owner-proof');
  expect(navigation.status).toBe(200);
  expect(await navigation.text()).toContain('Olympus is restarting');
  workerReady = true;
  const { createHmac } = await import('node:crypto');
  const answer = createHmac('sha256', ticket).update(challenge).digest('base64url');
  expect(await (await get('/owner-proof?challenge=' + challenge)).text()).toBe(answer);
  expect((await get('/owner-proof?challenge=unknown')).status).toBe(403);
  bridge.close();
  expect((await get('/owner-proof?challenge=' + challenge)).status).toBe(503);
});

test('IPv6 collision refuses the whole listener; release and rebind rotate both families', async () => {
  const f = fixture();
  const reserve = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('squatter') });
  const port = reserve.port!;
  const manager = manageLinuxOwnerBridge({ ...f.options, port, platform: 'linux' });
  cleanup.push(() => manager.close());
  try {
    expect(manager.status().state).toBe('port_in_use');
    // The successfully acquired IPv4 half must have been released too.
    const v4 = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() });
    await v4.stop(true);
  } finally { await reserve.stop(true); }
  manager.refresh(); expect(manager.status().state).toBe('listening');
  expect(manager.status().ipv6).toBe('listening');
  const first = manager.status().origin;
  for (const hostname of ['127.0.0.1', '::1']) expect(() => Bun.serve({ hostname, port, fetch: () => new Response() })).toThrow();
  f.ready(false); manager.refresh();
  for (const hostname of ['127.0.0.1', '::1']) {
    const probe = Bun.serve({ hostname, port, fetch: () => new Response() });
    await probe.stop(true);
  }
  f.ready(true); manager.refresh();
  expect(manager.status().origin).not.toBe(first);
});


// The review's ephemeral-port exhaustion repro: ::1 still exists when a
// port-zero bind fails. Keep the routine regression bounded (no 28k sockets).
for (const oracle of ['kernel', 'present', 'throws'] as const) {
  for (const bindFails of [false, true]) {
    test(`IPv6 exhaustion cannot publish IPv4 alone (oracle=${oracle}, bindFails=${bindFails})`, async () => {
      const f = fixture();
      const serve = Bun.serve.bind(Bun);
      const reserve = serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
      const port = reserve.port!; await reserve.stop(true);
      const mock = spyOn(Bun, 'serve').mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
        if (options.hostname === '::1' && (options.port === 0 || bindFails)) {
          throw Object.assign(new Error('IPv6 bind refused under resource exhaustion'), { code: 'EADDRINUSE' });
        }
        return serve(options);
      }) as typeof Bun.serve);
      let manager: ReturnType<typeof manageLinuxOwnerBridge> | undefined;
      try {
        manager = manageLinuxOwnerBridge({ ...f.options, port, platform: 'linux',
          ...(oracle === 'kernel' ? {} : { ipv6Present: () => {
            if (oracle === 'throws') throw new Error('Kernel address enumeration failed');
            return true;
          } }),
        });
        if (bindFails) {
          expect(manager.status().state).toBe('port_in_use');
          await expect(manager.open('/dashboard')).rejects.toThrow();
          expect(f.opened()).toBe('');
          // Even a successful IPv4 bind must have been released.
          const v4 = serve({ hostname: '127.0.0.1', port, fetch: () => new Response() });
          await v4.stop(true);
        } else {
          expect(manager.status().state).toBe('listening');
          expect(manager.status().ipv6).toBe('listening');
          expect(() => serve({ hostname: '::1', port, fetch: () => new Response() })).toThrow();
        }
      } finally { manager?.close(); mock.mockRestore(); }
    });
  }
}

for (const collision of [false, true]) {
  test(`IPv6 appearing revokes the IPv4 epoch and takes both families (squatter=${collision})`, async () => {
    const f = fixture();
    const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reserve.port!; await reserve.stop(true);
    let ipv6 = false, probes = 0;
    const manager = manageLinuxOwnerBridge({ ...f.options, port, platform: 'linux', ipv6Present: () => { probes++; return ipv6; } });
    cleanup.push(() => manager.close());
    const status = manager.status();
    expect(status.state).toBe('listening'); expect(status.ipv6).toBe('unavailable');
    const oldOrigin = status.origin!;
    manager.refresh(); expect(probes).toBeGreaterThan(1);
    expect(manager.status().origin).toBe(oldOrigin);
    await manager.open('/dashboard');
    const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
    const call = (origin: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...init, redirect: 'manual', headers: { Host: new URL(origin).host, ...Object.fromEntries(new Headers(init.headers)) },
    });
    const response = await call(oldOrigin, '/owner-proof', { method: 'POST', headers: { Origin: oldOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { proof } = await response.json() as { proof: string };
    const headers = { Cookie: cookie, 'X-Olympus-Owner-Proof': proof };
    expect(await (await call(oldOrigin, '/dashboard.json', { headers })).text()).toBe('private dashboard');
    f.advance(10_001); await manager.open('/dashboard');
    const pendingFile = f.opened();
    const pendingTicket = readFileSync(pendingFile, 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
    const squatter = collision ? Bun.serve({ hostname: '::1', port, fetch: () => new Response('squatter') }) : undefined;
    try {
      ipv6 = true; manager.refresh();
      expect(existsSync(pendingFile)).toBe(false);
      if (squatter) {
        expect(manager.status().state).toBe('port_in_use');
        const v4 = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() });
        await v4.stop(true); await squatter.stop(true);
        manager.refresh();
      }
      const current = manager.status();
      expect(current.state).toBe('listening'); expect(current.ipv6).toBe('listening');
      expect(current.origin).not.toBe(oldOrigin);
      expect((await call(oldOrigin, '/dashboard.json', { headers })).status).toBe(421);
      expect((await call(current.origin!, '/dashboard.json', { headers })).status).toBe(403);
      expect((await call(current.origin!, '/owner-proof', { method: 'POST', headers: { Origin: current.origin!, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: pendingTicket }) })).status).toBe(403);
      for (const hostname of ['127.0.0.1', '::1']) expect(() => Bun.serve({ hostname, port, fetch: () => new Response() })).toThrow();
    } finally { await squatter?.stop(true); }
  });
}

test('browser opens have a rolling six-per-hour cap independent of CLI tickets and limits', async () => {
  const f = fixture();
  await f.bridge.openTicket('/connect/authorize?state=owner');
  const cliFile = f.opened();
  for (let i = 0; i < 6; i++) {
    expect((await f.bridge.handle(f.post('/owner-open', { target: '/connect/authorize?state=attacker' }))).status).toBe(204);
    if (i === 0) {
      const tooSoon = await f.bridge.handle(f.post('/owner-open', {}));
      expect(tooSoon.status).toBe(429); expect(tooSoon.headers.get('Retry-After')).toBe('10');
      expect(await tooSoon.text()).toContain('A window was just opened. Look for it, or try again in a few seconds.');
      expect(tooSoon.headers.get('X-Olympus-Owner-Limit')).toBe('recent');
    }
    expect(existsSync(cliFile)).toBe(true);
    const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
    const redeemed = await f.bridge.handle(f.post('/owner-proof', { ticket }));
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json() as { target: string }).target).toBe('/dashboard');
    f.advance(10_000);
  }
  const refused = await f.bridge.handle(f.post('/owner-open', {}));
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get('Retry-After'))).toBe(3540);
  expect(refused.headers.get('X-Olympus-Owner-Limit')).toBe('hourly');
  expect(await refused.text()).toContain('Too many windows were opened from the browser. Run olympus dashboard in a terminal on this computer.');
  await expect(f.bridge.openTicket('/connect/authorize?state=still-owner')).resolves.toBeUndefined();
  f.advance(3_539_999); // one millisecond before the first open ages out
  const nearlyExpired = await f.bridge.handle(f.post('/owner-open', {}));
  expect(nearlyExpired.status).toBe(429);
  // A short Retry-After from the hourly cap is still the hourly cap.
  expect(Number(nearlyExpired.headers.get('Retry-After'))).toBeLessThanOrEqual(10);
  expect(nearlyExpired.headers.get('X-Olympus-Owner-Limit')).toBe('hourly');
  f.advance(1);
  expect((await f.bridge.handle(f.post('/owner-open', {}))).status).toBe(204);
  // Only the oldest opening has expired, so the rolling window is full again.
  f.advance(10_000);
  expect((await f.bridge.handle(f.post('/owner-open', {}))).status).toBe(204);
  expect((await f.bridge.handle(f.request('/dashboard.json'))).status).toBe(403);
});

test('right after the sixth browser open, the refusal is the hourly cap, not the ten-second spacing', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    if (i > 0) f.advance(10_000);
    expect((await f.bridge.handle(f.post('/owner-open', {}))).status).toBe(204);
  }
  const refused = await f.bridge.handle(f.post('/owner-open', {}));
  expect(refused.status).toBe(429);
  expect(refused.headers.get('X-Olympus-Owner-Limit')).toBe('hourly');
  expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(10);
  expect(await refused.text()).toContain('Too many windows were opened from the browser.');
});

test('a browser open whose window fails to launch is reported as a failure, not as the hourly limit', async () => {
  const f = fixture();
  const launch = f.options.openFile;
  f.options.openFile = async () => { throw new Error('no desktop launcher'); };
  const failed = await f.bridge.handle(f.post('/owner-open', {}));
  expect(failed.status).toBe(503);
  expect(failed.headers.get('Retry-After')).toBeNull();
  const body = await failed.text();
  expect(body).toContain('Unable to open the private ticket. Run olympus dashboard in a terminal on this computer.');
  expect(body).not.toContain('Too many windows');
  // No window opened, so neither limiter counted it: six failures later, a working launcher still opens.
  for (let i = 0; i < 6; i++) expect((await f.bridge.handle(f.post('/owner-open', {}))).status).toBe(503);
  f.options.openFile = launch;
  expect((await f.bridge.handle(f.post('/owner-open', {}))).status).toBe(204);
});

test('a claimed ticket retries a restarted socket without concurrent redemption or expiry extension', async () => {
  const f = fixture(); let calls = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const bridge = new LinuxOwnerBridge({ ...f.options, establishDashboard: async () => {
    if (++calls === 1) { await pending; throw new Error('Worker socket restarted'); }
    return [];
  } });
  cleanup.push(() => bridge.close());
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const request = () => new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: { Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const first = bridge.handle(request());
  await Bun.sleep(1);
  expect(existsSync(f.opened())).toBe(false);
  const duplicate = await bridge.handle(request());
  expect(duplicate.status).toBe(503); expect(duplicate.headers.get('Retry-After')).toBe('1');
  expect(calls).toBe(1);
  release();
  const retry = await first;
  expect(retry.status).toBe(503); expect(retry.headers.get('Retry-After')).toBe('1');
  expect(retry.headers.has('Set-Cookie')).toBe(false);
  expect((await bridge.handle(request())).status).toBe(200);
  expect(calls).toBe(2);
  expect((await bridge.handle(request())).status).toBe(403);
  f.advance(10_001); await bridge.openTicket('/dashboard');
  const expiring = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  f.advance(60_001);
  expect((await bridge.handle(new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: { Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: expiring }) }))).status).toBe(403);
});

test('expiry, replacement, close and logout invalidate pending claims on either settlement outcome', async () => {
  for (const invalidate of ['expiry', 'replacement', 'close', 'logout']) for (const outcome of ['success', 'failure']) {
    const f = fixture(); let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const bridge = new LinuxOwnerBridge({ ...f.options, establishDashboard: async () => {
      await pending; if (outcome === 'failure') throw new Error('Worker unavailable'); return [];
    } });
    cleanup.push(() => bridge.close());
    await bridge.openTicket('/dashboard');
    const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
    const request = () => new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: { Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
    const response = bridge.handle(request()); await Bun.sleep(1);
    if (invalidate === 'expiry') f.advance(60_001);
    if (invalidate === 'replacement') { f.advance(10_001); await bridge.openTicket('/dashboard'); }
    if (invalidate === 'close') bridge.close();
    if (invalidate === 'logout') f.ready(false);
    settle(); const refused = await response;
    expect(refused.status).toBe(503); expect(refused.headers.has('Set-Cookie')).toBe(false);
    expect(refused.headers.has('Retry-After')).toBe(false);
    if (invalidate === 'logout') f.ready(true);
    expect((await bridge.handle(request())).status).toBe(invalidate === 'close' ? 503 : 403);
    if (invalidate === 'replacement') expect(existsSync(f.opened())).toBe(true);
  }
});

test('a claim released at 59 seconds still expires at its original deadline', async () => {
  const f = fixture(); let settle!: () => void;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  const bridge = new LinuxOwnerBridge({ ...f.options, establishDashboard: async () => { await pending; throw new Error('Worker gone'); } });
  cleanup.push(() => bridge.close());
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const request = () => new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: { Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const response = bridge.handle(request()); await Bun.sleep(1);
  f.advance(59_000); settle();
  expect((await response).headers.get('Retry-After')).toBe('1');
  f.advance(1_001);
  expect((await bridge.handle(request())).status).toBe(403);
});

test('a worker session refusal permanently spends the claim instead of retrying as a restart', async () => {
  const f = fixture(); let calls = 0;
  const bridge = new LinuxOwnerBridge({ ...f.options, establishDashboard: async () => { calls++; return null; } });
  cleanup.push(() => bridge.close());
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const request = () => new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: { Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const response = await bridge.handle(request());
  expect(response.status).toBe(403); expect(response.headers.has('Retry-After')).toBe(false);
  expect(response.headers.has('Set-Cookie')).toBe(false);
  expect((await bridge.handle(request())).status).toBe(403); expect(calls).toBe(1);
});

test('a waiting page in another browser continues only after an Olympus window approves its code, once', async () => {
  const f = fixture();
  const owner = await prove(f);
  const opened = await f.bridge.handle(f.post('/owner-open', {}));
  expect(opened.status).toBe(204);
  const claim = opened.headers.get('X-Olympus-Owner-Claim')!, code = opened.headers.get('X-Olympus-Owner-Code')!, id = opened.headers.get('X-Olympus-Owner-Approval')!;
  expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  // Until the Olympus window redeems its ticket and the owner approves there, the claim only waits.
  expect((await f.bridge.handle(f.post('/owner-claim', { claim }))).status).toBe(202);
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  const redeemed = await f.bridge.handle(f.post('/owner-proof', { ticket }));
  const window = await redeemed.json() as { proof: string; approval: { id: string; code: string } };
  expect(window.approval).toEqual({ id, code });
  const windowCookie = redeemed.headers.get('set-cookie')!.split(';')[0]!;
  const approve = (headers: Record<string, string>, body: object) => f.bridge.handle(f.request('/owner-approve', { method: 'POST',
    headers: { Origin: f.bridge.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: JSON.stringify(body) }));
  // The approval id alone, or a proof without its cookie, approves nothing.
  expect((await approve({}, { id, approve: true })).status).toBe(403);
  expect((await approve({ 'X-Olympus-Owner-Proof': window.proof }, { id, approve: true })).status).toBe(403);
  expect((await approve({ Cookie: windowCookie, 'X-Olympus-Owner-Proof': window.proof }, { id: 'x'.repeat(43), approve: true })).status).toBe(403);
  expect((await f.bridge.handle(f.post('/owner-claim', { claim }))).status).toBe(202);
  expect((await approve({ Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof }, { id, approve: true })).status).toBe(204);
  const collected = await f.bridge.handle(f.post('/owner-claim', { claim }));
  expect(collected.status).toBe(200);
  const page = await collected.json() as { proof: string };
  const pageCookie = collected.headers.get('set-cookie')!.split(';')[0]!;
  expect((await f.bridge.handle(f.request('/dashboard.json', { headers: { Cookie: pageCookie, 'X-Olympus-Owner-Proof': page.proof } }))).status).toBe(200);
  // Collected once; a guessed claim never collects.
  expect((await f.bridge.handle(f.post('/owner-claim', { claim }))).status).toBe(403);
  expect((await f.bridge.handle(f.post('/owner-claim', { claim: 'y'.repeat(43) }))).status).toBe(403);
});

test('a declined, replaced or expired waiting page gets no access', async () => {
  const f = fixture();
  const open = async () => {
    const r = await f.bridge.handle(f.post('/owner-open', {}));
    const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
    return { claim: r.headers.get('X-Olympus-Owner-Claim')!, id: r.headers.get('X-Olympus-Owner-Approval')!, ticket };
  };
  const answer = async (ticket: string, id: string, approve: boolean) => {
    const redeemed = await f.bridge.handle(f.post('/owner-proof', { ticket }));
    const { proof } = await redeemed.json() as { proof: string };
    const cookie = redeemed.headers.get('set-cookie')!.split(';')[0]!;
    return f.bridge.handle(f.request('/owner-approve', { method: 'POST', headers: { Origin: f.bridge.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'X-Olympus-Owner-Proof': proof }, body: JSON.stringify({ id, approve }) }));
  };
  const declined = await open();
  expect((await answer(declined.ticket, declined.id, false)).status).toBe(204);
  const refused = await f.bridge.handle(f.post('/owner-claim', { claim: declined.claim }));
  expect(refused.status).toBe(403); expect(refused.headers.get('X-Olympus-Owner-Declined')).toBe('1');
  f.advance(10_000);
  const replaced = await open();
  f.advance(10_000);
  const current = await open();
  expect((await f.bridge.handle(f.post('/owner-claim', { claim: replaced.claim }))).status).toBe(403);
  // The replaced window's ticket is gone; the current one is asked about.
  expect((await f.bridge.handle(f.post('/owner-proof', { ticket: replaced.ticket }))).status).toBe(403);
  f.advance(3 * 60_000);
  expect((await f.bridge.handle(f.post('/owner-claim', { claim: current.claim }))).status).toBe(403);
});

test('an owner open right after another opens a window, and the newer ticket replaces the pending one', async () => {
  const f = fixture();
  await f.bridge.openTicket('/dashboard');
  const first = f.opened();
  await f.bridge.openTicket('/dashboard');
  const second = f.opened();
  expect(second).not.toBe(first);
  expect(existsSync(first)).toBe(false);
  const ticket = readFileSync(second, 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  expect((await f.bridge.handle(f.post('/owner-proof', { ticket }))).status).toBe(200);
});


for (const phase of ['body', 'session']) test(`owner proof mints no cookies after worker ownership is lost during ${phase}`, async () => {
  const f = fixture(); let owned = true, calls = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const bridge = new LinuxOwnerBridge({ ...f.options, workerReady: () => owned,
    establishDashboard: async () => { calls++; await pending; return ['olympus_dashboard_control=FOREIGN; Path=/']; } });
  cleanup.push(() => bridge.close());
  await bridge.openTicket('/dashboard');
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  let response: Promise<Response>;
  if (phase === 'body') {
    const body = new ReadableStream<Uint8Array>({ async start(controller) { await pending; controller.enqueue(new TextEncoder().encode(JSON.stringify({ticket}))); controller.close(); } });
    response = bridge.handle(new Request(bridge.origin + '/owner-proof', { method: 'POST', headers: {Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json'}, body, duplex: 'half' } as RequestInit));
    await Bun.sleep(1); owned = false; release();
  } else {
    response = bridge.handle(new Request(bridge.origin + '/owner-proof', {method: 'POST', headers: {Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json'}, body: JSON.stringify({ticket})}));
    await Bun.sleep(1); expect(calls).toBe(1); owned = false; release();
  }
  const refused = await response;
  expect(refused.status).toBe(503);
  expect(refused.headers.has('Set-Cookie')).toBe(false);
  if (phase === 'body') expect(calls).toBe(0);
});


for (const phase of ['body', 'session']) test(`approved owner claim mints no cookies after worker ownership is lost during ${phase}`, async () => {
  const f = fixture(); let owned = true, armed = false, calls = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const bridge = new LinuxOwnerBridge({ ...f.options, workerReady: () => owned,
    establishDashboard: async () => { if (!armed) return []; calls++; await pending; return ['olympus_dashboard_control=FOREIGN; Path=/']; } });
  cleanup.push(() => bridge.close());
  const request = (path: string, init: RequestInit = {}) => new Request(bridge.origin + path, {...init, headers: {Host: new URL(bridge.origin).host, ...Object.fromEntries(new Headers(init.headers))}});
  const post = (path: string, body: object) => request(path, {method: 'POST', headers: {Origin: bridge.origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const custom = {...f, bridge, request, post};
  const owner = await prove(custom);
  const opened = await bridge.handle(custom.post('/owner-open', {}));
  const claim = opened.headers.get('X-Olympus-Owner-Claim')!, id = opened.headers.get('X-Olympus-Owner-Approval')!;
  const ticket = readFileSync(f.opened(), 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
  expect((await bridge.handle(custom.post('/owner-proof', {ticket}))).status).toBe(200);
  expect((await bridge.handle(custom.request('/owner-approve', {method: 'POST', headers: {Origin: bridge.origin, 'Content-Type': 'application/json', Cookie: owner.cookie, 'X-Olympus-Owner-Proof': owner.proof}, body: JSON.stringify({id, approve: true})}))).status).toBe(204);
  armed = true;
  let response: Promise<Response>;
  if (phase === 'body') {
    const body = new ReadableStream<Uint8Array>({ async start(controller) { await pending; controller.enqueue(new TextEncoder().encode(JSON.stringify({claim}))); controller.close(); } });
    response = bridge.handle(new Request(bridge.origin + '/owner-claim', {method: 'POST', headers: {Host: new URL(bridge.origin).host, Origin: bridge.origin, 'Content-Type': 'application/json'}, body, duplex: 'half'} as RequestInit));
    await Bun.sleep(1); owned = false; release();
  } else {
    response = bridge.handle(custom.post('/owner-claim', {claim}));
    await Bun.sleep(1); expect(calls).toBe(1); owned = false; release();
  }
  const refused = await response;
  expect(refused.status).toBe(503);
  expect(refused.headers.has('Set-Cookie')).toBe(false);
  if (phase === 'body') expect(calls).toBe(0);
});
