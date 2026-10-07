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
import { describe, expect, test } from 'bun:test';
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

function fixture() {
  let clock = Date.parse('2026-10-07T12:00:00.000Z');
  const seen: Request[] = [];
  const fetch = withWorkerBearerAuth(async (request) => {
    seen.push(request);
    return new Response(JSON.stringify({ ok: true, handler: true }), { headers: { 'Content-Type': 'application/json' } });
  }, { authToken: TOKEN, now: () => clock, launchTickets: new DashboardLaunchTickets({ now: () => clock }) });
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

async function localSession(f: ReturnType<typeof fixture>, origin = ORIGIN, headers: Record<string, string> = {}): Promise<Response> {
  return f.fetch(new Request(`${origin}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: origin, ...headers } }));
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
    expect((await f.fetch(post('/dashboard/privacy', custody, { description: 'x', revision: 'r' }))).status).toBe(200);
    expect(f.seen.map((request) => new URL(request.url).pathname)).toEqual(['/dashboard/privacy']);
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
    }
    expect(f.seen).toEqual([]);
  });
});

describe('the local-only mint', () => {
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
    expect((await f.fetch(post('/dashboard/privacy', { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }, { description: 'x' }))).status).toBe(200);
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
