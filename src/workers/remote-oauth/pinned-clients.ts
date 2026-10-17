/**
 * The OAuth clients Olympus recognizes by their client metadata document URL:
 * ChatGPT, Claude, Grok, and Grok Bot or Cursor.
 *
 * ChatGPT identifies itself with a Client ID Metadata Document: with an
 * authorization server that returns RFC 9207 `iss` (Olympus does), it uses
 * the stable `https://chatgpt.com/oauth/client.json` and returns to
 * `https://chatgpt.com/connector_platform_oauth_redirect`; otherwise a
 * callback-specific `https://chatgpt.com/oauth/<callback_id>/client.json`
 * returning to `https://chatgpt.com/connector/oauth/<callback_id>`
 * (developers.openai.com/plugins/build/auth, read 2026-10-01).
 *
 * Claude's custom connectors (claude.ai web, desktop and phone) use
 * `https://claude.ai/oauth/mcp-oauth-client-metadata`, returning to
 * `https://claude.ai/api/mcp/auth_callback` on every surface
 * (claude.com/docs/connectors/building/authentication; the document as
 * served, read 2026-10-12). Grok's connectors use
 * `https://grok.com/oauth/mcp-client.json`, returning to
 * `https://grok.com/connectors-oauth-exchange-code/` (or the xAI console's
 * same path for business admins), trailing slash included (the document as
 * served, read 2026-10-12). Both may register instead of naming the
 * document; the relay answers that registration with these same ids
 * (connect-relay/server/client-registration.ts).
 *
 * Grok Bot is Cursor's app (bundle com.anysphere.sand) and signs in to a
 * custom server as Cursor's cloud agents do: it registers as client_name
 * "Cursor" with `https://www.cursor.com/agents/mcp/oauth/callback` (plus
 * `http://localhost:8787/callback`; relay log, 2026-10-12), addresses
 * Cursor's document `https://cursor.com/oauth/mcp-client.json` publishes.
 * Cursor's own cloud agents use the same client and address, so the two
 * cannot be told apart: the owner approved admitting both, named "Grok Bot
 * or Cursor" (2026-10-12). The document's three cloud addresses are pinned:
 * `/agents/`, `/bot/`, and Grok's exchange page
 * `https://grok.com/connectors-oauth-exchange-code/` (the document as
 * served, read 2026-10-17). Its loopback ones are not: they would return the
 * code to whatever runs on port 8787.
 *
 * These are pinned here rather than fetched: Olympus never fetches a client
 * metadata document, so a stranger naming an arbitrary URL as client_id cannot
 * make the owner's Mac contact it (and reveal its address). Any other
 * metadata-URL client is refused.
 *
 * Being pinned is not being ChatGPT: only ChatGPT's clients get the ChatGPT
 * surface and the directory endpoint. Claude, Grok and Grok Bot or Cursor
 * get the remote operation surface on `/mcp` only.
 */
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
/** https://chatgpt.com/oauth/codex/client.json, read 2026-10-01. */
export const CHATGPT_CODEX_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';
const CHATGPT_CODEX_REDIRECT_URIS: readonly string[] = ['http://127.0.0.1/callback', 'http://localhost/callback'];
const CHATGPT_CALLBACK_CLIENT_ID =/^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{1,128})\/client\.json$/;
export const CLAUDE_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
export const GROK_CLIENT_ID = 'https://grok.com/oauth/mcp-client.json';
export const GROK_REDIRECT_URIS: readonly string[] = Object.freeze([
  'https://grok.com/connectors-oauth-exchange-code/',
  'https://console.x.ai/connectors-oauth-exchange-code/',
]);
export const CURSOR_CLIENT_ID = 'https://cursor.com/oauth/mcp-client.json';
export const CURSOR_REDIRECT_URI = 'https://www.cursor.com/agents/mcp/oauth/callback';
export const CURSOR_REDIRECT_URIS: readonly string[] = Object.freeze([
  CURSOR_REDIRECT_URI,
  'https://www.cursor.com/bot/mcp/oauth/callback',
  'https://grok.com/connectors-oauth-exchange-code/',
]);

/** Which hosted agent a pinned client belongs to. */
export type PinnedHost = 'chatgpt' | 'claude' | 'grok' | 'cursor';

export interface PinnedClient {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  /** The host that vouches for the client: the client_id URL's host. */
  verifiedHost: string;
  host: PinnedHost;
}

/** Whether a client_id is shaped like a metadata document URL. */
export function isClientIdMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/**
 * Whether a connection is an OAuth grant to a pinned ChatGPT client: only
 * those get the ChatGPT surface (setup tools, private answers). Claude and
 * Grok grants, bearer connections and self-registered clients keep the
 * operation surface.
 */
export function isChatGptGrant(connection: { clientId?: string | null }): boolean {
  return typeof connection.clientId === 'string' && pinnedClient(connection.clientId)?.host === 'chatgpt';
}

export function pinnedClient(clientId: string): PinnedClient | undefined {
  // Plugins installed in the ChatGPT desktop app sign in as its Codex native
  // client, whose published document registers loopback callbacks (any port,
  // RFC 8252) rather than a chatgpt.com redirect. Checked before the callback
  // pattern, which would otherwise read `codex` as a callback id.
  if (clientId === CHATGPT_CODEX_CLIENT_ID) {
    return { clientId, clientName: 'ChatGPT (desktop)', redirectUris: CHATGPT_CODEX_REDIRECT_URIS, verifiedHost: 'chatgpt.com', host: 'chatgpt' };
  }
  if (clientId === CHATGPT_CLIENT_ID) {
    return { clientId, clientName: 'ChatGPT', redirectUris: [CHATGPT_REDIRECT_URI], verifiedHost: 'chatgpt.com', host: 'chatgpt' };
  }
  if (clientId === CLAUDE_CLIENT_ID) {
    return { clientId, clientName: 'Claude', redirectUris: [CLAUDE_REDIRECT_URI], verifiedHost: 'claude.ai', host: 'claude' };
  }
  if (clientId === GROK_CLIENT_ID) {
    return { clientId, clientName: 'Grok', redirectUris: GROK_REDIRECT_URIS, verifiedHost: 'grok.com', host: 'grok' };
  }
  if (clientId === CURSOR_CLIENT_ID) {
    return { clientId, clientName: 'Grok Bot or Cursor', redirectUris: CURSOR_REDIRECT_URIS, verifiedHost: 'cursor.com', host: 'cursor' };
  }
  const callback = CHATGPT_CALLBACK_CLIENT_ID.exec(clientId)?.[1];
  if (callback) {
    return {
      clientId,
      clientName: 'ChatGPT',
      redirectUris: [`https://chatgpt.com/connector/oauth/${callback}`],
      verifiedHost: 'chatgpt.com',
      host: 'chatgpt',
    };
  }
  return undefined;
}

/**
 * The hosting provider of a pinned client's grant; undefined for any other
 * connection. Grok Bot or Cursor counts as xAI: Grok Bot runs on Grok, and a
 * Cursor agent's model cannot be known from its grant.
 */
export function pinnedGrantProvider(connection: { clientId?: string | null }): 'openai' | 'anthropic' | 'xai' | undefined {
  const host = typeof connection.clientId === 'string' ? pinnedClient(connection.clientId)?.host : undefined;
  return host === 'chatgpt' ? 'openai' : host === 'claude' ? 'anthropic' : host === 'grok' || host === 'cursor' ? 'xai' : undefined;
}
