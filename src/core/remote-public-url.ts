/**
 * The public address hosted agents use to reach this install's worker.
 *
 * OAuth for remote agents is on only when a public base URL is configured:
 * the Olympus relay (`remote.relayHost`, reported through status.json with
 * this install's id), or a tunnel the owner runs (`OLYMPUS_PUBLIC_BASE_URL` in
 * worker.env, or `remote.publicBaseUrl`). The issuer, the protected resource
 * and every metadata URL come from this value and nothing else: never from a
 * request's Host, Origin or forwarding headers, which a caller controls. With
 * no value configured, OAuth is off and the bearer connections from
 * `olympus connections add` keep working.
 */
import { DIRECTORY_MCP_PATH, type McpSurface } from '../../connect-relay/shared/directory-tools.ts';

export const REMOTE_PUBLIC_BASE_URL_ENV = 'OLYMPUS_PUBLIC_BASE_URL';
export const REMOTE_MCP_RESOURCE_PATH = '/mcp';
/** The ChatGPT plugin directory's endpoint, its own protected resource (connect-relay/shared/directory-tools.ts). */
export const REMOTE_DIRECTORY_MCP_RESOURCE_PATH = DIRECTORY_MCP_PATH;

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
  /**
   * Set in relay mode: this install's relay id. Codes and tokens then carry it
   * (`oly2c.<id>.…`) so the relay can route them, consent is loopback-only,
   * and ChatGPT is the pinned client.
   */
  installId?: string;
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
export function parseRemotePublicBaseUrl(value: string | undefined, installId?: string): RemotePublicUrlResolution {
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
      ...(installId ? { installId } : {}),
    },
  };
}

export function resolveRemotePublicUrls(
  env: Record<string, string | undefined> = process.env,
): RemotePublicUrlResolution {
  return parseRemotePublicBaseUrl(env[REMOTE_PUBLIC_BASE_URL_ENV]);
}

/**
 * The protected resource of one MCP endpoint: `/mcp` (`urls.resource`) or
 * the plugin directory's `/openai/mcp`, derived from the same configured
 * origin. Each is its own audience: a token issued for one opens only it.
 */
export function remoteMcpResource(urls: RemotePublicUrls, surface: McpSurface): { resource: string; protectedResourceMetadataUrl: string } {
  if (surface === 'default') return { resource: urls.resource, protectedResourceMetadataUrl: urls.protectedResourceMetadataUrl };
  return {
    resource: `${urls.origin}${REMOTE_DIRECTORY_MCP_RESOURCE_PATH}`,
    protectedResourceMetadataUrl: `${urls.origin}/.well-known/oauth-protected-resource${REMOTE_DIRECTORY_MCP_RESOURCE_PATH}`,
  };
}

/** Every protected resource this install serves, `/mcp` first. */
export function configuredResources(urls: RemotePublicUrls): string[] {
  return [urls.resource, remoteMcpResource(urls, 'directory').resource];
}

/**
 * RFC 8707 resource comparison: the configured resource a requested value
 * names, or undefined. Scheme and host compare case-insensitively (URL
 * parsing lowercases them and drops a default port); a single trailing slash
 * is ignored; anything else must match a configured resource exactly.
 */
export function matchConfiguredResource(value: string, urls: RemotePublicUrls): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || value.includes('#')) return undefined;
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/$/, '') : parsed.pathname;
  const normalized = `${parsed.origin}${path}`;
  return configuredResources(urls).find((resource) => resource === normalized);
}

export function isConfiguredResource(value: string, urls: RemotePublicUrls): boolean {
  return matchConfiguredResource(value, urls) !== undefined;
}
