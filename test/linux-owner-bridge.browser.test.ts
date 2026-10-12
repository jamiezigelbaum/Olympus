/** Optional real-browser qualification. Run with OLYMPUS_TEST_PLAYWRIGHT set to
 * an installed Playwright ESM entry; never installs packages in the repository. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LinuxOwnerBridge } from '../src/core/linux-owner-bridge.ts';
import { prepareWorkerSocket, bindWorkerSocket } from '../src/core/worker-transport.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { withRequestPeer } from '../src/core/request-peer.ts';
import { mintDashboardOpeningUrl } from '../src/core/dashboard-opening.ts';

import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { createRemoteOAuthHandler } from '../src/workers/remote-oauth/handler.ts';
import { parseRemotePublicBaseUrl } from '../src/core/remote-public-url.ts';

const playwrightPath = process.env.OLYMPUS_TEST_PLAYWRIGHT;
for (const kind of ['chromium', 'firefox']) {
  test.skipIf(!playwrightPath)(`${kind}: native *.localhost resolution, squatter isolation, ticket and protected navigation`, async () => {
    const playwright = await import(playwrightPath!);
    const browser = await playwright[kind].launch({ headless: true, ...(kind === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    const context = await browser.newContext();
    const root = mkdtempSync(join(tmpdir(), 'owner-browser-'));
    const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
    const socketPath = prepareWorkerSocket(transport)!;
    const token = 'browser-fixture-worker';
    const connections = openRemoteConnectionStore(join(root, 'connections.sqlite'));
    const urls = parseRemotePublicBaseUrl('https://relay.example', 'a'.repeat(32));
    if (!urls.enabled) throw new Error('fixture');
    const oauth = withRequestPeer(createRemoteOAuthHandler({ platform: 'linux', publicUrls: urls.urls, connections: () => connections, requireOwnerSocket: true }), true);
    const auth = withRequestPeer(withWorkerBearerAuth(async r => {
      if (new URL(r.url).pathname === '/dashboard') return new Response(`<!doctype html><html><head><title>Owner dashboard</title></head><body><h1>PRIVATE OWNER DASHBOARD</h1><script>fetch("/dashboard.json?token=${dashboardQueryTokenFromWorkerAuthToken(token)}").then(r=>r.json()).then(v=>document.body.dataset.loaded=v.private)</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
      return Response.json({ private: 'yes' });
    }, { authToken: token, requireOwnerSocket: true }), true);
    const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: (r, server) => new URL(r.url).pathname.startsWith('/connect/') ? oauth(r, server) : auth(r, server) }));
    let bridge: LinuxOwnerBridge | undefined;
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(r) {
      if (bridge) return bridge.handle(r);
      if (new URL(r.url).pathname === '/sw.js') return new Response("self.addEventListener('fetch',e=>e.respondWith(fetch(e.request)));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));", { headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' } });
      return new Response('<!doctype html><title>Squatter</title><script>localStorage.setItem("olympus-desktop-owner-v1","planted");navigator.serviceWorker.register("/sw.js");</script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    const callback = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('OAUTH CALLBACK COMPLETE') });
    try {
      const entry = `http://127.0.0.1:${listener.port}`;
      const establishDashboard = async () => {
        const r = await fetch(entry + '/dashboard/control/session', { unix: socketPath, method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: entry } } as RequestInit);
        expect(r.ok).toBe(true); await r.body?.cancel(); return r.headers.getSetCookie();
      };
      const hostile = await context.newPage();
      await hostile.goto(entry);
      await hostile.evaluate(async () => { await navigator.serviceWorker.ready; });
      let ticketPath = '';
      bridge = new LinuxOwnerBridge({ port: listener.port!, socketPath, transport, ready: () => true,
        fetchSocket: r => fetch(r, { unix: socketPath, redirect: 'manual' } as RequestInit), establishDashboard, openFile: async p => { ticketPath = p; } });
      const opening = new URL(await mintDashboardOpeningUrl(entry, token, { fetchImpl: (input, init) => fetch(input, { ...init, unix: socketPath } as RequestInit) }));
      await bridge.openTicket(opening.pathname + opening.hash);
      // No resolver mapping, hosts-file change or interception: browser-native
      // localhost handling must reach the real loopback listener.
      const owner = await context.newPage();
      const browserErrors: string[] = []; owner.on('pageerror', (e: Error) => browserErrors.push(e.message));
      await owner.goto(pathToFileURL(ticketPath).href);
      await owner.waitForURL(bridge.origin + '/dashboard', { timeout: 15_000 });
      await owner.waitForFunction(() => document.body.dataset.loaded === 'yes', undefined, { timeout: 15_000 });
      expect(await owner.locator('h1').textContent()).toBe('PRIVATE OWNER DASHBOARD');
      expect(browserErrors).toEqual([]);
      const ownerCookies = await context.cookies(bridge.origin);
      const cookie = ownerCookies.find((c: { name: string }) => c.name === 'olympus_desktop_owner');
      expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Lax'); expect(cookie.domain).toBe(bridge.hostname);
      const stolen = await hostile.evaluate(async (origin: string) => {
        const result = { cookie: document.cookie, storage: localStorage.getItem('olympus-desktop-owner-v1'), readable: false };
        try { const r = await fetch(origin + '/dashboard', { credentials: 'include' }); result.readable = (await r.text()).includes('PRIVATE OWNER DASHBOARD'); } catch {}
        return result;
      }, bridge.origin);
      expect(stolen.cookie).not.toContain(cookie.value); expect(stolen.storage).toBe('planted'); expect(stolen.readable).toBe(false);
      const register = await owner.evaluate(async () => { try { await navigator.serviceWorker.register('/sw.js'); return true; } catch { return false; } });
      expect(register).toBe(false);
      // Opening from another tab reuses only this epoch's origin-local storage.
      const next = await context.newPage(); await next.goto(bridge.origin + '/dashboard');
      await next.waitForFunction(() => document.body.dataset.loaded === 'yes');
      // Real OAuth handler, its CSRF cookie/form, native navigation and
      // cross-origin callback. The shell must not inherit form-action self.
      const redirect = `http://127.0.0.1:${callback.port}/callback`;
      const client = connections.oauth.registerClient({ clientName: 'Browser fixture', redirectUris: [redirect] });
      if (client === 'capacity') throw new Error('fixture');
      const verifier = 'v'.repeat(50);
      const query = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'), state: 'original+state' });
      await next.goto(entry + '/connect/authorize?' + query);
      await next.locator('button[name="action"][value="approve"]').click();
      await next.waitForURL(redirect + '?**');
      const returned = new URL(next.url()); expect(returned.searchParams.get('state')).toBe('original+state');
      const exchanged = await fetch(entry + '/connect/token', { unix: socketPath, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: redirect, code: returned.searchParams.get('code')!, code_verifier: verifier }) } as RequestInit);
      expect(exchanged.status).toBe(200);
      const oldOrigin = bridge.origin; bridge.close();
      bridge = new LinuxOwnerBridge({ port: listener.port!, socketPath, transport, ready: () => true, fetchSocket: r => fetch(r, { unix: socketPath, redirect: 'manual' } as RequestInit), establishDashboard, openFile: async p => { ticketPath = p; } });
      const stale = await fetch(entry + '/dashboard', { headers: { Host: new URL(oldOrigin).host } }); expect(stale.status).toBe(421);
      const fresh = await context.newPage(); await fresh.goto(bridge.origin + '/dashboard');
      expect(await fresh.locator('h1').textContent()).toBe("Confirm it's you on this computer");
      expect(await fresh.evaluate(() => localStorage.getItem('olympus-desktop-owner-v1'))).toBeNull();
      // Owner proof alone also establishes the existing dashboard cookie;
      // OAuth-first/bookmarked entries do not require a CLI launch fragment.
      await bridge.openTicket('/dashboard');
      await fresh.goto(pathToFileURL(ticketPath).href);
      await fresh.waitForURL(bridge.origin + '/dashboard');
      await fresh.waitForFunction(() => document.body.dataset.loaded === 'yes');
      console.log(`${kind}: native localhost resolution and persistent squatter isolation passed`);
    } finally { bridge?.close(); listener.stop(true); socket.stop(true); callback.stop(true); connections.close(); await browser.close(); rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
}
