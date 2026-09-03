/**
 * The `redirect_uri` allowlist this endpoint accepts.
 *
 * Google's token endpoint independently enforces that `redirect_uri` matches
 * the authorization request exactly, so this allowlist is not the only thing
 * standing between an attacker and a token — but a caller who can reach this
 * endpoint at all should not be able to make it forward to an arbitrary
 * string on Google's behalf, so the shape is checked here too, cheaply,
 * before anything is sent upstream.
 *
 * Two forms are accepted:
 *
 * 1. An exact match against one of the configured relay URLs (normally just
 *    the one production relay, `https://auth.olympusplugin.ai/oauth/callback/`
 *    — see docs/ops/OAUTH_RELAY.md).
 * 2. A loopback `http://` redirect (`127.0.0.1`, `localhost`, `[::1]`, any
 *    port, any path), mirroring the relay page's own origin rules.
 *
 * Form 2 is defense in depth, not an expected code path: in Olympus's current
 * worker design (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md, "Why the worker never
 * sends a loopback redirect_uri here") a loopback dashboard uses the Desktop
 * pilot client directly against Google and never reaches this endpoint at
 * all. It is accepted anyway so that a future change to that routing does not
 * also require touching this allowlist, and so that this endpoint's own rules
 * do not silently diverge from the relay's.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

export function isAllowedRedirectUri(uri: string, allowedExact: readonly string[]): boolean {
  if (allowedExact.includes(uri)) return true;
  return isLoopbackRedirectUri(uri);
}

/** Parses the `ALLOWED_REDIRECT_URIS` worker var: comma-separated, trimmed, non-empty entries. */
export function parseAllowedRedirectUris(configured: string | undefined, fallback: readonly string[]): string[] {
  const trimmed = configured?.trim();
  if (!trimmed) return [...fallback];
  const entries = trimmed.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : [...fallback];
}
