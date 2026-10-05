/**
 * What an install may put on the relay's public origin.
 *
 * Every install answer is served from `https://<relay>`, the origin the
 * ChatGPT dashboard links to and the panel's dedicated domain. Any install
 * can register itself, so an install's answer is treated as untrusted
 * content: it may never run script on the relay origin, never be sniffed into
 * something else, and never redirect a person's browser anywhere but where
 * the route legitimately goes. Per route kind:
 *
 * - `api` (`/mcp`, `/connect/token`, `/connect/revoke`, `/private/…`): JSON,
 *   event streams or plain text; no redirects.
 * - `browser` (`/go/…` hand-offs and `/oauth/callback/…` provider returns):
 *   HTML, plain text or JSON (the install client's own error answers); a
 *   redirect only to the provider sign-ins the engine starts (Google,
 *   Dropbox), the engine's loopback port, or the relay itself.
 * - `demo` (`/connect/demo/authorize`, routed only to the operator's demo
 *   install): the reviewer sign-in form, redirecting back to ChatGPT.
 *
 * Every install answer gets `X-Content-Type-Options: nosniff`,
 * `Referrer-Policy: no-referrer` and the relay's own Content-Security-Policy
 * in addition to the install's (browsers enforce both). `api` and `browser`
 * answers are sandboxed with no script and an opaque origin; the demo form
 * keeps its origin (the engine checks it, and its consent cookie is
 * SameSite=Strict) and may submit, but runs no script.
 *
 * Header names and values are validated here, before anything is sent to the
 * caller: a value the platform would refuse fails the stream with a 502
 * instead of leaving the request waiting.
 */
import { AUTHENTICATED_RESPONSE_HEADER } from '../shared/tokens.ts';

export type RouteKind = 'api' | 'browser' | 'demo';

export interface ResponsePolicy {
  readonly kind: RouteKind;
  /** Media types (lowercase, no parameters) the route may serve. */
  readonly contentTypes: ReadonlySet<string>;
  /** Origin that relative `Location` values resolve against (the relay's). */
  readonly baseOrigin: string;
  /** Whether a redirect may send the browser to `target`. */
  redirectAllowed(target: URL): boolean;
  /** The relay's policy, sent beside the install's own. */
  readonly csp: string;
}

/** Response headers an install may set on the public response; everything else is dropped. */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'cache-control',
  'pragma',
  'mcp-session-id',
  'www-authenticate',
  'retry-after',
  'allow',
  // Redirects, checked against the route's targets below.
  'location',
  // The install's own page policy; the relay adds its own beside it.
  'content-security-policy',
  'x-frame-options',
  'cross-origin-opener-policy',
]);

/** Set by the relay on every install answer, whatever the install sent. */
const RELAY_SET_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;

const SANDBOXED_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DEMO_CSP = "sandbox allow-forms allow-same-origin; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);
/** RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
/** Visible ASCII, space, tab and obs-text; never CR, LF or NUL. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Provider sign-in origins the engine's hand-offs redirect to (core/connect.ts authUrl). */
export const PROVIDER_AUTHORIZE_ORIGINS: readonly string[] = ['https://accounts.google.com', 'https://www.dropbox.com'];

export function createResponsePolicies(input: { relayOrigin: string; enginePort: number }): Record<RouteKind, ResponsePolicy> {
  const relayOrigin = new URL(input.relayOrigin).origin;
  const engineOrigin = `http://127.0.0.1:${input.enginePort}`;
  const browserTargets = new Set([...PROVIDER_AUTHORIZE_ORIGINS, engineOrigin, relayOrigin]);
  const text = ['text/html', 'text/plain', 'application/json'];
  return {
    api: {
      kind: 'api',
      contentTypes: new Set(['application/json', 'text/event-stream', 'text/plain']),
      baseOrigin: relayOrigin,
      redirectAllowed: () => false,
      csp: SANDBOXED_CSP,
    },
    browser: {
      kind: 'browser',
      contentTypes: new Set(text),
      baseOrigin: relayOrigin,
      redirectAllowed: (target) => browserTargets.has(target.origin),
      csp: SANDBOXED_CSP,
    },
    demo: {
      kind: 'demo',
      contentTypes: new Set(text),
      baseOrigin: relayOrigin,
      // ChatGPT's redirect URIs (web, and the desktop app's loopback ones), or the relay.
      redirectAllowed: (target) => target.origin === 'https://chatgpt.com'
        || target.origin === relayOrigin
        || (target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname)),
      csp: DEMO_CSP,
    },
  };
}

/** Used when a caller names no policy (direct session tests): API answers, no redirects. */
export const DEFAULT_RESPONSE_POLICY: ResponsePolicy = createResponsePolicies({ relayOrigin: 'https://relay.invalid', enginePort: 8010 }).api;

export type ResponseHeadCheck =
  | { ok: true; headers: Headers; authenticated: boolean }
  | { ok: false; reason: 'invalid_header' | 'content_type' | 'redirect' };

/**
 * The public response head for an install's `response-head`, or why it is
 * refused. Reasons are fixed codes: nothing the install sent is echoed.
 */
export function checkResponseHead(
  policy: ResponsePolicy,
  status: number,
  wireHeaders: ReadonlyArray<readonly [string, string]>,
  bodyless: boolean,
): ResponseHeadCheck {
  let authenticated = false;
  const kept: Array<[string, string]> = [];
  for (const [name, value] of wireHeaders) {
    if (name === AUTHENTICATED_RESPONSE_HEADER) {
      authenticated = value === '1';
      continue;
    }
    if (!RESPONSE_HEADER_ALLOWLIST.has(name)) continue;
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) return { ok: false, reason: 'invalid_header' };
    kept.push([name, value]);
  }

  const contentTypes = kept.filter(([name]) => name === 'content-type');
  if (contentTypes.length > 1) return { ok: false, reason: 'content_type' };
  if (contentTypes.length === 1) {
    const media = contentTypes[0]![1].split(';')[0]!.trim().toLowerCase();
    if (!policy.contentTypes.has(media)) return { ok: false, reason: 'content_type' };
  }

  const locations = kept.filter(([name]) => name === 'location');
  if (REDIRECT_STATUSES.has(status)) {
    if (locations.length !== 1) return { ok: false, reason: 'redirect' };
    let target: URL;
    try {
      target = new URL(locations[0]![1], policy.baseOrigin);
    } catch {
      return { ok: false, reason: 'redirect' };
    }
    if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password || !policy.redirectAllowed(target)) {
      return { ok: false, reason: 'redirect' };
    }
  }

  const headers = new Headers();
  try {
    for (const [name, value] of kept) {
      // A Location only ever accompanies a checked redirect.
      if (name === 'location' && !REDIRECT_STATUSES.has(status)) continue;
      headers.append(name, value);
    }
    if (contentTypes.length === 0 && !bodyless) headers.set('content-type', 'text/plain; charset=utf-8');
    for (const [name, value] of Object.entries(RELAY_SET_HEADERS)) headers.set(name, value);
    headers.append('content-security-policy', policy.csp);
  } catch {
    return { ok: false, reason: 'invalid_header' };
  }
  return { ok: true, headers, authenticated };
}

export { BODYLESS_STATUSES };
