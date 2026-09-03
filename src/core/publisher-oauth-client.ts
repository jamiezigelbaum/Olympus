/**
 * The publisher-owned OAuth client identifiers Olympus ships.
 *
 * These are **public identifiers**, not secrets. A Dropbox app key and a Google
 * client id are handed to every browser that reaches a consent screen, sent
 * again as the `client_id` parameter in the token-exchange request body (the
 * normal shape for a PKCE public client), and persisted locally in the
 * worker's own secret store next to the resulting refresh token — none of
 * which requires confidentiality, because none of it authenticates anything
 * on its own. The confidential half (a Dropbox app secret, a Google web
 * client secret) is never shipped and never lives here: Dropbox with PKCE
 * needs no client secret at that same token endpoint at all, and Google's
 * web-client secret is solved separately by a publisher-side exchange
 * endpoint (see `docs/ops/OAUTH_RELAY.md`).
 *
 * Dropbox ships filled in: the owner created the "Olympus-Plugin" app
 * 2026-09-03 (docs/ops/OAUTH_RELAY.md has the full story). Google ships
 * filled in too: the owner created the "Olympus Publisher" Web-application
 * client, also 2026-09-03, with its token exchange handled by the publisher
 * endpoint at `googlePublisherExchangeUrl()` in `core/oauth-relay.ts` (see
 * `docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`) rather than by a secret shipped
 * here. An empty default (were one ever needed again, e.g. a future rotation
 * mid-flight) fails closed to bring-your-own: the connect card shows the
 * owner's own walkthrough exactly as it does today, and no publisher flow is
 * offered. Fill the literal in (or set the environment variable) and nothing
 * else changes.
 */

/**
 * The Dropbox app key for the publisher-owned Dropbox app ("Olympus-Plugin",
 * created by the owner 2026-09-03). A Dropbox app key is a public OAuth client
 * identifier, not a secret: it goes out at authorization, again as `client_id`
 * in the token-exchange body, and into the local secret store — Dropbox's
 * PKCE flow just never asks for the app's CLIENT SECRET at that endpoint, and
 * that secret is what stays out of this repository. Shipping the app key in
 * source is therefore the intended shape, the same way the packaged Google
 * pilot client id ships in `google-pilot-client.ts`.
 *
 * Both redirect URIs are registered on the app: the relay
 * (`https://auth.olympusplugin.ai/oauth/callback/`) and the loopback fallback
 * (`http://127.0.0.1/oauth/callback/dropbox`).
 */
export const DEFAULT_DROPBOX_PUBLISHER_APP_KEY = '1y1l05nqd24xaaw';

/**
 * The Google **Web application** client id for the relay flow ("Olympus
 * Publisher", created by the owner 2026-09-03). A Web-application client id is
 * a public identifier — it goes out at authorization, again as `client_id` in
 * the token-exchange request the publisher-side exchange endpoint builds, and
 * into the local secret store — the same shape every other publisher client id
 * in this file ships in.
 *
 * Distinct from the Desktop pilot client in `google-pilot-client.ts`: a Desktop
 * client cannot register an https redirect URI, so a dashboard reached on
 * anything but loopback needs a web client. A Google Web-application client
 * must send `client_secret` at the token endpoint, which is not shipped here —
 * that leg goes through the publisher-side token-exchange endpoint instead
 * (`googlePublisherExchangeUrl()` in `core/oauth-relay.ts`;
 * `docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`). The one redirect URI registered on
 * this client is the relay (`https://auth.olympusplugin.ai/oauth/callback/`).
 */
export const DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID =
  '1027907846009-a9cbup55bplsuu2ibk4rasfl6auerdh4.apps.googleusercontent.com';

/**
 * Every Google Web-application client id Olympus has ever shipped as its
 * publisher client, newest first.
 *
 * **Append-only.** A rotation adds the new id at the front and never removes
 * an old one, because this list is what a credential connected under a
 * PREVIOUS publisher client is recognised by. That recognition is load-bearing
 * in exactly one place that cannot be re-derived later: a Google web client's
 * token exchange and refresh only work through the publisher exchange endpoint
 * (the secret Google demands lives there and nowhere else), so an install
 * whose stored client id stopped matching `DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID`
 * would otherwise fall back to a direct, secretless Google call, be refused,
 * and latch the handle into `reauth_required` — ingestion stops for a rotation
 * the user never made and cannot see. `exchangeVia` on the stored credential
 * is the durable fix; this list is what identifies the credentials written
 * before that field existed, and what the one-time migration keys off.
 */
export const GOOGLE_PUBLISHER_WEB_CLIENT_IDS: readonly string[] = [
  DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID,
];

/**
 * Whether a client id is one of Olympus's own publisher web clients — the
 * CURRENT one, this install's environment override, or any historical one.
 *
 * Deliberately wider than `clientId === googlePublisherWebClientId()`: that
 * comparison answers "is this the id a NEW flow would use", which is the wrong
 * question for a credential that was connected months ago.
 */
export function isGooglePublisherWebClientId(
  clientId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const candidate = clientId?.trim();
  if (!candidate) return false;
  const override = env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID?.trim();
  if (override && candidate === override) return true;
  return GOOGLE_PUBLISHER_WEB_CLIENT_IDS.some((known) => known.trim() !== '' && known.trim() === candidate);
}

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
