/**
 * Public Google Desktop OAuth client identity for legacy or explicitly
 * configured direct OAuth paths.
 * Google documents installed applications as public clients and the token
 * exchange accepts client_id + PKCE without a client_secret, so this id is
 * non-confidential by design.
 *
 * Two ways it reaches a runtime, in this order:
 *
 * 1. The release builder defines a public client identity at compile time
 *    from `OLYMPUS_GOOGLE_PILOT_CLIENT_ID`, which release builds still require.
 * 2. `DEFAULT_GOOGLE_PILOT_CLIENT_ID` below, which ships in source. A
 *    repository install has no release substitution, so without a real default
 *    every repo-installed direct pilot path is forced onto BYO OAuth.
 *
 * The default is empty until the publisher mints (or hands over) the shared
 * Desktop client. Fill in the literal below — nothing else needs to change.
 * New publisher dashboard flows do not use this identity; they use the Google
 * Web client, signed relay, and publisher exchange for every dashboard origin.
 * An empty default keeps direct pilot behavior fail-closed to BYO OAuth.
 */
export const DEFAULT_GOOGLE_PILOT_CLIENT_ID = '';

declare const OLYMPUS_PACKAGED_GOOGLE_PILOT_CLIENT_ID: string;

export const PACKAGED_GOOGLE_PILOT_CLIENT_ID =
  typeof OLYMPUS_PACKAGED_GOOGLE_PILOT_CLIENT_ID === 'undefined'
    ? ''
    : OLYMPUS_PACKAGED_GOOGLE_PILOT_CLIENT_ID;

/**
 * Split out from the module constants so the resolution order itself is
 * testable: the constants are compile-time literals a test cannot rebind.
 */
export function resolveGooglePilotClientId(
  packaged: string,
  shipped: string,
): string | undefined {
  return packaged.trim() || shipped.trim() || undefined;
}

export function packagedGooglePilotClientId(): string | undefined {
  return resolveGooglePilotClientId(PACKAGED_GOOGLE_PILOT_CLIENT_ID, DEFAULT_GOOGLE_PILOT_CLIENT_ID);
}
