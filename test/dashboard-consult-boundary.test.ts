/**
 * The Outside help routes take consult authority from nothing the worker
 * bearer can reach (Astra review of #166, P1-1). Every control session cookie
 * carries a signed grade: `bearer` for the direct bearer mint and for a launch
 * ticket a bearer minted and redeemed; `local` only for the local-only mint,
 * which refuses any Authorization header and any non-loopback or proxied
 * origin. The five consult routes accept `local` alone.
 *
 * Full sequences, against the real HTTP boundary with a recording handler.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardSessionSecretPath, loadOrCreateDashboardSessionSecret, newDashboardSessionSecret } from '../src/core/dashboard-session-secret.ts';
import { DASHBOARD_LAUNCH_MINT_PATH, DASHBOARD_LAUNCH_REDEEM_PATH, DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';
import {
  DASHBOARD_CONSULT_CONTROL_PATHS,
  DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER,
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER,
  DASHBOARD_LOCAL_CONTROL_SESSION_PATH,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';

const TOKEN = 'worker-secret-token';
const ORIGIN = 'http://127.0.0.1:28190';

function fixture(sessionSecret?: string) {
  let clock = Date.parse('2026-10-07T12:00:00.000Z');
  const seen: Request[] = [];
  const fetch = withWorkerBearerAuth(async (request) => {
    seen.push(request);
    return new Response(JSON.stringify({ ok: true, handler: true }), { headers: { 'Content-Type': 'application/json' } });
  }, { authToken: TOKEN, now: () => clock, launchTickets: new DashboardLaunchTickets({ now: () => clock }), ...(sessionSecret ? { sessionSecret } : {}) });
  return { fetch, seen, advance: (ms: number) => { clock += ms; } };
}

function cookieOf(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? '';
  const cookie = header.split(';')[0];
  if (!cookie?.startsWith('olympus_dashboard_control=')) throw new Error(`no control cookie: ${header}`);
  return cookie;
}

function post(path: string, headers: Record<string, string>, body: unknown = { enabled: true, revision: 0, confirm: true }): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function bearerSession(f: ReturnType<typeof fixture>): Promise<{ cookie: string; csrf: string }> {
  const mint = await f.fetch(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  return { cookie: cookieOf(mint), csrf: ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function launchSession(f: ReturnType<typeof fixture>): Promise<{ cookie: string; csrf: string }> {
  const mint = await f.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_MINT_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  const { ticket } = (await mint.json()) as { ticket: string };
  const redeemed = await f.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ ticket }),
  }));
  expect(redeemed.status).toBe(200);
  return { cookie: cookieOf(redeemed), csrf: ((await redeemed.json()) as { csrf_token: string }).csrf_token };
}

/** The local mint as a loopback browser makes it: same origin, and the socket peer the server recorded is loopback. */
async function localSession(f: ReturnType<typeof fixture>, origin = ORIGIN, headers: Record<string, string> = {}, peer: string | null = '127.0.0.1'): Promise<Response> {
  const request = new Request(`${origin}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: origin, ...headers } });
  // `null`: no peer recorded at all (a request the server never saw the socket of).
  if (peer !== null) recordRequestPeer(request, peer);
  return f.fetch(request);
}

/** The cookie re-signed as the bearer could compute it, were sessions keyed by the bearer (they are not). */
function bearerSigned(cookie: string, grade: 'b' | 'l'): string {
  const [name, value] = cookie.split('=') as [string, string];
  const [nonce, issued, originTag] = value.split('.') as [string, string, string, string, string];
  const gradeWord = grade === 'b' ? 'bearer' : 'local';
  const mac = createHmac('sha256', TOKEN).update('olympus-dashboard-control-session-v3');
  for (const part of [nonce, issued, originTag, gradeWord]) mac.update('\0').update(part);
  return `${name}=${[nonce, issued, originTag, grade, mac.digest('base64url')].join('.')}`;
}

describe('consult authority is not reachable from the worker bearer', () => {
  test('bearer → mint a control session → drop Authorization → POST each consult route: refused, handler never called', async () => {
    const f = fixture();
    const { cookie, csrf } = await bearerSession(f);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
    for (const path of DASHBOARD_CONSULT_CONTROL_PATHS) {
      const refused = await f.fetch(post(path, custody));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('mac_dashboard_only');
    }
    // The same cookie still works for an ordinary control route.
    expect((await f.fetch(post('/dashboard/sync-now', custody, { description: 'x', revision: 'r' }))).status).toBe(200);
    expect(f.seen.map((request) => new URL(request.url).pathname)).toEqual(['/dashboard/sync-now']);
  });

  test('bearer → launch ticket → redeem → POST a consult route: the same refusal (the ticket exchange is bearer-derived)', async () => {
    const f = fixture();
    const { cookie, csrf } = await launchSession(f);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
    for (const path of DASHBOARD_CONSULT_CONTROL_PATHS) {
      expect((await f.fetch(post(path, custody))).status).toBe(403);
    }
    expect(f.seen).toEqual([]);
  });

  test('the bearer itself, with or without a cookie, and a forged grade header, are all refused', async () => {
    const f = fixture();
    const { cookie, csrf } = await bearerSession(f);
    for (const path of DASHBOARD_CONSULT_CONTROL_PATHS) {
      expect((await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }))).status).toBe(403);
      expect((await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}`, Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }))).status).toBe(403);
      expect((await f.fetch(post(path, { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local', [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: csrf }))).status).toBe(403);
      // A cookie with its grade letter flipped fails the signature: no session at all.
      const flipped = cookie.replace(/\.b\.([A-Za-z0-9_-]{43})$/, '.l.$1');
      expect(flipped).not.toBe(cookie);
      expect((await f.fetch(post(path, { Cookie: flipped, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }))).status).toBe(401);
      // Re-signing the flipped cookie with the known bearer does not help: sessions are
      // keyed by a worker-private secret the bearer never sees (P1-a). Nor can the bearer
      // re-sign its own bearer-grade cookie by hand.
      expect((await f.fetch(post(path, { Cookie: bearerSigned(cookie, 'l'), Origin: ORIGIN, 'X-Olympus-CSRF': csrf }))).status).toBe(401);
      expect((await f.fetch(post('/dashboard/sync-now', { Cookie: bearerSigned(cookie, 'b'), Origin: ORIGIN, 'X-Olympus-CSRF': csrf }, { description: 'x' }))).status).toBe(401);
    }
    expect(f.seen).toEqual([]);
  });

  test('the signing secret is the worker\'s own, not the bearer: same secret file → the session survives a restart; a different secret → no session', async () => {
    const secret = newDashboardSessionSecret();
    const first = fixture(secret);
    const { cookie, csrf } = await bearerSession(first);
    const restarted = fixture(secret);
    expect((await restarted.fetch(post('/dashboard/sync-now', { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }, { description: 'x' }))).status).toBe(200);
    const other = fixture(newDashboardSessionSecret());
    expect((await other.fetch(post('/dashboard/sync-now', { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }, { description: 'x' }))).status).toBe(401);
    expect(other.seen).toEqual([]);
    // The bearer used as the secret is never what a worker runs with: a secret equal
    // to the bearer would make the forge above work, so the loader never produces it.
    const local = fixture(secret);
    const minted = await localSession(local);
    expect(minted.status).toBe(200);
    const localCookie = cookieOf(minted);
    const { csrf_token: localCsrf } = (await minted.json()) as { csrf_token: string };
    expect((await fixture(secret).fetch(post('/dashboard/consult', { Cookie: localCookie, Origin: ORIGIN, 'X-Olympus-CSRF': localCsrf }))).status).toBe(200);
    expect((await fixture(newDashboardSessionSecret()).fetch(post('/dashboard/consult', { Cookie: localCookie, Origin: ORIGIN, 'X-Olympus-CSRF': localCsrf }))).status).toBe(401);
  });
});

