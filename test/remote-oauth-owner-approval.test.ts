/**
 * Relay-mode approval needs the owner, not just this computer (#1186).
 *
 * A loopback peer is any account on the computer. Before this, a native
 * program run by another local account could register a loopback client,
 * fetch the approval page and its cookie, send browser-like Sec-Fetch
 * headers, approve, and exchange the code for a grant, holding neither the
 * worker token nor the owner's dashboard session. Approval now also needs
 * the owner socket (Linux) or this browser's live dashboard control session,
 * which only the owner's opening link or the worker token opens.
 *
 * Assembled the way the worker server assembles it (email-source/server.ts):
 * the OAuth routes in front of the worker-bearer wrapper, one session secret
 * for both, each request's peer recorded. A small cookie jar that honours
 * each cookie's Path plays the browser, so the test fails if the dashboard
 * cookie (Path=/dashboard) would not reach the approval POST.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardLaunchTickets, DASHBOARD_LAUNCH_MINT_PATH, DASHBOARD_LAUNCH_REDEEM_PATH } from '../src/core/dashboard-launch.ts';
import { mintDashboardOpeningUrl } from '../src/core/dashboard-opening.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { parseRemotePublicBaseUrl } from '../src/core/remote-public-url.ts';
import { withRequestPeer } from '../src/core/request-peer.ts';
import { dashboardOwnerSessionCheck, withWorkerBearerAuth, workerOwnLoopbackOrigin } from '../src/workers/http.ts';
import { CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI } from '../src/workers/remote-oauth/pinned-clients.ts';
import { createRemoteOAuthHandler, withRemoteOAuthRoutes } from '../src/workers/remote-oauth/handler.ts';

const TOKEN = 'owner-approval-worker-token-0123456789abcdef';
const SESSION_SECRET = 'owner-approval-session-secret';
const RELAY_ORIGIN = 'https://mcp.olympus.test';
const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
/** Browser-like headers a program can set on its own. */
const NAVIGATION = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Origin: 'null' };

let dir: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let handle: (request: Request, ownerSocket: boolean) => Promise<Response>;

function assemble(platform: NodeJS.Platform = 'darwin', sessionSecret = SESSION_SECRET, bindHost = '127.0.0.1'): void {
  const resolved = parseRemotePublicBaseUrl(RELAY_ORIGIN, INSTALL_ID);
  if (!resolved.enabled) throw new Error('relay urls');
  const oauth = createRemoteOAuthHandler({
    platform,
    publicUrls: resolved.urls,
    connections: () => store,
    isRelayed: (request) => request.headers.has('x-olympus-relay'),
    ownerSession: dashboardOwnerSessionCheck({ authToken: TOKEN, sessionSecret }),
  });
  const rest = withWorkerBearerAuth(async () => Response.json({ ok: true }), {
    authToken: TOKEN, sessionSecret, launchTickets: new DashboardLaunchTickets(),
    // As email-source/server.ts wires it, for the port this test's server holds.
    ownLoopbackOrigin: (origin) => workerOwnLoopbackOrigin(bindHost, server.port as number)(origin),
  });
  const routed = withRemoteOAuthRoutes(oauth, rest);
  handle = async (request, ownerSocket) => withRequestPeer(routed, ownerSocket)(request, { requestIP: () => (ownerSocket ? null : { address: '127.0.0.1', family: 'IPv4', port: 1 }) } as never);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-owner-approval-'));
  store = openRemoteConnectionStore(join(dir, 'connections.sqlite'));
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handle(request, false) });
  base = `http://127.0.0.1:${server.port}`;
  assemble();
});

afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A browser's cookies for this origin: each sent only to paths under its Path. */
class Jar {
  private cookies = new Map<string, { value: string; path: string }>();
  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const [name, ...value] = pair!.split('=');
      const path = attributes.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const maxAge = attributes.find((a) => a.toLowerCase().startsWith('max-age='))?.slice(8);
      if (maxAge === '0') this.cookies.delete(`${name}@${path}`);
      else this.cookies.set(`${name}@${path}`, { value: `${name}=${value.join('=')}`, path });
    }
  }
  header(path: string): string {
    return [...this.cookies.values()]
      .filter((cookie) => path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
      .map((cookie) => cookie.value).join('; ');
  }
}

async function browse(jar: Jar, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header(new URL(path, base).pathname);
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(new URL(path, base), { ...init, headers, redirect: 'manual' });
  jar.take(response);
  return response;
}

