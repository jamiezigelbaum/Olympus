import { createHash } from 'node:crypto';

/**
 * Public Google Desktop OAuth client identity for explicitly configured direct
 * OAuth paths. Google documents installed applications as public clients and
 * the token exchange accepts client_id + PKCE without a client_secret, so an id
 * here is non-confidential by design.
 *
 * Two ways it reaches a runtime, in this order:
 *
 * 1. The release builder replaces this module in staged bundles from
 *    `OLYMPUS_GOOGLE_PILOT_CLIENT_ID`: a Desktop client id, or `none`
 *    (`scripts/release-google-pilot-choice.ts`). Unset, it packages the source
 *    default below.
 * 2. `DEFAULT_GOOGLE_PILOT_CLIENT_ID` below, which ships in source.
 *
 * The default is empty (#765, 2026-11-10): the Desktop client that
 * 0.4.0-beta.11 packaged lived in a Google Cloud project that was shut down on
 * 2026-11-03 and is deleted for good about 30 days later, so no build may ship
 * it. Every host's Gmail and Drive connect uses Olympus's publisher clients
 * instead (`publisher-oauth-client.ts`). An empty id keeps direct pilot
 * behavior on the publisher clients or the owner's own app.
 */
export const DEFAULT_GOOGLE_PILOT_CLIENT_ID: string = '';

/**
 * SHA-256 of the retired beta.11 Desktop client id. Only the hash ships, so no
 * build carries the dead id, yet an install whose Gmail or Drive connection
 * still names it is recognised as Olympus's own (not the owner's) app: its
 * card offers a one-click reconnect through the current publisher client
 * instead of a reconnect through a client Google has deleted.
 */
export const RETIRED_GOOGLE_PILOT_CLIENT_ID_SHA256: ReadonlySet<string> = new Set([
  'de8b8602a0b5d721f22bc9e72a5b193d4cc99577e03db034ff328c8e739d3fee',
]);

export function isRetiredGooglePilotClientId(clientId: string | undefined): boolean {
  const trimmed = clientId?.trim();
  if (!trimmed) return false;
  return RETIRED_GOOGLE_PILOT_CLIENT_ID_SHA256.has(createHash('sha256').update(trimmed).digest('hex'));
}

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
