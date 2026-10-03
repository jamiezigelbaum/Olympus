/**
 * Public Google Desktop OAuth client identity for legacy or explicitly
 * configured direct OAuth paths.
 * Google documents installed applications as public clients and the token
 * exchange accepts client_id + PKCE without a client_secret, so this id is
 * non-confidential by design.
 *
 * Two ways it reaches a runtime, in this order:
 *
 * 1. The release builder replaces this module in staged bundles from
 *    `OLYMPUS_GOOGLE_PILOT_CLIENT_ID`, which a release build must set: to a
 *    Desktop client id, or to `none` for no Desktop client, since every
 *    host's Gmail and Drive connect uses the publisher Web client and relay
 *    (`scripts/release-google-pilot-choice.ts`). Unset, it packages the
 *    source default below — the Olympus 1.0 choice (owner, 2026-10-03).
 * 2. `DEFAULT_GOOGLE_PILOT_CLIENT_ID` below, which ships in source. A
 *    repository install has no release substitution, so without a real default
 *    every repo-installed direct pilot path is forced onto BYO OAuth.
 *
 * The default is the publisher-owned Desktop client that 0.4.0-beta.11
 * packaged, so installs that connected through it keep publisher recognition.
 * New publisher dashboard flows do not use this identity; they use the Google
 * Web client, signed relay, and publisher exchange for every dashboard origin.
 * An empty id (a `none` build) keeps direct pilot behavior fail-closed to BYO OAuth.
 */
export const DEFAULT_GOOGLE_PILOT_CLIENT_ID: string = '604346037984-oukrdn4ouh8n2fctggracadt0fdd2lps.apps.googleusercontent.com';

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