/** What `olympus dashboard` does: the CLI mints with the token, the browser redeems the ticket. */
async function openDashboard(jar: Jar, purpose?: 'remote'): Promise<void> {
  const minted = await fetch(`${base}${DASHBOARD_LAUNCH_MINT_PATH}${purpose ? `?purpose=${purpose}` : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: base },
  });
  const { ticket } = await minted.json() as { ticket: string };
  const redeemed = await browse(jar, DASHBOARD_LAUNCH_REDEEM_PATH, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ ticket }),
  });
  expect(redeemed.status).toBe(200);
}

const VERIFIER = 'v'.repeat(50);
const CHALLENGE = new Bun.CryptoHasher('sha256').update(VERIFIER).digest('base64url');

function authorizePath(clientId: string, redirectUri: string): string {
  return `/connect/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's', resource: `${RELAY_ORIGIN}/mcp`,
  })}`;
}

interface Page { action: string; requestId: string; csrf: string; html: string; status: number }

async function openPage(jar: Jar, path: string): Promise<Page> {
  const response = await browse(jar, path);
  const html = await response.text();
  return {
    status: response.status,
    html,
    action: /<form method="post" action="([^"]+)"/.exec(html)?.[1] ?? '',
    requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '',
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '',
  };
}

function clickConnect(jar: Jar, page: Page, action = page.action): Promise<Response> {
  return browse(jar, action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...NAVIGATION },
    body: new URLSearchParams({ request_id: page.requestId, csrf: page.csrf, action: 'approve' }).toString(),
  });
}

async function exchange(clientId: string, redirectUri: string, code: string): Promise<number> {
  const response = await fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code, code_verifier: VERIFIER }).toString(),
  });
  return response.status;
}

describe('relay mode with no owner socket (a Mac, or a server reached through a tunnel)', () => {
  test('another local account, with no dashboard session and no token, cannot complete an approval', async () => {
    const other = new Jar();
    assemble('darwin', 'another-install-secret');
    await openDashboard(other);
    assemble();
    const foreign = other.header('/dashboard/connect/authorize');
    expect(foreign).toContain('olympus_dashboard_control=');
    const program = new Jar();
    const registered = await fetch(`${base}/connect/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Local tool', redirect_uris: ['http://127.0.0.1:43123/callback'] }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = await registered.json() as { client_id: string };
    const page = await openPage(program, authorizePath(clientId, 'http://127.0.0.1:43123/callback'));
    expect(page.status).toBe(200);
    // The page's consent cookie, which the program read and now sends wherever it likes.
    const consent = program.header(page.action);
    expect(consent).toContain('olympus_consent_');
    const post = (action: string, cookie: string) => fetch(new URL(action, base), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...NAVIGATION, Cookie: cookie },
      body: new URLSearchParams({ request_id: page.requestId, csrf: page.csrf, action: 'approve' }).toString(),
    });
    /** Refused by the owner check itself: every earlier check (peer, CSRF, consent cookie) passed. */
    const refusedAsNotOwner = async (response: Response, label: string) => {
      expect(response.status, label).toBe(403);
      expect(response.headers.get('location'), label).toBeNull();
      expect(await response.text(), label).toContain('Open the Olympus dashboard in this browser first');
    };
    // The form's own action, and the page's own path, both refuse, with the consent cookie sent to each.
    await refusedAsNotOwner(await post(page.action, consent), page.action);
    await refusedAsNotOwner(await post('/connect/authorize', consent), '/connect/authorize');
    // A session cookie another install signed, sent with the consent cookie, is no proof either.
    await refusedAsNotOwner(await post(page.action, `${consent}; ${foreign}`), 'foreign session');
    expect(store.list()).toEqual([]);
    // Control: the same request with this engine's own session approves, so each refusal above was the owner check.
    const owner = new Jar();
    await openDashboard(owner);
    const approved = await post(page.action, `${consent}; ${owner.header(page.action)}`);
    expect(approved.status).toBe(303);
  });

  test('the owner, with the dashboard open in this browser, approves in one click and the app connects', async () => {
    const browser = new Jar();
    await openDashboard(browser);
    const page = await openPage(browser, authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI));
    expect(page.html).toContain('Connect ChatGPT to Olympus?');
    // The form posts under /dashboard, so the dashboard cookie (Path=/dashboard) goes with it.
    expect(page.action).toBe('/dashboard/connect/authorize');
    expect(browser.header(page.action)).toContain('olympus_dashboard_control=');
    const approved = await clickConnect(browser, page);
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(CHATGPT_REDIRECT_URI);
    expect(await exchange(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, callback.searchParams.get('code')!)).toBe(200);
    expect(store.list()).toMatchObject([{ kind: 'oauth', clientId: CHATGPT_CLIENT_ID }]);
  });

  test('the owner without the dashboard open is told to open it, and the same page then approves', async () => {
    const browser = new Jar();
    const page = await openPage(browser, authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI));
    const first = await clickConnect(browser, page);
    expect(first.status).toBe(403);
    const html = await first.text();
    expect(html).toContain('Open the Olympus dashboard in this browser first, then click Connect again.');
    expect(html).toContain('href="olympus://open/dashboard"');
    expect(html).toContain('<button class="approve"');
    await openDashboard(browser);
    const again = await clickConnect(browser, page);
    expect(again.status).toBe(303);
    expect(new URL(again.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  test('a server with nobody at its console: the owner\'s remote opening link, through a forward on the same port, opens the way', async () => {
    assemble('linux');
    const browser = new Jar();
    await openDashboard(browser, 'remote');
    const page = await openPage(browser, authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI));
    expect((await clickConnect(browser, page)).status).toBe(303);
    // Without it, the Linux page says how to get the link.
    const stranger = new Jar();
    const strangerPage = await openPage(stranger, authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI));
    const refused = await clickConnect(stranger, strangerPage);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Run <code>olympus dashboard</code> and open its link here.');
  });

  test('the approval path takes only the approval POST, and only in relay mode', async () => {
    expect((await fetch(`${base}/dashboard/connect/authorize`)).status).toBe(405);
    const resolved = parseRemotePublicBaseUrl(base);
    if (!resolved.enabled) throw new Error('tunnel urls');
    const tunnel = createRemoteOAuthHandler({ publicUrls: resolved.urls, connections: () => store });
    expect((await tunnel(new Request(`${base}/dashboard/connect/authorize`, { method: 'POST' }))).status).toBe(404);
  });
});

