/**
 * The offline tool lists the relay serves for this install's agents
 * (docs/design/background-agents.md, section E): which tool surface each live
 * access token for `/mcp` gets, so while this computer is offline the relay
 * lists ChatGPT's tools to a ChatGPT connection and the remote tools to every
 * other agent, and never the reverse.
 *
 * The relay child reads it from this loopback route (core/remote-access.ts
 * RELAY_SURFACES_PATH) with its per-boot secret and sends it over its own
 * authenticated session (connect-relay/client/relay-client.ts), whole, each
 * time it changes. What leaves is content-free: per token, a one-way
 * fingerprint of its stored digest (connect-relay/shared/tokens.ts), the
 * endpoint, the surface and the expiry. No token, digest, name, provider,
 * connection id or question. A rotated token appears with its new
 * fingerprint (the old access token is deleted at rotation); a revoked or
 * expired one is gone from the next read.
 *
 * Tokens for the plugin directory's endpoint are not listed: the relay serves
 * that endpoint ChatGPT's directory list whatever the token.
 */
import { MAX_SURFACE_ENTRIES, type SurfaceEntry } from '../../connect-relay/shared/protocol.ts';
import { surfaceFingerprint } from '../../connect-relay/shared/tokens.ts';
import { RELAY_SURFACES_PATH } from '../core/remote-access.ts';
import type { RemoteConnectionStore } from '../core/remote-connections.ts';
import { currentRemotePublicUrls, remoteMcpResource, type RemotePublicUrlsSource } from '../core/remote-public-url.ts';
import { isChatGptGrant } from './remote-oauth/pinned-clients.ts';

export interface RelaySurfacesOptions {
  /** The connection store, when one exists (never created here). */
  connections: () => RemoteConnectionStore | undefined;
  publicUrls: RemotePublicUrlsSource;
  /** Whether a request carries the relay child's per-boot secret (core/remote-access.ts isRelayedRequest). */
  isRelayed: (request: Request) => boolean;
}

/** The mapping as it stands: at most MAX_SURFACE_ENTRIES, latest expiry first; empty when the relay is off or no store exists. */
export function relaySurfaceEntries(options: Pick<RelaySurfacesOptions, 'connections' | 'publicUrls'>): SurfaceEntry[] {
  const urls = currentRemotePublicUrls(options.publicUrls);
  if (!urls) return [];
  const store = options.connections();
  if (!store) return [];
  const resource = remoteMcpResource(urls, 'default').resource;
  return store.oauth.liveAccessTokens(resource, MAX_SURFACE_ENTRIES).map((token) => ({
    endpoint: 'default',
    fingerprint: surfaceFingerprint(token.tokenHash),
    // The surface the worker serves this token through the relay (email-source/server.ts servesRequest).
    surface: isChatGptGrant({ clientId: token.clientId }) ? 'chatgpt' : 'remote',
    expiresAt: Math.floor(Date.parse(token.expiresAt) / 1000),
  }));
}

export function createRelaySurfacesHandler(options: RelaySurfacesOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    // Only the relay child, by its secret; anyone else finds nothing here.
    if (request.method !== 'GET' || !options.isRelayed(request)) return reply(404, { error: 'not_found' });
    try {
      return reply(200, { v: 1, entries: relaySurfaceEntries(options) });
    } catch {
      // The child keeps the relay's last mapping and asks again later.
      return reply(503, { error: 'unavailable' });
    }
  };
}

/** Routes RELAY_SURFACES_PATH to `handler` and everything else to `rest`. */
export function withRelaySurfacesRoute(
  handler: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => (new URL(request.url).pathname === RELAY_SURFACES_PATH ? handler(request) : rest(request));
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
