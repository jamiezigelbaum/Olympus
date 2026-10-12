/**
 * RFC 7591 registration at the relay, for the pinned hosted agents only:
 * ChatGPT, Claude and Grok.
 *
 * Every engine pins these clients by their client metadata document URLs
 * (src/workers/remote-oauth/pinned-clients.ts), and each normally names its
 * own (CIMD). Some hosts register instead: the OpenAI plugin portal's Connect
 * does not complete without a client it registered (2026-10-11), Grok's
 * connectors register (server logs, Aug-Sep 2026), and Claude registers when
 * the metadata leaves out CIMD (the operator switch, oauth-metadata.ts).
 * Registration here creates nothing. It tells the caller the pinned client
 * whose return address it registered:
 *
 * - `https://chatgpt.com/connector_platform_oauth_redirect` →
 *   `https://chatgpt.com/oauth/client.json`;
 * - `https://chatgpt.com/connector/oauth/<callback id>` →
 *   `https://chatgpt.com/oauth/<callback id>/client.json`;
 * - `https://claude.ai/api/mcp/auth_callback` →
 *   `https://claude.ai/oauth/mcp-oauth-client-metadata`;
 * - `https://grok.com/connectors-oauth-exchange-code/` or
 *   `https://console.x.ai/connectors-oauth-exchange-code/` →
 *   `https://grok.com/oauth/mcp-client.json`.
 *
 * Any other return address is refused, so a registration never lets a code
 * go anywhere but one of those apps, and the client it names is one anyone
 * could already use by its URL. The client's identity comes from its return
 * addresses, never from the `client_name` it sent. No state is kept, so a
 * registration names no install and needs no routing; the per-address
 * request limit applies.
 */

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const STABLE_REDIRECT = `${CHATGPT_ORIGIN}/connector_platform_oauth_redirect`;
const STABLE_CLIENT_ID = `${CHATGPT_ORIGIN}/oauth/client.json`;
// Same callback id shape as the engine's pinned-clients.ts.
const CALLBACK_REDIRECT = /^https:\/\/chatgpt\.com\/connector\/oauth\/([A-Za-z0-9_-]{1,128})$/;
// The same ids and return addresses as the engine's pinned-clients.ts
// (test/remote-oauth.test.ts holds the two equal).
const CLAUDE = { clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', clientName: 'Claude' } as const;
const GROK = { clientId: 'https://grok.com/oauth/mcp-client.json', clientName: 'Grok' } as const;
const EXACT_REDIRECTS: ReadonlyMap<string, PinnedRegistration> = new Map([
  [STABLE_REDIRECT, { clientId: STABLE_CLIENT_ID, clientName: 'ChatGPT' }],
  ['https://claude.ai/api/mcp/auth_callback', CLAUDE],
  ['https://grok.com/connectors-oauth-exchange-code/', GROK],
  ['https://console.x.ai/connectors-oauth-exchange-code/', GROK],
]);

export interface PinnedRegistration {
  readonly clientId: string;
  readonly clientName: string;
}

/** The pinned client one return address belongs to, or undefined. */
export function pinnedClientForRedirect(redirectUri: string): PinnedRegistration | undefined {
  const exact = EXACT_REDIRECTS.get(redirectUri);
  if (exact) return exact;
  const callback = CALLBACK_REDIRECT.exec(redirectUri)?.[1];
  // `codex` names the desktop client, pinned to loopback callbacks instead.
  return callback && callback !== 'codex' ? { clientId: `${CHATGPT_ORIGIN}/oauth/${callback}/client.json`, clientName: 'ChatGPT' } : undefined;
}

/** A registration is a few hundred bytes. */
export const MAX_REGISTRATION_BYTES = 16 * 1024;

export type RegistrationOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: 'invalid_client_metadata' | 'invalid_redirect_uri'; description: string };

const refuse = (error: 'invalid_client_metadata' | 'invalid_redirect_uri', description: string): RegistrationOutcome =>
  ({ ok: false, error, description });

/** Answers one registration body (already read and size-checked). */
export function registerPinnedClient(text: string, nowSeconds: number): RegistrationOutcome {
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
  const clients = (redirectUris as string[]).map(pinnedClientForRedirect);
  const [client] = clients;
  if (client === undefined || !clients.every((each) => each?.clientId === client.clientId)) {
    return refuse('invalid_redirect_uri', 'Only ChatGPT, Claude and Grok register here, each with its own return addresses.');
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
      client_id: client.clientId,
      client_id_issued_at: nowSeconds,
      client_name: client.clientName,
      redirect_uris: [...new Set(redirectUris as string[])],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  };
}