describe('the local-only mint', () => {
  test('requires a recorded loopback socket peer: a non-loopback peer with loopback Host and Origin, and a missing peer, are refused', async () => {
    const f = fixture();
    expect((await localSession(f, ORIGIN, {}, '203.0.113.9')).status).toBe(403);
    expect((await localSession(f, ORIGIN, {}, '::ffff:198.51.100.4')).status).toBe(403);
    expect((await localSession(f, ORIGIN, {}, null)).status).toBe(403);
    expect((await localSession(f, ORIGIN, {}, '::1')).status).toBe(200);
    expect((await localSession(f, ORIGIN, {}, '::ffff:127.0.0.1')).status).toBe(200);
    expect(f.seen).toEqual([]);
  });

  test('refuses any Authorization header, a non-loopback or missing Origin, a cross-origin page and proxied requests', async () => {
    const f = fixture();
    expect((await localSession(f, ORIGIN, { Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    expect((await localSession(f, ORIGIN, { Authorization: 'Bearer anything' })).status).toBe(403);
    expect((await localSession(f, 'http://olympus.example.test:28190')).status).toBe(403);
    expect((await f.fetch(new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST' }))).status).toBe(403);
    expect((await localSession(f, ORIGIN, { Origin: 'http://attacker.test' })).status).toBe(403);
    expect((await localSession(f, ORIGIN, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
    expect((await localSession(f, ORIGIN, { 'X-Forwarded-Proto': 'https' })).status).toBe(403);
    expect(f.seen).toEqual([]);
  });

  test('a loopback browser presenting no bearer gets a local-grade cookie that reaches the consult routes, with CSRF and origin still required', async () => {
    const f = fixture();
    const minted = await localSession(f);
    expect(minted.status).toBe(200);
    const cookie = cookieOf(minted);
    expect(cookie).toMatch(/\.l\.[A-Za-z0-9_-]{43}$/);
    const { csrf_token: csrf } = (await minted.json()) as { csrf_token: string };
    for (const path of DASHBOARD_CONSULT_CONTROL_PATHS) {
      expect((await f.fetch(post(path, { Cookie: cookie, Origin: ORIGIN }))).status).toBe(403);
      expect((await f.fetch(post(path, { Cookie: cookie, Origin: 'http://attacker.test', 'X-Olympus-CSRF': csrf }))).status).toBe(403);
      const ok = await f.fetch(post(path, { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }));
      expect(ok.status).toBe(200);
    }
    // The handler saw the proof headers the boundary injects, and only those.
    expect(f.seen.length).toBe(DASHBOARD_CONSULT_CONTROL_PATHS.length);
    for (const request of f.seen) {
      expect(request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)).toBe(csrf);
      expect(request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER)).toBe('local');
    }
    // A local cookie is an ordinary control session elsewhere, and the dashboard read learns its grade.
    expect((await f.fetch(post('/dashboard/sync-now', { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }, { description: 'x' }))).status).toBe(200);
    const read = await f.fetch(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }));
    expect(read.status).toBe(200);
    expect(f.seen.at(-1)!.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER)).toBe('local');
    // The IPv6 and localhost spellings are loopback too; a cookie is bound to the origin that minted it.
    expect((await localSession(f, 'http://localhost:28190')).status).toBe(200);
    expect((await localSession(f, 'http://[::1]:28190')).status).toBe(200);
  });

  test('a bearer-grade read is told its grade, so the card can offer the local unlock', async () => {
    const f = fixture();
    const { cookie } = await bearerSession(f);
    const read = await f.fetch(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }));
    expect(read.status).toBe(200);
    expect(f.seen.at(-1)!.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER)).toBe('bearer');
    // Incoming grade headers are stripped before the handler sees anything.
    await f.fetch(new Request(`${ORIGIN}/dashboard`, { headers: { Authorization: `Bearer ${TOKEN}`, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' } }));
    expect(f.seen.at(-1)!.headers.has(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER)).toBe(false);
  });
});

describe('the control-session secret file', () => {
  const homes: string[] = [];
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-session-secret-'));
    homes.push(dir);
    return dir;
  }
  test('lives beside the worker token, is created owner-only on first start, is reused after, and is never the bearer', () => {
    const dir = home();
    const env = { HOME: dir };
    expect(dashboardSessionSecretPath({ env })).toBe(join(dir, '.config', 'olympus', 'dashboard-session.secret'));
    const first = loadOrCreateDashboardSessionSecret({ env });
    expect(first.source).toBe('created');
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.config', 'olympus')).mode & 0o777).toBe(0o700);
    expect(readFileSync(first.path, 'utf8').trim()).toBe(first.secret);
    const again = loadOrCreateDashboardSessionSecret({ env });
    expect(again).toEqual({ ...first, source: 'file' });
    expect(first.secret).not.toBe(TOKEN);
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  test('a malformed, group-readable or symlinked file is regenerated in place; an unwritable location falls back to memory, never to the bearer', () => {
    const dir = home();
    const env = { HOME: dir };
    const path = dashboardSessionSecretPath({ env });
    mkdirSync(join(dir, '.config', 'olympus'), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'not a secret\n', { mode: 0o600 });
    const malformed = loadOrCreateDashboardSessionSecret({ env });
    expect(malformed.source).toBe('regenerated');
    expect(readFileSync(path, 'utf8').trim()).toBe(malformed.secret);
    chmodSync(path, 0o640);
    const exposed = loadOrCreateDashboardSessionSecret({ env });
    expect(exposed.source).toBe('regenerated');
    expect(exposed.secret).not.toBe(malformed.secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(path);
    writeFileSync(join(dir, 'elsewhere'), `${newDashboardSessionSecret()}\n`, { mode: 0o600 });
    symlinkSync(join(dir, 'elsewhere'), path);
    const linked = loadOrCreateDashboardSessionSecret({ env });
    expect(linked.source).toBe('regenerated');
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'elsewhere'), 'utf8').trim()).not.toBe(linked.secret);
    // Unwritable: a regular file where the directory should be.
    const blocked = home();
    mkdirSync(join(blocked, '.config'), { recursive: true, mode: 0o700 });
    writeFileSync(join(blocked, '.config', 'olympus'), 'file', { mode: 0o600 });
    const memory = loadOrCreateDashboardSessionSecret({ env: { HOME: blocked } });
    expect(memory.source).toBe('memory');
    expect(memory.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
});
