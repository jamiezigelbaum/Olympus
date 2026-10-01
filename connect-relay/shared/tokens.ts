/**
 * The routable credential grammar shared by the relay (which routes on it) and
 * the engine (which mints and verifies it). Every credential names the install
 * that minted it, so the relay can route a request without storing anything:
 *
 *   access token         oly2.<installId>.<secret>
 *   refresh token        oly2r.<installId>.<secret>
 *   authorization code   oly2c.<installId>.<secret>
 *   one-time hand-off    oly2g.<installId>.<secret>   (`/go/<id>`, see below)
 *
 * A hand-off id is the path of a one-time link the engine gives the ChatGPT
 * dashboard (`https://<relay>/go/<id>`): opened in any browser, the relay
 * routes it to the install that minted it, and that engine answers with the
 * page or redirect it stored for the id (a provider sign-in, the Mac-only key
 * page). Single use and ten minutes, enforced by the engine.
 *
 *   private-answer job   oly2p.<installId>.<secret>   (`/private/<id>`, see below)
 *
 * A private-answer job id names one answer the ChatGPT private-answer panel
 * may collect, once, directly from `https://<relay>/private/<id>`: the relay
 * routes it to the install that minted it, and only that engine knows the
 * job (single use, ten minutes; src/workers/chatgpt/private-answer-jobs.ts).
 * The answer itself is end-to-end sealed to a key the panel generates, so the
 * relay forwards ciphertext only (docs/design/chatgpt-plugin.md, "Private
 * answer panel").
 *
 * `<secret>` is 32 random bytes, base64url (43 characters). The relay never
 * validates the secret; the engine does, against its own database, so a token
 * minted by install B and presented to install A opens nothing at A.
 */
import { randomBytes } from 'node:crypto';

/**
 * Set by the engine on a response to a request whose credential it verified.
 * The relay uses it only to decide which admission lane a credential's later
 * requests take (server/relay.ts); it is never an authorization and never
 * leaves the relay. An install that forges it changes only its own lane.
 */
export const AUTHENTICATED_RESPONSE_HEADER = 'x-olympus-authenticated';

export type CredentialKind = 'access' | 'refresh' | 'code' | 'handoff' | 'private';

const PREFIX: Record<CredentialKind, string> = { access: 'oly2', refresh: 'oly2r', code: 'oly2c', handoff: 'oly2g', private: 'oly2p' };
const SECRET = '[A-Za-z0-9_-]{43}';
const INSTALL = '[a-z2-7]{32}';
const PATTERN: Record<CredentialKind, RegExp> = {
  access: new RegExp(`^oly2\\.(${INSTALL})\\.${SECRET}$`),
  refresh: new RegExp(`^oly2r\\.(${INSTALL})\\.${SECRET}$`),
  code: new RegExp(`^oly2c\\.(${INSTALL})\\.${SECRET}$`),
  handoff: new RegExp(`^oly2g\\.(${INSTALL})\\.${SECRET}$`),
  private: new RegExp(`^oly2p\\.(${INSTALL})\\.${SECRET}$`),
};

/** The relay path prefix of a hand-off link. */
export const HANDOFF_PATH_PREFIX = '/go/';

/**
 * The install a provider sign-in's bounced callback belongs to, when the
 * engine started it for ChatGPT: its signed `state` names a nonce of the form
 * `<installId>_<random>` (src/core/oauth-relay.ts). The relay reads only that
 * prefix to route; the engine verifies the signature, nonce and origin.
 */
export function oauthHandbackInstallId(state: string | null | undefined): string | undefined {
  if (typeof state !== 'string' || state.length > 2048) return undefined;
  const dot = state.indexOf('.');
  if (dot <= 0 || !/^[A-Za-z0-9_-]+$/.test(state.slice(0, dot))) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(state.slice(0, dot), 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const nonce = typeof payload === 'object' && payload !== null ? (payload as { nonce?: unknown }).nonce : undefined;
  return typeof nonce === 'string' ? new RegExp(`^(${INSTALL})_[A-Za-z0-9_-]{16,90}$`).exec(nonce)?.[1] : undefined;
}

/** The provider callback paths the relay hands back to an install (publisher OAuth apps only). */
export const OAUTH_HANDBACK_PATHS = ['/oauth/callback/gmail', '/oauth/callback/google-drive', '/oauth/callback/dropbox'] as const;

export function mintCredential(kind: CredentialKind, installId: string): string {
  return `${PREFIX[kind]}.${installId}.${randomBytes(32).toString('base64url')}`;
}

/** The install a well-formed credential of `kind` names, or undefined. */
export function credentialInstallId(kind: CredentialKind, value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  return PATTERN[kind].exec(value)?.[1];
}

export function isCredential(kind: CredentialKind, value: string): boolean {
  return credentialInstallId(kind, value) !== undefined;
}
