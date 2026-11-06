import { describe, expect, test } from 'bun:test';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';

const origin = 'http://127.0.0.1:28190';
const paths = ['start', 'status', 'respond', 'cancel', 'chats', 'scope'].map((name) => `/dashboard/messaging/${name}`);

describe('dashboard messaging custody', () => {
  test('only a local socket, local session, same origin and CSRF can reach pairing', async () => {
    let calls = 0;
    const guarded = withWorkerBearerAuth(async () => { calls++; return new Response('ok'); }, { authToken: 'worker-secret' });
    const mint = new Request(origin + DASHBOARD_LOCAL_CONTROL_SESSION_PATH, { method: 'POST', headers: { Origin: origin } });
    recordRequestPeer(mint, '127.0.0.1');
    const minted = await guarded(mint);
    const cookie = minted.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await minted.json() as { csrf_token: string }).csrf_token;
    const request = (path: string, headers: Record<string, string> = {}, peer?: string) => {
      const req = new Request(origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Olympus-CSRF': csrf, ...headers } });
      if (peer) recordRequestPeer(req, peer);
      return req;
    };
    for (const path of paths) {
      expect((await guarded(request(path, {}, '127.0.0.1'))).status).toBe(200);
      expect((await guarded(request(path, {}, '192.0.2.1'))).status).toBe(403);
      expect((await guarded(request(path))).status).toBe(403);
      expect((await guarded(request(path, { 'X-Forwarded-For': '192.0.2.1' }, '127.0.0.1'))).status).toBe(403);
      expect((await guarded(request(path, { Origin: 'http://attacker.test' }, '127.0.0.1'))).status).toBe(403);
      expect((await guarded(request(path, { 'X-Olympus-CSRF': 'wrong' }, '127.0.0.1'))).status).toBe(403);
      expect((await guarded(request(path, { Authorization: 'Bearer worker-secret' }, '127.0.0.1'))).status).toBe(403);
    }
    expect(calls).toBe(paths.length);
  });
});
