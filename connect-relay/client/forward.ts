/**
 * What the install lets through from the relay to its loopback worker.
 *
 * Only the remote surface ChatGPT uses is forwarded (`/mcp`, and the token
 * and revocation endpoints). The worker's other loopback routes (dashboard,
 * local control APIs, the consent page) assume a local caller and must never
 * become reachable from the internet; the client answers everything else with
 * a local 404 without touching the worker. A compromised relay is assumed:
 * these checks do not rely on the relay's own filtering.
 *
 * Every forwarded request carries `x-olympus-relay: <per-boot secret>`, and
 * any inbound header of that name, or of the forwarding family, is dropped
 * first. The worker refuses approval for any request that carries the
 * header, so consent can only ever come from a direct loopback visit.
 */

import { PRIVATE_ANSWER_PATH_PATTERN } from '../shared/private-answer.ts';

/** Must equal RELAYED_REQUEST_HEADER in src/core/remote-access.ts (a test holds them equal). */
export const RELAY_HEADER = 'x-olympus-relay';

export const FORWARDED_PATHS = ['/mcp', '/connect/token', '/connect/revoke'] as const;
/**
 * Browser routes ChatGPT setup needs, GET only: a one-time hand-off link
 * (`/go/oly2g.<installId>.<secret>`, served by workers/chatgpt/handoff.ts) and
 * the publisher-app sign-in callback for flows the engine started for ChatGPT
 * (verified against the signed state the engine minted). Nothing else under
 * either prefix is forwarded.
 */
const BROWSER_GET_PATHS: readonly RegExp[] = [
  /^\/go\/oly2g\.[a-z2-7]{32}\.[A-Za-z0-9_-]{43}$/,
  /^\/oauth\/callback\/(gmail|google-drive|dropbox)$/,
];
/**
 * The private answer panel's one-time collection, POST only and exactly
 * `/private/oly2p.<installId>.<secret>` with no query
 * (src/workers/chatgpt/private-answer-jobs.ts). Nothing else under the prefix.
 */
const POST_PATH_PATTERNS: readonly RegExp[] = [PRIVATE_ANSWER_PATH_PATTERN];
/**
 * Reviewer sign-in, forwarded only by a demo install (its data directory
 * carries the demo marker; src/core/remote-access.ts `demoInstallMarked`).
 */
export const DEMO_AUTHORIZE_PATH = '/connect/demo/authorize';
export const FORWARDED_METHODS = new Set(['GET', 'POST', 'DELETE']);

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
  'host',
  'content-length',
  // fetch() decodes compressed bodies itself; the bytes relayed are always identity-encoded.
  'accept-encoding',
  'content-encoding',
]);
const UNTRUSTED = /^(forwarded|x-forwarded-.*|x-real-ip|x-olympus-relay.*|cookie)$/;

/**
 * The normalized path-and-query to forward, or undefined when the request is
 * outside the forwarded surface. Dot segments, encoded separators and
 * backslashes are refused rather than normalized, so the worker can never
 * resolve a forwarded path differently than this check did.
 */
export function forwardPath(rawPath: string, allowed: readonly string[] = FORWARDED_PATHS, method = 'POST'): string | undefined {
  if (typeof rawPath !== 'string' || rawPath.length > 2048 || !rawPath.startsWith('/') || rawPath.startsWith('//')) return undefined;
  const pathOnly = rawPath.split('?', 1)[0]!;
  if (/%2e|%2f|%5c|\\/i.test(pathOnly) || pathOnly.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  let url: URL;
  try {
    url = new URL(rawPath, 'http://relay.invalid');
  } catch {
    return undefined;
  }
  if (url.pathname !== pathOnly) return undefined;
  const browserGet = method === 'GET' && BROWSER_GET_PATHS.some((pattern) => pattern.test(url.pathname));
  const postPattern = method === 'POST' && url.search === '' && POST_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname));
  if (!allowed.includes(url.pathname) && !browserGet && !postPattern) return undefined;
  return `${url.pathname}${url.search}`;
}

/** Request headers for the worker: inbound relay/forwarding headers dropped, the relay marker set. */
export function forwardRequestHeaders(wire: Array<[string, string]>, relaySecret: string): Headers {
  const headers = new Headers();
  for (const [name, value] of wire) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || UNTRUSTED.test(lower)) continue;
    headers.append(lower, value);
  }
  headers.set(RELAY_HEADER, relaySecret);
  return headers;
}

/** Response headers for the relay: hop-by-hop and cookies dropped. */
export function forwardResponseHeaders(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') return;
    out.push([lower, value]);
  });
  return out;
}
