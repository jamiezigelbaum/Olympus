/**
 * Redirect URI rules for remote-agent OAuth clients.
 *
 * MCP authorization: every redirect URI is https or a loopback address. The
 * authorization server matches the requested URI exactly against the client's
 * registered list, with one allowance from RFC 8252 section 7.3: a loopback
 * redirect matches on any port, because native clients (Claude Code) bind an
 * ephemeral port at run time. Claude Code registers `http://localhost/...`
 * as well as `http://127.0.0.1/...`, so `localhost` gets the same allowance.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);
const MAX_REDIRECT_URI_LENGTH = 2048;

export function isAcceptableRedirectUri(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  if (value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
}

export function isLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Exact match, or a loopback match that ignores only the port. */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (!isAcceptableRedirectUri(requested)) return false;
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirectUri(requested)) return false;
  const want = new URL(requested);
  return registered.some((candidate) => {
    if (!isLoopbackRedirectUri(candidate)) return false;
    const have = new URL(candidate);
    return have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
  });
}

/** What the consent page shows as "sends you back to". */
export function redirectHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