describe('a configured localhost worker URL (#1186 review)', () => {
  /** The CLI's transport, with `localhost` resolving to the worker in this test's process (as the configured URL reaches it). */
  const toWorker = (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(String(input), init), false);

  test('a worker listening on 127.0.0.1 binds a localhost opening to 127.0.0.1, so "open the dashboard first" recovers', async () => {
    const browser = new Jar();
    // The relay bridge always sends the browser to http://127.0.0.1:<port>.
    const page = await openPage(browser, authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI));
    expect((await clickConnect(browser, page)).status).toBe(403);
    // `olympus dashboard` with OLYMPUS_EMAIL_BASE_URL=http://localhost:<port>: the bearer goes to the configured address only.
    const asked: string[] = [];
    const link = new URL(await mintDashboardOpeningUrl(`http://localhost:${server.port}`, TOKEN, {
      fetchImpl: async (input, init) => { asked.push(new URL(String(input)).origin); return toWorker(input, init); },
    }));
    expect(asked).toEqual([`http://localhost:${server.port}`]);
    expect(link.origin).toBe(base);
    const ticket = new URLSearchParams(link.hash.slice(1)).get('olympus_launch_ticket')!;
    const redeemed = await browse(browser, DASHBOARD_LAUNCH_REDEEM_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: link.origin }, body: JSON.stringify({ ticket }),
    });
    expect(redeemed.status).toBe(200);
    expect((await clickConnect(browser, page)).status).toBe(303);
  });

  /**
   * Another account holds 127.0.0.1:<port> while the real worker listens on
   * ::1 (configured as `localhost`). Neither the bearer nor a ticket may reach
   * that listener. `localhost` resolves to the worker; 127.0.0.1 is a real
   * socket the impostor holds and records.
   */
  async function impostorCase(reachWorker: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, port: number, impostor: { seen: string[] }) {
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).hostname === 'localhost' ? reachWorker(input, init) : fetch(input, init);
    const link = new URL(await mintDashboardOpeningUrl(`http://localhost:${port}`, TOKEN, { fetchImpl }));
    // The link opens where the configured address does, never on 127.0.0.1.
    expect(link.origin).toBe(`http://localhost:${port}`);
    // And its ticket is good only there: presented on 127.0.0.1 it is refused.
    const ticket = new URLSearchParams(link.hash.slice(1)).get('olympus_launch_ticket')!;
    expect(impostor.seen).toEqual([]);
    expect(link.href).not.toContain('127.0.0.1');
    const elsewhere = await reachWorker(`http://localhost:${port}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ ticket }),
    });
    expect(elsewhere.status).toBe(403);
  }

  function listenImpostor(port: number) {
    const impostor = { seen: [] as string[] };
    const listener = Bun.serve({
      hostname: '127.0.0.1', port,
      fetch: (request) => { impostor.seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('authorization') ?? ''}`); return Response.json({ ticket: 'i'.repeat(43), origin: `http://127.0.0.1:${port}` }); },
    });
    return { impostor, listener };
  }

  test('a worker that does not listen on 127.0.0.1: the bearer and the ticket never reach whoever does', async () => {
    // The impostor takes 127.0.0.1 on a free port; the worker answers `localhost` on the same port, bound to ::1.
    const { impostor, listener } = listenImpostor(0);
    try {
      const port = listener.port as number;
      const routed = withWorkerBearerAuth(async () => Response.json({ ok: true }), {
        authToken: TOKEN, sessionSecret: SESSION_SECRET, launchTickets: new DashboardLaunchTickets(),
        ownLoopbackOrigin: workerOwnLoopbackOrigin('::1', port),
      });
      const worker = (input: RequestInfo | URL, init?: RequestInit) =>
        withRequestPeer(routed)(new Request(String(input), init), { requestIP: () => ({ address: '::1', family: 'IPv6', port: 1 }) } as never) as Promise<Response>;
      await impostorCase(worker, port, impostor);
    } finally {
      listener.stop(true);
    }
  });

  // The same with two real listeners, where this machine has IPv6 loopback.
  const ipv6 = (() => {
    try {
      Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response() }).stop(true);
      return true;
    } catch {
      return false;
    }
  })();
  test.skipIf(!ipv6)('two real listeners: the worker on ::1, an impostor on 127.0.0.1, same port', async () => {
    const { impostor, listener } = listenImpostor(0);
    const port = listener.port as number;
    const routed = withWorkerBearerAuth(async () => Response.json({ ok: true }), {
      authToken: TOKEN, sessionSecret: SESSION_SECRET, launchTickets: new DashboardLaunchTickets(),
      ownLoopbackOrigin: workerOwnLoopbackOrigin('::1', port),
    });
    // The worker's listener sees the name the client used (`localhost`), as a server does from Host.
    const real = Bun.serve({
      hostname: '::1', port,
      fetch: (request, srv) => withRequestPeer(routed)(new Request(request.url.replace(/^http:\/\/[^/]+/, `http://localhost:${port}`), request), srv),
    });
    try {
      await impostorCase((input, init) => fetch(String(input).replace('//localhost:', '//[::1]:'), init), port, impostor);
    } finally {
      real.stop(true);
      listener.stop(true);
    }
  });
});

