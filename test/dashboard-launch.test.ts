import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_LAUNCH_MINT_PATH,
  DASHBOARD_LAUNCH_PAGE_HTML,
  dashboardLaunchPageHeaders,
  DASHBOARD_LAUNCH_PAGE_PATH,
  DASHBOARD_LAUNCH_REDEEM_PATH,
  DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY,
  DASHBOARD_LAUNCH_TICKET_TTL_SECONDS,
  DashboardLaunchTickets,
} from '../src/core/dashboard-launch.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const ORIGIN = 'http://127.0.0.1:17777';
const WORKER_TOKEN = 'worker-secret';

function controlSessionCookie(setCookie: string | null): string {
  const cookie = setCookie?.split(';')[0];
  if (!cookie) throw new Error(`No Set-Cookie on the response: ${setCookie}`);
  return cookie;
}

/**
 * The tiny amount of ticket store state a test needs to observe. `size` is a
 * getter on the class, so it reads through the public seam rather than reaching
 * into the Map.
 */
function ticketCount(tickets: DashboardLaunchTickets): number {
  return tickets.size;
}

interface GuardFixture {
  fetch: (request: Request) => Promise<Response>;
  seen: Request[];
  tickets: DashboardLaunchTickets;
  advance: (ms: number) => void;
}

function guardFixture(): GuardFixture {
  let clock = Date.parse('2026-09-13T09:00:00.000Z');
  const tickets = new DashboardLaunchTickets({ now: () => clock });
  const seen: Request[] = [];
  const fetch = withWorkerBearerAuth(async (request) => {
    seen.push(request);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }, { authToken: WORKER_TOKEN, now: () => clock, launchTickets: tickets });
  return { fetch, seen, tickets, advance: (ms) => { clock += ms; } };
}

async function mintTicket(fixture: GuardFixture, origin = ORIGIN): Promise<string> {
  const response = await fixture.fetch(new Request(`${origin}${DASHBOARD_LAUNCH_MINT_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_TOKEN}`, Origin: origin },
  }));
  expect(response.status).toBe(200);
  const payload = await response.json() as { ticket: string; expires_in_seconds: number };
  expect(payload.expires_in_seconds).toBe(DASHBOARD_LAUNCH_TICKET_TTL_SECONDS);
  return payload.ticket;
}

function redeemRequest(ticket: unknown, origin = ORIGIN, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify({ ticket }),
  });
}

describe('dashboard opening tickets', () => {
  test('is 256 random bits, single use, with a bounded 15-minute life', async () => {
    // Owner decision 2026-09-24: fifteen minutes, still single-use.
    expect(DASHBOARD_LAUNCH_TICKET_TTL_SECONDS).toBe(15 * 60);
    const fixture = guardFixture();
    const ticket = await mintTicket(fixture);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing derived from a durable secret: the worker bearer and the derived
    // read token are both absent from the ticket, and no two mints collide.
    expect(ticket).not.toContain(WORKER_TOKEN);
    expect(ticket).not.toContain(dashboardQueryTokenFromWorkerAuthToken(WORKER_TOKEN)!.replace('dash_', ''));
    const otherTicket = await mintTicket(fixture);
    expect(otherTicket).not.toBe(ticket);

    const first = await fixture.fetch(redeemRequest(ticket));
    expect(first.status).toBe(200);
    // Two mints, one redemption: the redeemed ticket is gone, the other stays.
    expect(ticketCount(fixture.tickets)).toBe(1);
  });

  test('a spent, expired, malformed, or unknown ticket is refused', async () => {
    const fixture = guardFixture();
    const ticket = await mintTicket(fixture);
    expect((await fixture.fetch(redeemRequest(ticket))).status).toBe(200);
    // Replay: the same ticket, from the same origin, a moment later.
    const replay = await fixture.fetch(redeemRequest(ticket));
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: 'dashboard_launch_ticket_invalid', status: 403 },
      policy: { durable_secret_in_url: false },
    });

    // Expiry is measured from the mint, not from the last use.
    const expiring = await mintTicket(fixture);
    fixture.advance(DASHBOARD_LAUNCH_TICKET_TTL_SECONDS * 1000 - 1);
    expect((await fixture.fetch(redeemRequest(expiring))).status).toBe(200);
    const late = await mintTicket(fixture);
    fixture.advance(DASHBOARD_LAUNCH_TICKET_TTL_SECONDS * 1000 + 1);
    const expired = await fixture.fetch(redeemRequest(late));
    expect(expired.status).toBe(403);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: 'dashboard_launch_ticket_invalid' },
    });

    for (const malformed of ['', 'short', 'x'.repeat(44), 'a'.repeat(42) + '.', { ticket: 1 }, null]) {
      const refused = await fixture.fetch(redeemRequest(malformed));
      expect(refused.status, `malformed: ${JSON.stringify(malformed)}`).toBe(403);
    }
  });

  test('a ticket is bound to the origin that minted it and is not burned by a foreign probe', async () => {
    const fixture = guardFixture();
    const ticket = await mintTicket(fixture);

    // A cross-origin page cannot even reach the route: its stated Origin is not
    // this worker's request target, so the request is refused before the ticket
    // is looked at.
    const crossOrigin = await fixture.fetch(redeemRequest(ticket, ORIGIN, { Origin: 'http://attacker.test' }));
    expect(crossOrigin.status).toBe(403);

    // The same-origin page of a DIFFERENT worker origin still cannot redeem it.
    const otherOrigin = 'http://127.0.0.1:17778';
    const wrongOrigin = await fixture.fetch(redeemRequest(ticket, otherOrigin));
    expect(wrongOrigin.status).toBe(403);
    await expect(wrongOrigin.json()).resolves.toMatchObject({
      error: { code: 'dashboard_launch_origin_mismatch' },
    });

    // Neither probe consumed it: the minting origin still redeems it exactly once.
    expect((await fixture.fetch(redeemRequest(ticket))).status).toBe(200);
    expect((await fixture.fetch(redeemRequest(ticket))).status).toBe(403);
  });

  test('bounds the store and prunes tickets that have expired', () => {
    let clock = 0;
    const tickets = new DashboardLaunchTickets({ now: () => clock, maxTickets: 4 });
    for (let index = 0; index < 10; index += 1) tickets.mint(ORIGIN);
    expect(ticketCount(tickets)).toBeLessThanOrEqual(4);

    clock = DASHBOARD_LAUNCH_TICKET_TTL_SECONDS * 1000 + 1;
    const fresh = tickets.mint(ORIGIN);
    // Everything minted before the clock moved is gone; one fresh ticket remains.
    expect(ticketCount(tickets)).toBe(1);
    expect(tickets.consume(fresh, ORIGIN).status).toBe('ok');
  });
});

