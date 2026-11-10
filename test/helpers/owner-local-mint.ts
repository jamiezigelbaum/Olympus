import { recordRequestPeer } from '../../src/core/request-peer.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH } from '../../src/workers/http.ts';

/**
 * The local mint as the owner's browser makes it on a computer with no owner
 * socket (macOS): the browser already holds the control session the owner's
 * launch link or token opened, and asks from a loopback peer, same origin, no
 * bearer (#1153). `headers` add to or replace the browser's own.
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
  await owner.body?.cancel();
  const cookie = (owner.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  const request = new Request(`${origin}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, ...headers },
  });
  if (peer !== null) recordRequestPeer(request, peer);
  return fetcher(request);
}