describe('relay mode over the Linux owner socket', () => {
  test('the socket is the owner proof: the form posts to /connect/authorize and approves with no dashboard session', async () => {
    assemble('linux');
    const viaSocket = (path: string, init: RequestInit = {}) => handle(new Request(new URL(path, base), init), true);
    const response = await viaSocket(authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI));
    const html = await response.text();
    expect(/<form method="post" action="([^"]+)"/.exec(html)?.[1]).toBe('/connect/authorize');
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toContain('Path=/connect;');
    const approved = await viaSocket('/connect/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...NAVIGATION, Cookie: cookie.split(';')[0]! },
      body: new URLSearchParams({
        request_id: /name="request_id" value="([^"]+)"/.exec(html)![1]!,
        csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]!,
        action: 'approve',
      }).toString(),
    });
    expect(approved.status).toBe(303);
  });
});

describe('a tunnel the owner runs (pairing code, no relay)', () => {
  test('the consent cookie goes where the form posts, so the pairing-code approval completes', async () => {
    const resolved = parseRemotePublicBaseUrl(base);
    if (!resolved.enabled) throw new Error('tunnel urls');
    const oauth = createRemoteOAuthHandler({
      publicUrls: resolved.urls,
      connections: () => store,
      ownerSession: dashboardOwnerSessionCheck({ authToken: TOKEN, sessionSecret: SESSION_SECRET }),
    });
    handle = async (request) => oauth(request);
    const browser = new Jar();
    const page = await openPage(browser, authorizePath(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI).replace(/&resource=[^&]*/, ''));
    expect(page.status).toBe(200);
    expect(page.action).toBe('/connect/authorize');
    expect(browser.header(page.action)).toContain('olympus_consent_');
    const approved = await browse(browser, page.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...NAVIGATION },
      body: new URLSearchParams({ request_id: page.requestId, csrf: page.csrf, action: 'approve', pairing_code: store.oauth.mintPairingCode().code }).toString(),
    });
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });
});
