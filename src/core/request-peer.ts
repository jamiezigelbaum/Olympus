/**
 * The network peer of a request, as the server saw it. `Request` objects carry
 * no peer address, and routes are plain `(request) => Response` functions, so
 * the server entry point records each request's peer here
 * (`withRequestPeer`) and a route that must know it (the OAuth approval in
 * relay mode, workers/remote-oauth/handler.ts) reads it back. A request the
 * server never recorded has no peer, which such a route treats as remote.
 */

const peers = new WeakMap<Request, string>();

export function recordRequestPeer(request: Request, address: string | undefined): void {
  if (address) peers.set(request, address);
}

export function requestPeerAddress(request: Request): string | undefined {
  return peers.get(request);
}

/** 127.0.0.0/8, ::1, and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  const v4 = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

interface PeerServer {
  requestIP(request: Request): { address: string } | null;
}

/** A Bun.serve `fetch` that records each request's peer before handing it on. */
export function withRequestPeer(
  handler: (request: Request) => Response | Promise<Response>,
): (request: Request, server: PeerServer) => Response | Promise<Response> {
  return (request, server) => {
    try {
      recordRequestPeer(request, server?.requestIP(request)?.address);
    } catch {
      // No peer recorded: routes that need one treat the request as remote.
    }
    return handler(request);
  };
}
