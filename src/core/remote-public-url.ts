/**
 * The public address hosted agents use to reach this install's worker.
 *
 * OAuth for remote agents is on only when the owner (or, later, the relay
 * client) configures `OLYMPUS_PUBLIC_BASE_URL` in the worker's environment.
 * The issuer, the protected resource and every metadata URL come from this
 * value and nothing else: never from a request's Host, Origin or forwarding
 * headers, which a caller controls. With no value configured, OAuth is off and
 * the bearer connections from `olympus connections add` keep working.
 */
export const REMOTE_PUBLIC_BASE_URL_ENV = 'OLYMPUS_PUBLIC_BASE_URL';
export const REMOTE_MCP_RESOURCE_PATH = '/mcp';

export interface RemotePublicUrls {
  /** `https://host[:port]`, no trailing slash. Also the OAuth issuer. */
  origin: string;
  /** Lowercased host[:port], as it appears in a Host header. */
  host: string;
  issuer: string;
  /** The protected resource (RFC 8707 / RFC 9728): `<origin>/mcp`. */
  resource: string;
  protectedResourceMetadataUrl: string;
  secure: boolean;
}

/**
 * The public URLs as a value fixed at start, or a function asked per request
 * (the worker's live source, which follows the relay; see
 * core/remote-access.ts). Either way they never come from the request.
 */
export type RemotePublicUrlsSource = RemotePublicUrls | undefined | (() => RemotePublicUrls | undefined);

export function currentRemotePublicUrls(source: RemotePublicUrlsSource): RemotePublicUrls | undefined {
  return typeof source === 'function' ? source() : source;
}

export type RemotePublicUrlResolution =
  | { enabled: true; urls: RemotePublicUrls }
  | { enabled: false; reason: 'not_configured' | 'invalid'; detail?: string };

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Parses the configured base URL. HTTPS only, except plain HTTP on a loopback
 * host for local development and tests. The value must be an origin: a path,
 * query, fragment or credentials would make the issuer ambiguous.
 */
export function parseRemotePublicBaseUrl(value: string | undefined): RemotePublicUrlResolution {
  const raw = value?.trim();
  if (!raw) return { enabled: false, reason: 'not_configured' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { enabled: false, reason: 'invalid', detail: `${REMOTE_PUBLIC_BASE_URL_ENV} is not a URL.` };
  }
  if (url.username || url.password) {
    return { enabled: false, reason: 'invalid', detail: `${REMOTE_PUBLIC_BASE_URL_ENV} must not carry credentials.` };
  }
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return { enabled: false, reason: 'invalid', detail: `${REMOTE_PUBLIC_BASE_URL_ENV} must not have a query or fragment.` };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { enabled: false, reason: 'invalid', detail: `${REMOTE_PUBLIC_BASE_URL_ENV} must be an origin such as https://example.com, with no path.` };
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))) {
    return { enabled: false, reason: 'invalid', detail: `${REMOTE_PUBLIC_BASE_URL_ENV} must use https (plain http is allowed only on a loopback host).` };
  }
  const origin = url.origin;
  return {
    enabled: true,
    urls: {
      origin,
      host: url.host.toLowerCase(),
      issuer: origin,
      resource: `${origin}${REMOTE_MCP_RESOURCE_PATH}`,
      protectedResourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${REMOTE_MCP_RESOURCE_PATH}`,
      secure,
    },
  };
}

export function resolveRemotePublicUrls(
  env: Record<string, string | undefined> = process.env,
): RemotePublicUrlResolution {
  return parseRemotePublicBaseUrl(env[REMOTE_PUBLIC_BASE_URL_ENV]);
}

/**
 * RFC 8707 resource comparison. Scheme and host compare case-insensitively
 * (URL parsing lowercases them and drops a default port); a single trailing
 * slash is ignored; anything else must match the configured resource exactly.
 */
export function isConfiguredResource(value: string, urls: RemotePublicUrls): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || value.includes('#')) return false;
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/$/, '') : parsed.pathname;
  return `${parsed.origin}${path}` === urls.resource;
}
