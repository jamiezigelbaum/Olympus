/**
 * RFC 7591 registration at the relay, for ChatGPT only.
 *
 * Every engine pins ChatGPT's OAuth clients by their client metadata document
 * URLs (src/workers/remote-oauth/pinned-clients.ts), and ChatGPT normally
 * names one of them itself (CIMD). Some OpenAI hosts register instead: the
 * plugin portal's Connect does not complete without a client it registered
 * (2026-10-11). Registration here creates nothing. It tells the caller the
 * pinned client whose return address it registered:
 *
 * - `https://chatgpt.com/connector_platform_oauth_redirect` →
 *   `https://chatgpt.com/oauth/client.json`;
 * - `https://chatgpt.com/connector/oauth/<callback id>` →
 *   `https://chatgpt.com/oauth/<callback id>/client.json`.
 *
 * Any other return address is refused, so a registration never lets a code
 * go anywhere but ChatGPT, and the client it names is one anyone could
 * already use by its URL. No state is kept, so a registration names no
 * install and needs no routing; the per-address request limit applies.
 */

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const STABLE_REDIRECT = `${CHATGPT_ORIGIN}/connector_platform_oauth_redirect`;
const STABLE_CLIENT_ID = `${CHATGPT_ORIGIN}/oauth/client.json`;
// Same callback id shape as the engine's pinned-clients.ts.
const CALLBACK_REDIRECT = /^https:\/\/chatgpt\.com\/connector\/oauth\/([A-Za-z0-9_-]{1,128})$/;

/** A ChatGPT registration is a few hundred bytes. */
export const MAX_REGISTRATION_BYTES = 16 * 1024;

/** The pinned ChatGPT client for one return address, or undefined. */
export function chatGptClientForRedirect(redirectUri: string): string | undefined {
  if (redirectUri === STABLE_REDIRECT) return STABLE_CLIENT_ID;
  const callback = CALLBACK_REDIRECT.exec(redirectUri)?.[1];
  return callback ? `${CHATGPT_ORIGIN}/oauth/${callback}/client.json` : undefined;
}

export type RegistrationOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: 'invalid_client_metadata' | 'invalid_redirect_uri'; description: string };

const refuse = (error: 'invalid_client_metadata' | 'invalid_redirect_uri', description: string): RegistrationOutcome =>
  ({ ok: false, error, description });

/** Answers one registration body (already read and size-checked). */
export function registerChatGptClient(text: string, nowSeconds: number): RegistrationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('invalid_client_metadata', 'Registration is not JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('invalid_client_metadata', 'Registration must be a JSON object.');
  }
  const metadata = parsed as Record<string, unknown>;
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10
    || !redirectUris.every((uri) => typeof uri === 'string')) {
    return refuse('invalid_redirect_uri', 'redirect_uris must list the client\'s return addresses.');
  }
  // Engines pin each client to exactly its own return address, so every
  // address registered must belong to one and the same pinned client.
  const clients = new Set((redirectUris as string[]).map(chatGptClientForRedirect));
  const [clientId] = [...clients];
  if (clients.size !== 1 || clientId === undefined) {
    return refuse('invalid_redirect_uri', 'Only ChatGPT registers here, with one ChatGPT return address.');
  }
  const grantTypes = metadata.grant_types;
  if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))) {
    return refuse('invalid_client_metadata', 'Olympus issues authorization_code grants.');
  }
  // Public clients only: whatever method was asked for, the answer is `none`
  // and no secret is issued (RFC 7591 section 3.2.1 lets the server choose).
  return {
    ok: true,
    body: {
      client_id: clientId,
      client_id_issued_at: nowSeconds,
      client_name: 'ChatGPT',
      redirect_uris: [...new Set(redirectUris as string[])],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  };
}
