/**
 * The local control-session mint needs an owner proof (#1153).
 *
 * On Linux the proof is the owner socket. A Mac has none: the engine listens
 * on 127.0.0.1, so every account on that computer reaches it from a loopback
 * peer. There the proof is a live control session in the same browser, which
 * only the owner's launch link or the worker token (owner-only worker.env)
 * opens. These run the real HTTP boundary with a recording handler.
 */
import { describe, expect, test } from 'bun:test';
import { recordRequestPeer, withRequestPeer } from '../src/core/request-peer.ts';
import { DASHBOARD_LAUNCH_MINT_PATH, DASHBOARD_LAUNCH_REDEEM_PATH, DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';
import { newDashboardSessionSecret } from '../src/core/dashboard-session-secret.ts';
import {
  DASHBOARD_CONSULT_CONTROL_PATHS,
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER,
  DASHBOARD_LOCAL_CONTROL_SESSION_PATH,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';

const TOKEN = 'owner-proof-worker-token';
const ORIGIN = 'http://127.0.0.1:8010';

/** A Mac engine: no owner socket, so `requireOwnerSocket` is unset (email-source/server.ts). */
function macEngine(sessionSecret = newDashboardSessionSecret()) {
  const seen: Request[] = [];
  const fetch = withWorkerBearerAuth(async (request) => {
    seen.push(request);
    return Response.json({ ok: true });
  }, { authToken: TOKEN, sessionSecret, launchTickets: new DashboardLaunchTickets() });
  return { fetch, seen, sessionSecret };
}

const cookieOf = (response: Response): string => (response.headers.get('Set-Cookie') ?? '').split(';')[0]!;

/** The mint as a browser page sends it: same origin, loopback peer, no bearer. */
function localMint(headers: Record<string, string> = {}, peer = '127.0.0.1'): Request {
  const request = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN, ...headers } });
  recordRequestPeer(request, peer);
  return request;
}

/** What `olympus dashboard` (and the menu bar's olympus:// link, through `olympus open`) does: mint with the bearer, redeem in the browser. */
async function launchedPage(fetch: (request: Request) => Promise<Response>, purpose?: 'remote'): Promise<{ cookie: string; csrf: string }> {
  const minted = await fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_MINT_PATH}${purpose ? `?purpose=${purpose}` : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
  }));
  expect(minted.status).toBe(200);
  const { ticket } = await minted.json() as { ticket: string };
  const redeemed = await fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ ticket }),
  }));
  expect(redeemed.status).toBe(200);
  return { cookie: cookieOf(redeemed), csrf: (await redeemed.json() as { csrf_token: string }).csrf_token };
}

