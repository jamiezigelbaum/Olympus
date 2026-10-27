/** Optional real-browser qualification. Run with OLYMPUS_TEST_PLAYWRIGHT set to
 * an installed Playwright ESM entry; never installs packages in the repository. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOrCreateDashboardSessionSecret } from '../src/core/dashboard-session-secret.ts';
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
    const makeAuth = () => withRequestPeer(withWorkerBearerAuth(async r => {
      if (new URL(r.url).pathname === '/dashboard') return new Response(`<!doctype html><html><head><title>Owner dashboard</title></head><body data-csrf="${r.headers.get('X-Olympus-Control-Session-CSRF') ?? ''}"><h1>PRIVATE OWNER DASHBOARD</h1><script>fetch("/dashboard.json?token=${dashboardQueryTokenFromWorkerAuthToken(token)}").then(r=>r.json()).then(v=>document.body.dataset.loaded=v.private)</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
      return Response.json({ private: 'yes', csrf: r.headers.get('X-Olympus-Control-Session-CSRF') });
    }, { authToken: token, requireOwnerSocket: true, sessionSecret: loadOrCreateDashboardSessionSecret({ path: join(root, 'dashboard-session.secret') }).secret }), true);
    let auth = makeAuth();
    const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: (r, server) => new URL(r.url).pathname.startsWith('/connect/') ? oauth(r, server) : auth(r, server) }));
    let bridge: LinuxOwnerBridge | undefined;
    let workerReady = true;
    const listenerOptions = { hostname: '127.0.0.1', async fetch(r: Request) {
      if (bridge) return bridge.handle(r);
      if (new URL(r.url).pathname === '/sw.js') return new Response("self.addEventListener('fetch',e=>e.respondWith(fetch(e.request)));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));", { headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' } });
      return new Response('<!doctype html><title>Squatter</title><script>localStorage.setItem("olympus-desktop-owner-v1","planted");navigator.serviceWorker.register("/sw.js");</script>', { headers: { 'Content-Type': 'text/html' } });
    } };
    let listener = Bun.serve({ ...listenerOptions, port: 0 });
    const callback = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('OAUTH CALLBACK COMPLETE') });
    try {
      const entry = `http://127.0.0.1:${listener.port}`;
      // Set to simulate a worker restart right after the ticket is spent.
      let restartAfterProof = false;
      const establishDashboard = async () => {
        const r = await fetch(entry + '/dashboard/control/session', { unix: socketPath, method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: entry } } as RequestInit);
        expect(r.ok).toBe(true); await r.body?.cancel();
        if (restartAfterProof) { restartAfterProof = false; workerReady = false; setTimeout(() => { workerReady = true; }, 1_500); }
        return r.headers.getSetCookie();
      };
      const hostile = await context.newPage();
      await hostile.goto(entry);
      await hostile.evaluate(async () => { await navigator.serviceWorker.ready; });
      let ticketPath = '';
      let clockAdvance = 0;
      bridge = new LinuxOwnerBridge({ now: () => Date.now() + clockAdvance, port: listener.port!, socketPath, transport, ready: () => true, workerReady: () => workerReady,
        fetchSocket: r => fetch(r, { unix: socketPath, redirect: 'manual' } as RequestInit), establishDashboard, openFile: async p => { ticketPath = p; } });
      const opening = new URL(await mintDashboardOpeningUrl(entry, token, { fetchImpl: (input, init) => fetch(input, { ...init, unix: socketPath } as RequestInit) }));
      await bridge.openTicket(opening.pathname + opening.hash);
      // No resolver mapping, hosts-file change or interception: browser-native
      // localhost handling must reach the real loopback listener.
      const owner = await context.newPage();
      const browserErrors: string[] = []; owner.on('pageerror', (e: Error) => browserErrors.push(e.message));
      const windowEvents: string[] = [];
      owner.on('popup', () => windowEvents.push('popup'));
      owner.on('close', () => windowEvents.push('close'));
      const pagesBeforeOpen = context.pages().length;
      const ticket = readFileSync(ticketPath, 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
      await owner.goto(pathToFileURL(ticketPath).href);
      await owner.waitForURL(bridge.origin + '/dashboard', { timeout: 15_000 });
      await owner.waitForFunction(() => document.body.dataset.loaded === 'yes', undefined, { timeout: 15_000 });
      expect(await owner.locator('h1').textContent()).toBe('PRIVATE OWNER DASHBOARD');
      expect(browserErrors).toEqual([]);
      expect(windowEvents).toEqual([]); expect(context.pages()).toHaveLength(pagesBeforeOpen);
      // An XMLHttpRequest (an upload piece, for its progress) carries the proof as fetch does.
      expect(await owner.evaluate((query: string) => new Promise<number>((resolve) => {
        const request = new XMLHttpRequest(); request.open('GET', '/dashboard.json?token=' + query);
        request.onload = () => resolve(request.status); request.onerror = () => resolve(0); request.send();
      }), dashboardQueryTokenFromWorkerAuthToken(token))).toBe(200);
      expect(await owner.evaluate(async (ticket: string) => (await fetch('/owner-proof', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
      })).status, ticket)).toBe(403);
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
      // A consent page in an UNPROVEN profile must continue itself when the
      // dashboard ticket window stores proof, without any reload/navigation.
      for (const suppressStorageEvent of [false, true]) {
        clockAdvance += 10_001;
        const flowState = `original+state-${suppressStorageEvent ? 'poll' : 'event'}`;
        const flowQuery = new URLSearchParams(query); flowQuery.set('state', flowState);
        const unproven = await browser.newContext();
        try {
          if (suppressStorageEvent) await unproven.addInitScript(() => {
            window.addEventListener('storage', event => event.stopImmediatePropagation());
          });
          else await unproven.addInitScript(() => {
            // Disable only the confirmation poll, leaving rAF and the
            // browser clock real. This case must resume on a storage event.
            const nativeInterval = window.setInterval.bind(window);
            window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
              nativeInterval(handler, delay === 1000 ? 120_000 : delay, ...args)) as typeof window.setInterval;
          });
          const consent = await unproven.newPage();
          await consent.goto(entry + '/connect/authorize?' + flowQuery + '#keep-fragment');
          expect(await consent.locator('h1').textContent()).toBe("Confirm it's you on this computer");
          const originalUrl = consent.url();
          let documentRequests = 0; consent.on('request', (request: { resourceType(): string }) => { if (request.resourceType() === 'document') documentRequests++; });
          // Refused opens show an actionable terminal remedy and permit retry.
          await consent.route('**/owner-open', (route: { fulfill(value: object): Promise<void> }) => route.fulfill({ status: 429, headers: { 'Retry-After': '3600', 'X-Olympus-Owner-Limit': 'hourly' } }));
          await consent.locator('#confirm').click();
          await consent.waitForFunction(() => document.getElementById('message')?.textContent?.includes('Too many windows were opened from the browser.'));
          expect(await consent.locator('#message').textContent()).toContain('Run olympus dashboard in a terminal on this computer.');
          expect(await consent.locator('#confirm').isEnabled()).toBe(true);
          await consent.unroute('**/owner-open');
          console.log(`${kind}: Confirm ${suppressStorageEvent ? 'poll' : 'event'} starts`);
          await consent.locator('#confirm').click();
          await consent.waitForFunction(() => document.getElementById('message')?.textContent === 'Approve in the Olympus window that just opened. This page continues by itself.');
          expect(await consent.locator('#confirm').isDisabled()).toBe(true);
          // D1 from the independent review: a repeat click must neither open
          // another ticket nor strand the first ticket's storage-event wait.
          await consent.locator('#confirm').click({ force: true });
          // Also exercise a programmatic event that bypasses disabled controls.
          await consent.locator('#confirm').dispatchEvent('click');
          expect(await consent.locator('#message').textContent()).toContain('This page continues by itself.');
          // The opened ticket always goes to /dashboard; posted targets do
          // not supply the consent destination. Only the original tab has it.
          const ticketWindow = await unproven.newPage();
          await ticketWindow.goto(pathToFileURL(ticketPath).href);
          await ticketWindow.waitForURL(bridge.origin + '/dashboard');
          await ticketWindow.waitForFunction(() => document.body.dataset.loaded === 'yes');
          await consent.locator('button[name="action"][value="approve"]').waitFor();
          expect(consent.url()).toBe(originalUrl); expect(documentRequests).toBe(0);
          console.log(`${kind}: Confirm ${suppressStorageEvent ? 'poll' : 'event'} resumed without reloading`);
          await consent.locator('button[name="action"][value="approve"]').click();
          await consent.waitForURL(redirect + '?**');
          const returned = new URL(consent.url()); expect(returned.searchParams.get('state')).toBe(flowState);
          const exchanged = await fetch(entry + '/connect/token', { unix: socketPath, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: redirect, code: returned.searchParams.get('code')!, code_verifier: verifier }) } as RequestInit);
          expect(exchanged.status).toBe(200);
        } finally { await unproven.close(); }
      }
      // A ticket proven in another browser profile cannot resume this page.
      clockAdvance += 10_001;
      console.log(`${kind}: separate-profile timeout starts`);
      const otherProfile = await browser.newContext();
      try {
        const stranded = await otherProfile.newPage();
        await stranded.goto(entry + '/connect/authorize?' + query);
        // Use the real ticket lifetime in Firefox, avoiding a fake browser
        // clock while also covering the actual timeout duration.
        if (kind === 'chromium') await stranded.clock.install();
        await stranded.locator('#confirm').click();
        await stranded.waitForFunction(() => document.getElementById('message')?.textContent?.includes('This page continues by itself.'));
        const elsewhere = await context.newPage();
        await elsewhere.goto(pathToFileURL(ticketPath).href);
        await elsewhere.waitForURL(bridge.origin + '/dashboard');
        await elsewhere.waitForFunction(() => document.body.dataset.loaded === 'yes');
        console.log(`${kind}: separate-profile ticket proved; checking timeout`);
        if (kind === 'chromium') await stranded.clock.fastForward(60_000);
        await stranded.waitForFunction(() => document.getElementById('message')?.textContent === 'Open this page again from the Olympus window.', undefined, { timeout: 65_000 });
        expect(await stranded.locator('#confirm').isEnabled()).toBe(true);
        expect(await stranded.locator('h1').textContent()).toBe("Confirm it's you on this computer");
        expect(await stranded.evaluate(() => localStorage.getItem('olympus-desktop-owner-v1'))).toBeNull();
        await elsewhere.close();
      } finally { await otherProfile.close(); }
      console.log(`${kind}: separate-profile timeout passed`);
      const oldOrigin = bridge.origin;
      // The worker disappears, but the host retains the SAME listening socket.
      const retained = bridge;
      workerReady = false;
      await owner.reload();
      await owner.waitForFunction(() => document.body.textContent?.includes('Olympus is restarting…'));
      expect(await owner.content()).not.toContain('PRIVATE OWNER DASHBOARD');
      // Check the actual bind while the original listener is still held.
      expect(() => Bun.serve({ hostname: '127.0.0.1', port: listener.port!, fetch: () => new Response('squatter') })).toThrow();
      auth = makeAuth();
      workerReady = true;
      expect(bridge).toBe(retained); expect(bridge.origin).toBe(oldOrigin);
      await owner.reload();
      await owner.waitForFunction(() => document.body.dataset.loaded === 'yes');
      expect(await owner.locator('h1').textContent()).toBe('PRIVATE OWNER DASHBOARD');
      const fresh = await context.newPage(); await fresh.goto(bridge.origin + '/dashboard');
      await fresh.waitForFunction(() => document.body.dataset.loaded === 'yes');
      // The old dashboard cookie is still accepted for a CSRF-authenticated save.
      const saved = await owner.evaluate(async () => {
        const csrf = document.body.dataset.csrf!;
        const statuses = [];
        for (let i = 0; i < 2; i++) {
          const response = await fetch('/dashboard/models/check', { method: 'POST', headers: { 'X-Olympus-CSRF': csrf } });
          statuses.push(response.status);
        }
        return { hasCsrf: !!csrf, statuses };
      });
      expect(saved).toEqual({ hasCsrf: true, statuses: [200, 200] });
      // Owner proof alone also establishes the existing dashboard cookie;
      // OAuth-first/bookmarked entries do not require a CLI launch fragment.
      // A held listener also retains its ticket-opening rate limit.
      await Bun.sleep(10_001);
      await bridge.openTicket('/dashboard');
      // The worker restarts after the single-use ticket is spent: the opening
      // view waits for it and still lands on the dashboard.
      restartAfterProof = true;
      await fresh.goto(pathToFileURL(ticketPath).href);
      await fresh.waitForURL(bridge.origin + '/dashboard');
      await fresh.waitForFunction(() => document.body.dataset.loaded === 'yes');
      const releasedOrigin = bridge.origin;
      const oldProof = await owner.evaluate(() => localStorage.getItem('olympus-desktop-owner-v1'));
      bridge.close();
      const port = listener.port!; await listener.stop(true);
      listener = Bun.serve({ ...listenerOptions, port });
      bridge = new LinuxOwnerBridge({ port, socketPath, transport, ready: () => true, fetchSocket: r => fetch(r, { unix: socketPath, redirect: 'manual' } as RequestInit) });
      expect(bridge.origin).not.toBe(releasedOrigin);
      const rejected = await fetch(entry + '/dashboard.json', { headers: { Host: new URL(bridge.origin).host,
        Cookie: `olympus_desktop_owner=${cookie.value}`, 'X-Olympus-Owner-Proof': oldProof! } });
      expect(rejected.status).toBe(403);
      console.log(`${kind}: native localhost resolution and persistent squatter isolation passed`);
    } finally { bridge?.close(); listener.stop(true); socket.stop(true); callback.stop(true); connections.close(); await browser.close(); rmSync(root, { recursive: true, force: true }); }
  }, kind === 'firefox' ? 120_000 : 90_000);
}

