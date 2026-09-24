/**
 * The install's TLS endpoint: terminates the hosted agent's TLS with the
 * install's own certificate and forwards allowed HTTP requests to the loopback
 * Olympus worker.
 *
 * Only remote-surface paths are forwarded. The worker's other loopback routes
 * (dashboard, local control APIs) assume a local caller and must never become
 * reachable from the internet through the relay; everything else gets a local
 * 404 without touching the worker. Forwarding headers from the internet are
 * discarded and replaced with the relay's own view.
 *
 * It listens on a loopback port because Bun cannot wrap an existing socket as
 * a server-side TLS socket; the relay client pipes each data connection into it.
 */
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

export const DEFAULT_ALLOWED_PATHS = [
  '/mcp',
  '/openapi.json',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
] as const;

export interface LocalEndpointOptions {
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  /** Loopback Olympus worker, e.g. `http://127.0.0.1:28090`. */
  readonly target: string;
  readonly allowedPaths?: readonly string[];
  /** Maps the loopback source port of a piped data connection to the agent's address. */
  readonly peerAddress?: (localSourcePort: number | undefined) => string | undefined;
}

export interface LocalEndpoint {
  readonly port: number;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const UNTRUSTED_FORWARDING = /^(forwarded|x-forwarded-.*|x-real-ip|x-olympus-relay.*)$/;

/**
 * Returns the normalized path-and-query to forward, or undefined when the
 * request is outside the allowed remote surface. Dot segments, encoded
 * separators, and backslashes are refused rather than normalized, so the
 * worker can never resolve a forwarded path differently than this check did.
 */
export function allowedForwardPath(rawUrl: string | undefined, allowed: readonly string[]): string | undefined {
  if (!rawUrl || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return undefined;
  const rawPath = rawUrl.split('?', 1)[0]!;
  if (/%2e|%2f|%5c|\\/i.test(rawPath) || rawPath.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://relay.invalid');
  } catch {
    return undefined;
  }
  if (url.pathname !== rawPath) return undefined;
  if (!allowed.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return undefined;
  return `${url.pathname}${url.search}`;
}

function forwardedHeaders(incoming: IncomingHttpHeaders, peer: string | undefined): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    String(incoming.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || connectionTokens.has(lower) || UNTRUSTED_FORWARDING.test(lower)) continue;
    headers[lower] = value;
  }
  headers['x-olympus-relay'] = '1';
  headers['x-forwarded-proto'] = 'https';
  if (typeof incoming.host === 'string') headers['x-forwarded-host'] = incoming.host;
  if (peer) headers['x-forwarded-for'] = peer;
  return headers;
}

export async function startLocalEndpoint(options: LocalEndpointOptions): Promise<LocalEndpoint> {
  const allowed = options.allowedPaths ?? DEFAULT_ALLOWED_PATHS;
  const target = new URL(options.target);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('the relay client only forwards to a loopback http:// worker');
  }
  const server = https.createServer({ key: options.key, cert: options.cert, minVersion: 'TLSv1.2' }, (req, res) => {
    const path = allowedForwardPath(req.url, allowed);
    if (!path) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: 'This Olympus address only serves its remote agent endpoints.' }));
      return;
    }
    const peer = options.peerAddress?.(req.socket.remotePort);
    const upstream = http.request(
      {
        protocol: 'http:',
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80,
        method: req.method,
        path,
        headers: forwardedHeaders(req.headers, peer),
      },
      (upstreamRes) => {
        const headers: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'worker_unavailable', message: 'Olympus is running but its local worker did not answer.' }));
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