describe('dashboard launch worker routes', () => {
  test('serves the opening page without the worker token, and it clears the fragment before POSTing', async () => {
    const fixture = guardFixture();
    const page = await fixture.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_PAGE_PATH}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    // The page reaches no handler and carries no install fact: the worker stub
    // is never asked, and no token, ticket, or count is in the markup.
    expect(fixture.seen).toHaveLength(0);
    expect(html).not.toContain(WORKER_TOKEN);
    expect(html).not.toContain('dash_');
    expect(html).not.toContain('/dashboard?token=');
    expect(html).toContain(DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY);
    // Clear first, then the one same-origin POST. Read the fragment, replace
    // the URL, and only then call fetch.
    const clearAt = html.indexOf('replaceState');
    const postAt = html.indexOf(`fetch('/dashboard/control/launch/redeem'`);
    expect(clearAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(clearAt);
    expect(html).toContain("credentials: 'same-origin'");
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('mints only for the worker bearer: never the derived read token, never a control cookie', async () => {
    const fixture = guardFixture();
    const mintPath = `${ORIGIN}${DASHBOARD_LAUNCH_MINT_PATH}`;

    const anonymous = await fixture.fetch(new Request(mintPath, { method: 'POST', headers: { Origin: ORIGIN } }));
    expect(anonymous.status).toBe(401);

    // The dash_ query token is a READ credential. Browsers cannot put a bearer
    // header in an address bar, so this route exists only for the CLI, which
    // holds the real token.
    const readToken = dashboardQueryTokenFromWorkerAuthToken(WORKER_TOKEN)!;
    const withQueryToken = await fixture.fetch(new Request(`${mintPath}?token=${readToken}`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    }));
    expect(withQueryToken.status).toBe(401);
    const withDashBearer = await fixture.fetch(new Request(mintPath, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readToken}`, Origin: ORIGIN },
    }));
    expect(withDashBearer.status).toBe(401);

    // A live control cookie is not the bearer either.
    const unlocked = await fixture.fetch(new Request(`${ORIGIN}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_TOKEN}`, Origin: ORIGIN },
    }));
    const cookie = controlSessionCookie(unlocked.headers.get('Set-Cookie'));
    const withCookie = await fixture.fetch(new Request(mintPath, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
    }));
    expect(withCookie.status).toBe(401);

    // And a bearer without a matching origin is refused, because the ticket has
    // to be redeemable by the browser the CLI is about to open.
    const noOrigin = await fixture.fetch(new Request(mintPath, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
    }));
    expect(noOrigin.status).toBe(403);
    const foreignOrigin = await fixture.fetch(new Request(mintPath, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_TOKEN}`, Origin: 'http://attacker.test' },
    }));
    expect(foreignOrigin.status).toBe(403);

    // The one accepted shape returns a ticket and nothing else durable.
    const minted = await fixture.fetch(new Request(mintPath, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_TOKEN}`, Origin: ORIGIN },
    }));
    expect(minted.status).toBe(200);
    const payload = await minted.json() as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['expires_in_seconds', 'ok', 'policy', 'ticket']);
    expect(JSON.stringify(payload)).not.toContain(WORKER_TOKEN);
    expect(JSON.stringify(payload)).not.toContain('dash_');
    expect(minted.headers.get('Set-Cookie')).toBeNull();
    expect(fixture.seen).toHaveLength(0);
  });

  test('redeeming sets the existing origin-bound HttpOnly control cookie, and that cookie still needs CSRF', async () => {
    const fixture = guardFixture();
    const ticket = await mintTicket(fixture);
    const redeemed = await fixture.fetch(redeemRequest(ticket));
    expect(redeemed.status).toBe(200);
    const setCookie = redeemed.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain('HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=2592000');
    expect(setCookie).not.toContain(WORKER_TOKEN);
    expect(setCookie).not.toContain('dash_');
    const cookie = controlSessionCookie(setCookie);
    const payload = await redeemed.json() as { csrf_token: string; next: string; policy: Record<string, boolean> };
    expect(payload.next).toBe('/dashboard');
    expect(payload.csrf_token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(payload.policy).toMatchObject({ http_only_cookie: true, csrf_required: true, origin_bound: true });
    expect(fixture.seen).toHaveLength(0);

    // The walked-out cookie is a real control session: it renders the page, and
    // a control POST through it still needs the matching CSRF token and origin.
    const render = await fixture.fetch(new Request(`${ORIGIN}/dashboard`, { headers: { Cookie: cookie } }));
    expect(render.status).toBe(200);
    expect(fixture.seen).toHaveLength(1);

    const missingCsrf = await fixture.fetch(new Request(`${ORIGIN}/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
    }));
    expect(missingCsrf.status).toBe(403);
    const wrongCsrf = await fixture.fetch(new Request(`${ORIGIN}/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': 'nope' },
    }));
    expect(wrongCsrf.status).toBe(403);
    const allowed = await fixture.fetch(new Request(`${ORIGIN}/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': payload.csrf_token },
    }));
    expect(allowed.status).toBe(200);

    // A control cookie minted by the launch handoff is exactly as bound: it does
    // not work against another origin of the same host.
    const foreign = await fixture.fetch(new Request(`http://127.0.0.1:17778/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://127.0.0.1:17778', 'X-Olympus-CSRF': payload.csrf_token },
    }));
    expect(foreign.status).toBe(403);
  });

  test('the durable worker token never appears in the opening URL, the page, or the mint answer', async () => {
    const fixture = guardFixture();
    const ticket = await mintTicket(fixture);
    const page = await (await fixture.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_PAGE_PATH}`))).text();
    const minted = await fixture.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_MINT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_TOKEN}`, Origin: ORIGIN },
    }));
    const mintBody = await minted.text();
    for (const surface of [page, mintBody, ticket]) {
      expect(surface).not.toContain(WORKER_TOKEN);
      expect(String(surface)).not.toContain(`dash_`);
    }
  });
});


describe('launch handoff boundary regressions', () => {
  test('capacity one retains the newly minted ticket', () => {
    const tickets = new DashboardLaunchTickets({ maxTickets: 1 });
    const old = tickets.mint(ORIGIN);
    const fresh = tickets.mint(ORIGIN);
    expect(tickets.size).toBe(1);
    expect(tickets.consume(old, ORIGIN).status).toBe('unknown');
    expect(tickets.consume(fresh, ORIGIN).status).toBe('ok');
    expect(() => new DashboardLaunchTickets({ maxTickets: 0 })).toThrow();
  });

  test('only one concurrent redemption can set a cookie', async () => {
    const fixture = guardFixture();
    const ticket = await mintTicket(fixture);
    const replies = await Promise.all([fixture.fetch(redeemRequest(ticket)), fixture.fetch(redeemRequest(ticket))]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 403]);
    expect(replies.filter(r => r.headers.has('Set-Cookie'))).toHaveLength(1);
  });

  test('rejects and cancels an oversized streamed body before waiting for EOF', async () => {
    const fixture = guardFixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel() { cancelled = true; },
    });
    const response = await fixture.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body,
    }));
    expect(response.status).toBe(403);
    expect(cancelled).toBe(true);
    expect(response.headers.has('Set-Cookie')).toBe(false);
  });

  test('clears malformed extra fragment fields before submitting a valid ticket', async () => {
    const ticket = 'A'.repeat(43);
    const order: string[] = [];
    const script = DASHBOARD_LAUNCH_PAGE_HTML.split('<script>')[1]!.split('</script>')[0]!;
    const window = {
      location: { hash: `#olympus_launch_ticket=${ticket}&%=x`, pathname: '/dashboard/launch', search: '', replace: () => order.push('navigate') },
      history: { replaceState: () => { order.push('clear'); window.location.hash = ''; } },
    };
    const document = { getElementById: () => ({ textContent: '' }) };
    const fetch = async (_path: string, init: RequestInit) => {
      order.push('redeem');
      expect(window.location.hash).toBe('');
      expect(JSON.parse(init.body as string)).toEqual({ ticket });
      return new Response('{}');
    };
    new Function('window', 'document', 'fetch', 'URLSearchParams', script)(window, document, fetch, URLSearchParams);
    await Promise.resolve();
    expect(order).toEqual(['clear', 'redeem', 'navigate']);
    const csp = dashboardLaunchPageHeaders()['Content-Security-Policy']!;
    expect(csp).toContain("script-src 'sha256-");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });
});