// Deliberately bypass the dual-family manager here: identity proof must also
// refuse a listener that cannot answer, in addition to dual-family custody.
for (const kind of ['chromium', 'firefox']) {
  test.skipIf(!playwrightPath)(`${kind}: fake listener cannot receive the private ticket; probe and redemption retry restarts`, async () => {
    const playwright = await import(playwrightPath!);
    const browser = await playwright[kind].launch({ headless: true, ...(kind === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    const root = mkdtempSync(join(tmpdir(), 'owner-identity-'));
    const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
    const socketPath = prepareWorkerSocket(transport)!;
    const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: () => new Response() }));
    let bridge!: LinuxOwnerBridge, real = false, workerReady = true, ticketPath = '';
    const seen: string[] = [];
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(r) {
      seen.push(r.url + ' ' + (r.method === 'POST' ? await r.clone().text() : ''));
      return real ? bridge.handle(r) : new Response('fake listener', { headers: { 'Access-Control-Allow-Origin': '*' } });
    } });
    let establishments = 0;
    bridge = new LinuxOwnerBridge({ port: listener.port!, socketPath, transport, ready: () => true, workerReady: () => workerReady,
      establishDashboard: async () => { if (++establishments === 1) throw new Error('Worker socket restarted before its next health probe.'); return []; },
      fetchSocket: async () => new Response('<!doctype html><html><head></head><body><h1>PRIVATE DASHBOARD</h1></body></html>', { headers: { 'Content-Type': 'text/html' } }),
      openFile: async p => { ticketPath = p; } });
    try {
      await bridge.openTicket('/dashboard');
      const file = pathToFileURL(ticketPath).href;
      const ticket = readFileSync(ticketPath, 'utf8').match(/owner-proof#([A-Za-z0-9_-]{43})/)![1]!;
      const owner = await browser.newPage();
      await owner.goto(file);
      await owner.waitForFunction(() => document.body.textContent?.includes('could not prove its identity'));
      expect(owner.url()).toBe(file);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.join(' ')).not.toContain(ticket);
      // The same, unconsumed file can retry a genuine bridge through downtime.
      real = true; workerReady = false;
      await owner.reload();
      await owner.waitForFunction(() => document.body.textContent?.includes('Olympus is restarting…'));
      expect(owner.url()).toBe(file);
      // Reload DURING the file's CORS probe must retain the retry wording.
      await owner.reload();
      await owner.waitForFunction(() => document.body.textContent?.includes('Olympus is restarting…'));
      workerReady = true;
      await owner.waitForURL(bridge.origin + '/dashboard');
      expect(await owner.locator('h1').textContent()).toBe('PRIVATE DASHBOARD');
      expect(establishments).toBe(2);
    } finally { bridge.close(); listener.stop(true); socket.stop(true); await browser.close(); rmSync(root, { recursive: true, force: true }); }
  }, 45_000);
}
