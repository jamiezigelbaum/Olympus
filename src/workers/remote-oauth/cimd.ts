/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
 * a client_id that is an https URL naming the client's own metadata. Claude
 * (`https://claude.ai/oauth/mcp-oauth-client-metadata`) and ChatGPT
 * (`https://chatgpt.com/oauth/client.json`) identify themselves this way.
 *
 * Fetching a URL a stranger chose is server-side request forgery waiting to
 * happen, so the fetch is deliberately narrow:
 * - https on the default port only; no credentials, fragment, or redirects;
 * - the host is resolved once, every resolved address must be public (no
 *   private, loopback, link-local, CGNAT, multicast or reserved ranges, IPv4
 *   or IPv6, including mapped and NAT64 forms), and the TLS connection goes to
 *   that pinned address, so a DNS answer that changes between check and use
 *   (rebinding) cannot redirect it; the certificate is still verified against
 *   the hostname through SNI;
 * - a 5 second deadline and a 64 KiB response cap;
 * - results cached for at most five minutes.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { sanitizeCallerDisplayName } from '../../core/operation-caller.ts';
import { isAcceptableRedirectUri } from './redirect-uris.ts';

export const CIMD_FETCH_TIMEOUT_MS = 5_000;
export const CIMD_MAX_BYTES = 64 * 1024;
export const CIMD_CACHE_MAX_TTL_MS = 5 * 60_000;
const CIMD_CACHE_MIN_TTL_MS = 30_000;
const CIMD_CACHE_MAX_ENTRIES = 128;
const MAX_REDIRECT_URIS = 20;
const MAX_URL_LENGTH = 2048;

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** The host that vouches for this metadata: the client_id URL's host. */
  clientIdHost: string;
}

export class ClientMetadataError extends Error {}

export interface CimdFetchOptions {
  /** Resolves a hostname to its addresses. Defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Address policy; defaults to {@link isPublicAddress}. Tests widen it. */
  isAllowedAddress?: (address: string) => boolean;
  /** Extra trust anchors (tests with a local certificate authority). */
  ca?: string;
  /** Connect here instead of 443 (tests with a local server). */
  portOverride?: number;
  timeoutMs?: number;
}

/** Whether a client_id is shaped like a metadata document URL. */
export function isClientIdMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://');
}

export function parseClientIdMetadataUrl(clientId: string): URL {
  if (clientId.length > MAX_URL_LENGTH) throw new ClientMetadataError('client_id is too long.');
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError('client_id is not a URL.');
  }
  if (url.protocol !== 'https:') throw new ClientMetadataError('client_id must use https.');
  if (url.username || url.password) throw new ClientMetadataError('client_id must not carry credentials.');
  if (url.hash || clientId.includes('#')) throw new ClientMetadataError('client_id must not have a fragment.');
  if (url.port !== '') throw new ClientMetadataError('client_id must use the default https port.');
  if (url.pathname === '/' || url.pathname === '') throw new ClientMetadataError('client_id must have a path.');
  if (/(^|\/)\.\.?(\/|$)/.test(url.pathname)) throw new ClientMetadataError('client_id must not have dot segments.');
  return url;
}

/**
 * Validates a fetched document. Olympus serves public clients only (PKCE, no
 * client secret), so a document must allow `none` at the token endpoint.
 * ChatGPT declares `private_key_jwt` as its preference but lists `none` among
 * the methods it supports, and it picks from the intersection with ours.
 */
export function validateClientMetadataDocument(document: unknown, clientId: string): ClientMetadata {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ClientMetadataError('Client metadata is not a JSON object.');
  }
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) throw new ClientMetadataError('Client metadata client_id does not match its URL.');
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) {
    throw new ClientMetadataError('Client metadata must not contain a client secret.');
  }
  const method = doc.token_endpoint_auth_method;
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? doc.token_endpoint_auth_methods_supported
    : [];
  if (method !== undefined && method !== 'none' && !supported.includes('none')) {
    throw new ClientMetadataError('Olympus accepts public clients only (token_endpoint_auth_method none).');
  }
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw new ClientMetadataError('Client metadata must list redirect_uris.');
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAcceptableRedirectUri(uri)) {
      throw new ClientMetadataError('Client metadata lists a redirect URI that is not https or loopback.');
    }
  }
  const host = new URL(clientId).hostname;
  return {
    clientId,
    clientName: sanitizeCallerDisplayName(doc.client_name) ?? host,
    redirectUris: redirectUris as string[],
    clientIdHost: host,
  };
}

