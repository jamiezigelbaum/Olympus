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
 * The Dropbox default below is filled in; the Google one stays EMPTY until the
 * owner creates that app too. An empty default fails closed to bring-your-own:
 * the connect card shows the owner's own walkthrough exactly as it does today,
 * and no publisher flow is offered. Fill the literal in (or set the
 * environment variable) and nothing else changes.
 */

/**
 * The Dropbox app key for the publisher-owned Dropbox app ("Olympus-Plugin",
 * created by the owner 2026-09-03). A Dropbox app key is a public OAuth client
 * identifier, not a secret — Dropbox with PKCE never sends one to the token
 * endpoint at all — so shipping it in source is the intended shape, the same
 * way the packaged Google pilot client id ships in `google-pilot-client.ts`.
 *
 * Both redirect URIs are registered on the app: the relay
 * (`https://auth.olympusplugin.ai/oauth/callback/`) and the loopback fallback
 * (`http://127.0.0.1/oauth/callback/dropbox`).
 */
export const DEFAULT_DROPBOX_PUBLISHER_APP_KEY = '1y1l05nqd24xaaw';

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
