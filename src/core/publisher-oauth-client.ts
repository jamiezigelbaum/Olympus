/**
 * The publisher-owned OAuth client identifiers Olympus ships.
 *
 * These are **public identifiers**, not secrets. A Dropbox app key and a Google
 * client id are handed to every browser that reaches a consent screen; the
 * confidential half (a Dropbox app secret, a Google web client secret) is never
 * shipped and never lives here. Dropbox with PKCE needs no secret at the token
 * endpoint at all, and Google's web-client secret is solved separately by a
 * publisher-side exchange endpoint (see `docs/ops/OAUTH_RELAY.md`).
 *
 * Both defaults are EMPTY until the owner creates the apps. An empty default
 * fails closed to bring-your-own: the connect card shows the owner's own
 * walkthrough exactly as it does today, and no publisher flow is offered. Fill
 * the literal in (or set the environment variable) and nothing else changes.
 */

/**
 * The Dropbox app key for the publisher-owned Dropbox app.
 *
 * Owner step: create the app per the runbook in `docs/ops/OAUTH_RELAY.md`,
 * register `https://auth.olympusplugin.ai/oauth/callback/` as a redirect URI,
 * and paste the App key here.
 */
export const DEFAULT_DROPBOX_PUBLISHER_APP_KEY = '';

/**
 * The Google **Web application** client id for the relay flow.
 *
 * Distinct from the Desktop pilot client in `google-pilot-client.ts`: a Desktop
 * client cannot register an https redirect URI, so a dashboard reached on
 * anything but loopback needs a web client. Empty until the owner creates it,
 * and until the publisher-side token exchange exists — a Google web client must
 * send a client secret at the token endpoint, which is not shipped.
 */
export const DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID = '';

/** The publisher Dropbox app key, environment override first. */
export function dropboxPublisherAppKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return firstConfigured(env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY, DEFAULT_DROPBOX_PUBLISHER_APP_KEY);
}

/** The publisher Google web client id, environment override first. */
export function googlePublisherWebClientId(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return firstConfigured(env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID, DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID);
}

function firstConfigured(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