/** A fetcher with a short-lived cache in front of it. */
export function createClientMetadataResolver(options: CimdFetchOptions & { now?: () => number } = {}): (
  clientId: string,
) => Promise<ClientMetadata> {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: ClientMetadata; expiresAt: number }>();
  return async (clientId) => {
    const hit = cache.get(clientId);
    if (hit && hit.expiresAt > now()) return hit.value;
    cache.delete(clientId);
    const url = parseClientIdMetadataUrl(clientId);
    const fetched = await fetchPinnedJson(url, options);
    const value = validateClientMetadataDocument(fetched.body, clientId);
    if (cache.size >= CIMD_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const ttl = Math.min(CIMD_CACHE_MAX_TTL_MS, Math.max(CIMD_CACHE_MIN_TTL_MS, fetched.maxAgeMs ?? CIMD_CACHE_MAX_TTL_MS));
    cache.set(clientId, { value, expiresAt: now() + ttl });
    return value;
  };
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/** Resolves, checks and pins the address, then GETs the URL over TLS. */
export async function fetchPinnedJson(
  url: URL,
  options: CimdFetchOptions = {},
): Promise<{ body: unknown; maxAgeMs: number | undefined }> {
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const timeoutMs = options.timeoutMs ?? CIMD_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await withTimeout((options.resolve ?? defaultResolve)(hostname), timeoutMs);
    } catch {
      throw new ClientMetadataError('Client metadata host did not resolve.');
    }
  }
  if (addresses.length === 0) throw new ClientMetadataError('Client metadata host did not resolve.');
  // Every answer must be public: picking the "good" one of a mixed answer
  // would let a rebinding resolver choose for us.
  if (!addresses.every((address) => allowed(address))) {
    throw new ClientMetadataError('Client metadata host resolves to a private or reserved address.');
  }
  const address = addresses[0]!;
  const raw = await tlsGet({
    address,
    port: options.portOverride ?? 443,
    servername: isIP(hostname) ? undefined : hostname,
    hostHeader: url.host,
    path: `${url.pathname}${url.search}`,
    ca: options.ca,
    remainingMs: Math.max(1, deadline - Date.now()),
  });
  const response = parseHttpResponse(raw);
  if (response.status !== 200) {
    throw new ClientMetadataError(`Client metadata fetch returned HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
  } catch {
    throw new ClientMetadataError('Client metadata is not valid JSON.');
  }
  return { body, maxAgeMs: parseMaxAge(response.headers.get('cache-control')) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function tlsGet(input: {
  address: string;
  port: number;
  servername: string | undefined;
  hostHeader: string;
  path: string;
  ca: string | undefined;
  remainingMs: number;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let socket: TLSSocket | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new ClientMetadataError('Client metadata fetch timed out.')), input.remainingMs);
    try {
      socket = tlsConnect({
        host: input.address,
        port: input.port,
        ...(input.servername ? { servername: input.servername } : {}),
        ...(input.ca ? { ca: [input.ca] } : {}),
        ALPNProtocols: ['http/1.1'],
        // The certificate is verified against `servername` (the hostname we
        // resolved), not the pinned address.
        rejectUnauthorized: true,
      }, () => {
        socket!.write(
          `GET ${input.path} HTTP/1.1\r\nHost: ${input.hostHeader}\r\nAccept: application/json\r\n`
          + 'User-Agent: Olympus-OAuth/1\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n',
        );
      });
    } catch {
      finish(new ClientMetadataError('Client metadata host could not be reached.'));
      return;
    }
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > CIMD_MAX_BYTES + 16 * 1024) {
        finish(new ClientMetadataError('Client metadata is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', () => finish(new ClientMetadataError('Client metadata host could not be reached securely.')));
  });
}

interface ParsedHttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** A small HTTP/1.1 response parser: status, headers, and a length-delimited, chunked or close-delimited body. */
export function parseHttpResponse(raw: Buffer): ParsedHttpResponse {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new ClientMetadataError('Client metadata response was incomplete.');
  const lines = raw.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '');
  if (!statusMatch) throw new ClientMetadataError('Client metadata response was not HTTP/1.1.');
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      throw new ClientMetadataError('Client metadata response had a malformed header.');
    }
  }
  const rest = raw.subarray(headerEnd + 4);
  let body: Buffer;
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunked(rest);
  } else if (headers.has('content-length')) {
    const length = Number(headers.get('content-length'));
    if (!Number.isInteger(length) || length < 0 || length > rest.length) {
      throw new ClientMetadataError('Client metadata response was truncated.');
    }
    body = rest.subarray(0, length);
  } else {
    body = rest;
  }
  if (body.length > CIMD_MAX_BYTES) throw new ClientMetadataError('Client metadata is too large.');
  return { status: Number(statusMatch[1]), headers, body };
}

function decodeChunked(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = data.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new ClientMetadataError('Client metadata response was truncated.');
    const size = Number.parseInt(data.subarray(offset, lineEnd).toString('latin1').split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new ClientMetadataError('Client metadata response was malformed.');
    if (size === 0) break;
    const start = lineEnd + 2;
    if (start + size > data.length) throw new ClientMetadataError('Client metadata response was truncated.');
    parts.push(data.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

function parseMaxAge(cacheControl: string | null): number | undefined {
  if (!cacheControl) return undefined;
  if (/no-store|no-cache/i.test(cacheControl)) return 0;
  const match = /max-age=(\d+)/i.exec(cacheControl);
  return match ? Number(match[1]) * 1000 : undefined;
}

/** Whether an IP address is on the public internet (not private, loopback, link-local or reserved). */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(bare);
  if (family === 4) return isPublicIPv4(bare);
  if (family === 6) return isPublicIPv6(bare);
  return false;
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
];

function isPublicIPv4(address: string): boolean {
  const value = ipv4ToInt(address);
  return !BLOCKED_IPV4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandIPv6(address: string): number[] | undefined {
  let text = address.toLowerCase();
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two hextets.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const value = ipv4ToInt(dotted[1]!);
    text = `${text.slice(0, -dotted[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
    .map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

function isPublicIPv6(address: string): boolean {
  const g = expandIPv6(address);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number): string =>
    `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  if (g.every((group) => group === 0)) return false; // ::
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 address.
  if (g.slice(0, 5).every((group) => group === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicIPv4(embeddedV4(g[6]!, g[7]!));
  }
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return false;
    return isPublicIPv4(embeddedV4(g[6]!, g[7]!));
  }
  if (g[0] === 0x2002) return isPublicIPv4(embeddedV4(g[1]!, g[2]!)); // 6to4
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (first === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 IETF protocol assignments (Teredo, ORCHID…)
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only
  if ((first & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  return true;
}
