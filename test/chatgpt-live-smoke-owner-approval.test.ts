/**
 * The live smoke approves its client the way the owner does (#1186): it posts
 * to the approval page's own form action and sends the owner's dashboard
 * session with it. On a Mac that form posts to /dashboard/connect/authorize
 * and the session is the owner proof; posting to /connect/authorize without
 * it is refused, which left the release check's ChatGPT-protocol pass with no
 * results on the Mac legs (olympus-ops#149).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { obtainSmokeGrant } from '../scripts/chatgpt-live-smoke.ts';

const OWNER = 'olympus_dashboard_control=owner-session';
let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let approvals: Array<{ path: string; cookie: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-smoke-owner-'));
  approvals = [];
  let state = '';
  let redirect = '';
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return Response.json({ resource: `${base}/mcp` });
      if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/connect/token` });
      if (url.pathname === '/connect/authorize' && request.method === 'GET') {
        state = url.searchParams.get('state') ?? '';
        redirect = url.searchParams.get('redirect_uri') ?? '';
        const id = 'a'.repeat(32);
        return new Response(
          `<form method="post" action="/dashboard/connect/authorize"><input type="hidden" name="request_id" value="${id}"><input type="hidden" name="csrf" value="tok"></form>`,
          { headers: { 'content-type': 'text/html', 'set-cookie': `olympus_consent_${id}=tok; Path=/dashboard` } },
        );
      }
      if (request.method === 'POST' && url.pathname.endsWith('/connect/authorize')) {
        const cookie = request.headers.get('cookie') ?? '';
        approvals.push({ path: url.pathname, cookie });
        if (url.pathname !== '/dashboard/connect/authorize' || !cookie.includes(OWNER)) return new Response('owner needed', { status: 403 });
        const back = new URL(redirect);
        back.search = new URLSearchParams({ code: 'c', state, iss: base }).toString();
        return new Response(null, { status: 303, headers: { location: back.toString() } });
      }
      if (url.pathname === '/connect/token') return Response.json({ access_token: 'at', refresh_token: 'rt' });
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('the approval goes to the page form action with the owner session', async () => {
  const grant = await obtainSmokeGrant({ engine: base, relay: base, stateFile: join(dir, 's.json'), ownerCookie: OWNER });
  expect(grant.accessToken).toBe('at');
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.path).toBe('/dashboard/connect/authorize');
  expect(approvals[0]!.cookie).toContain(`olympus_consent_${'a'.repeat(32)}=tok`);
  expect(approvals[0]!.cookie).toContain(OWNER);
});

test('without the owner session the approval is refused, and the smoke says so', async () => {
  await expect(obtainSmokeGrant({ engine: base, relay: base, stateFile: join(dir, 's.json') })).rejects.toThrow('loopback approval answered 403');
});