/** One consult route, as a local-grade page posts it. */
function consult(cookie: string, csrf: string): Request {
  const request = new Request(`${ORIGIN}${DASHBOARD_CONSULT_CONTROL_PATHS[0]}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie, 'X-Olympus-CSRF': csrf }, body: '{}',
  });
  recordRequestPeer(request, '127.0.0.1');
  return request;
}

describe('the local mint on a computer with no owner socket (macOS)', () => {
  test('another local account: loopback peer, loopback Origin, no session: refused, and nothing reaches the worker', async () => {
    const mac = macEngine();
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const refused = await mac.fetch(localMint({}, peer));
      expect(refused.status, peer).toBe(401);
      expect(refused.headers.get('Set-Cookie'), peer).toBeNull();
    }
    // Every form a page can send without the owner's session: also refused.
    for (const Origin of ['http://localhost:8010', 'http://[::1]:8010']) {
      const other = new Request(Origin + DASHBOARD_LOCAL_CONTROL_SESSION_PATH, { method: 'POST', headers: { Origin } });
      recordRequestPeer(other, '127.0.0.1');
      expect((await mac.fetch(other)).status, Origin).toBe(401);
    }
    expect(mac.seen).toEqual([]);
  });

  test('a session cookie this engine did not sign, or one bound to another origin, is no proof', async () => {
    const mac = macEngine();
    const elsewhere = macEngine();
    const { cookie } = await launchedPage(elsewhere.fetch);
    expect((await mac.fetch(localMint({ Cookie: cookie }))).status).toBe(401);
    expect((await mac.fetch(localMint({ Cookie: 'olympus_dashboard_control=forged.1.x.b.y' }))).status).toBe(401);
    // The owner's session, presented from another origin's page: refused on its Origin, as before.
    const own = await launchedPage(mac.fetch);
    expect((await mac.fetch(localMint({ Cookie: own.cookie, Origin: 'http://127.0.0.1:9999' }))).status).toBe(403);
    expect(mac.seen).toEqual([]);
  });

  test('the owner: `olympus dashboard` opens the page, Unlock mints a local session that reaches the local-only routes', async () => {
    const mac = macEngine();
    const page = await launchedPage(mac.fetch);
    // A launch session is bearer-grade: the local-only routes stay closed to it.
    expect((await mac.fetch(consult(page.cookie, page.csrf))).status).toBe(403);
    const unlocked = await mac.fetch(localMint({ Cookie: page.cookie, 'X-Olympus-CSRF': page.csrf }));
    expect(unlocked.status).toBe(200);
    const local = { cookie: cookieOf(unlocked), csrf: (await unlocked.json() as { csrf_token: string }).csrf_token };
    expect(local.cookie).not.toBe(page.cookie);
    expect((await mac.fetch(consult(local.cookie, local.csrf))).status).toBe(200);
    expect(mac.seen.at(-1)!.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER)).toBe('local');
  });

  test('the owner\'s cookie alone, with no in-page CSRF token, mints nothing (#1187)', async () => {
    const mac = macEngine();
    const page = await launchedPage(mac.fetch);
    // Browsers do not separate cookies by port (RFC 6265 §8.5): a server on
    // another loopback port can be handed this cookie and replay it with the
    // engine's own Origin. The CSRF token lives only in the owner's page.
    const replayed = await mac.fetch(localMint({ Cookie: page.cookie }));
    expect(replayed.status).toBe(403);
    expect(replayed.headers.get('Set-Cookie')).toBeNull();
    expect((await mac.fetch(localMint({ Cookie: page.cookie, 'X-Olympus-CSRF': 'not-the-token' }))).status).toBe(403);
    expect(mac.seen).toEqual([]);
    expect((await mac.fetch(localMint({ Cookie: page.cookie, 'X-Olympus-CSRF': page.csrf }))).status).toBe(200);
  });

  test('a local session already open survives the update: same signing secret, no new mint needed', async () => {
    const before = macEngine();
    const page = await launchedPage(before.fetch);
    const unlocked = await before.fetch(localMint({ Cookie: page.cookie, 'X-Olympus-CSRF': page.csrf }));
    const local = { cookie: cookieOf(unlocked), csrf: (await unlocked.json() as { csrf_token: string }).csrf_token };
    // The engine restarts on the new version with the secret it keeps in its state file.
    const after = macEngine(before.sessionSecret);
    expect((await after.fetch(consult(local.cookie, local.csrf))).status).toBe(200);
    // And it may mint again from that session (a second tab's Unlock).
    expect((await after.fetch(localMint({ Cookie: local.cookie, 'X-Olympus-CSRF': local.csrf }))).status).toBe(200);
  });

  test('server mode with nobody at the console: the owner\'s remote opening link, through a loopback forward, still unlocks', async () => {
    const mac = macEngine();
    const page = await launchedPage(mac.fetch, 'remote');
    expect((await mac.fetch(localMint({ Cookie: page.cookie, 'X-Olympus-CSRF': page.csrf }))).status).toBe(200);
  });

  test('the token pasted into the page (the manual unlock) is a proof too', async () => {
    const mac = macEngine();
    const pasted = await mac.fetch(new Request(`${ORIGIN}/dashboard/control/session`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
    }));
    const { csrf_token: csrf } = await pasted.json() as { csrf_token: string };
    expect((await mac.fetch(localMint({ Cookie: cookieOf(pasted), 'X-Olympus-CSRF': csrf }))).status).toBe(200);
  });

  test('a session does not lift the older refusals: a bearer, proxy headers or a remote peer still refuse', async () => {
    const mac = macEngine();
    const { cookie, csrf } = await launchedPage(mac.fetch);
    expect((await mac.fetch(localMint({ Cookie: cookie, 'X-Olympus-CSRF': csrf, Authorization: `Bearer ${TOKEN}` }))).status).toBe(403);
    expect((await mac.fetch(localMint({ Cookie: cookie, 'X-Olympus-CSRF': csrf, 'X-Forwarded-For': '203.0.113.9' }))).status).toBe(403);
    expect((await mac.fetch(localMint({ Cookie: cookie, 'X-Olympus-CSRF': csrf }, '192.0.2.10'))).status).toBe(403);
    expect(mac.seen).toEqual([]);
  });
});

describe('the local mint on Linux: the owner socket is necessary, not sufficient (#1188)', () => {
  // `olympus remote open` forwards the owner socket to a loopback TCP port on
  // the client computer, one socket connection per TCP connection, so a
  // request through that forward arrives exactly as a local socket client's
  // does. Any account on the client can reach that port; the socket alone
  // cannot say the browser is the owner's.
  function linuxEngine() {
    const seen: Request[] = [];
    const inner = withWorkerBearerAuth(async (request) => {
      seen.push(request);
      return Response.json({ ok: true });
    }, { authToken: TOKEN, requireOwnerSocket: true, sessionSecret: newDashboardSessionSecret(), launchTickets: new DashboardLaunchTickets() });
    const viaSocket = withRequestPeer(inner, true);
    return { fetch: (request: Request) => Promise.resolve(viaSocket(request, { requestIP: () => null })), tcp: inner, seen };
  }
  const socketMint = (headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN, ...headers } });

  test('through the socket forward with no bearer and no session: refused, no cookie, nothing reaches the worker', async () => {
    const linux = linuxEngine();
    const refused = await linux.fetch(socketMint());
    expect(refused.status).toBe(401);
    expect(refused.headers.get('Set-Cookie')).toBeNull();
    expect(await refused.text()).not.toContain('csrf_token');
    // A cookie this engine did not sign is no proof either.
    expect((await linux.fetch(socketMint({ Cookie: 'olympus_dashboard_control=forged.1.x.b.y' }))).status).toBe(401);
    expect(linux.seen).toEqual([]);
  });

  test('TCP without the socket is still refused, session or not', async () => {
    const linux = linuxEngine();
    const page = await launchedPage(linux.fetch, 'remote');
    expect((await linux.tcp(localMint())).status).toBe(403);
    expect((await linux.tcp(localMint({ Cookie: page.cookie }))).status).toBe(403);
  });

  test('the owner\'s remote opening link, through the forward, still unlocks and reaches the local-only routes', async () => {
    const linux = linuxEngine();
    const page = await launchedPage(linux.fetch, 'remote');
    const unlocked = await linux.fetch(socketMint({ Cookie: page.cookie, 'X-Olympus-CSRF': page.csrf }));
    expect(unlocked.status).toBe(200);
    const local = { cookie: cookieOf(unlocked), csrf: (await unlocked.json() as { csrf_token: string }).csrf_token };
    const request = new Request(`${ORIGIN}${DASHBOARD_CONSULT_CONTROL_PATHS[0]}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: local.cookie, 'X-Olympus-CSRF': local.csrf }, body: '{}',
    });
    expect((await linux.fetch(request)).status).toBe(200);
    expect(linux.seen.at(-1)!.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER)).toBe('local');
  });

  test('the desktop bridge\'s page (a bearer session it opened for the owner) unlocks as before', async () => {
    const linux = linuxEngine();
    const opened = await linux.fetch(new Request(`${ORIGIN}/dashboard/control/session`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
    }));
    expect(opened.status).toBe(200);
    const { csrf_token: csrf } = await opened.json() as { csrf_token: string };
    expect((await linux.fetch(socketMint({ Cookie: cookieOf(opened), 'X-Olympus-CSRF': csrf }))).status).toBe(200);
  });

  test('the CLI over the socket keeps its bearer routes', async () => {
    const linux = linuxEngine();
    expect((await linux.fetch(new Request(`${ORIGIN}/v1/sources`))).status).toBe(401);
    const cli = await linux.fetch(new Request(`${ORIGIN}/v1/sources`, { headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(cli.status).toBe(200);
    expect(linux.seen.map(r => new URL(r.url).pathname)).toEqual(['/v1/sources']);
  });
});
