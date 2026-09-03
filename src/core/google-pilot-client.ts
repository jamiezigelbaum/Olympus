/**
 * Public Google Desktop OAuth client identity for the shared-OAuth path.
 * Google documents installed applications as public clients and the token
 * exchange accepts client_id + PKCE without a client_secret, so this id is
 * non-confidential by design.
 *
 * Two ways it reaches a runtime, in this order:
 *
 * 1. The release builder replaces `PACKAGED_GOOGLE_PILOT_CLIENT_ID` in staged
 *    bundle bytes from `OLYMPUS_GOOGLE_PILOT_CLIENT_ID`, which release builds
 *    still require.
 * 2. `DEFAULT_GOOGLE_PILOT_CLIENT_ID` below, which ships in source. A
 *    repository install has no release substitution, so without a real default
 *    every repo-installed pilot is forced onto the advanced BYO-OAuth path —
 *    the opposite of the v0.4 shared-OAuth decision.
 *
 * The default is empty until the publisher mints (or hands over) the shared
 * Desktop client. Fill in the literal below — nothing else needs to change.
 * An empty default keeps today's behaviour: fail closed to BYO OAuth.
 */
export const DEFAULT_GOOGLE_PILOT_CLIENT_ID = '';

export const PACKAGED_GOOGLE_PILOT_CLIENT_ID = '__OLYMPUS_GOOGLE_PILOT_CLIENT_ID__';

const GOOGLE_PILOT_CLIENT_ID_SENTINEL = '__OLYMPUS_GOOGLE_PILOT_CLIENT_ID__';

/**
 * Split out from the module constants so the resolution order itself is
 * testable: the constants are compile-time literals a test cannot rebind.
 */
export function resolveGooglePilotClientId(
  packaged: string,
  shipped: string,
): string | undefined {
  const substituted = packaged.trim();
  if (substituted !== '' && substituted !== GOOGLE_PILOT_CLIENT_ID_SENTINEL) return substituted;
  const fallback = shipped.trim();
  return fallback === '' ? undefined : fallback;
}

export function packagedGooglePilotClientId(): string | undefined {
  return resolveGooglePilotClientId(PACKAGED_GOOGLE_PILOT_CLIENT_ID, DEFAULT_GOOGLE_PILOT_CLIENT_ID);
}
