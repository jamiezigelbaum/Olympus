import { recordRequestPeer } from '../../src/core/request-peer.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH } from '../../src/workers/http.ts';

/**
 * The local mint as the owner's browser makes it on any platform: the browser
 * already holds the control session the owner's launch link or token opened
 * and its CSRF token (#1187), and asks from a loopback peer, same origin, no
 * bearer (#1153, #1188). `headers` add to or replace the browser's own.
 */
export async function ownerLocalMint(
  fetcher: (request: Request) => Promise<Response> | Response,
  origin: string,
  token: string,
  headers: Record<string, string> = {},
  peer: string | null = '127.0.0.1',
): Promise<Response> {
  const owner = await fetcher(new Request(`${origin}/dashboard/control/session`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: origin },
  }));
  if (owner.status !== 200) throw new Error(`the owner's control session answered ${owner.status}`);
  const { csrf_token: csrf } = await owner.json() as { csrf_token: string };
  const cookie = (owner.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  const request = new Request(`${origin}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-Olympus-CSRF': csrf, ...headers },
  });
  if (peer !== null) recordRequestPeer(request, peer);
  return fetcher(request);
}

/**
 * The unlock key the owner's browser keeps for this origin (#1187). Any
 * control session minted at the origin hands out the same one, so a test that
 * holds the worker token reads it from a bearer mint. A page navigation needs
 * it beside the cookie: the cookie alone renders the unlock shell.
 */
export async function ownerUnlockKey(
  fetcher: (request: Request) => Promise<Response> | Response,
  origin: string,
  token: string,
): Promise<string> {
  const minted = await fetcher(new Request(`${origin}/dashboard/control/session`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: origin },
  }));
  if (minted.status !== 200) throw new Error(`the owner's control session answered ${minted.status}`);
  return (await minted.json() as { unlock_key: string }).unlock_key;
}
