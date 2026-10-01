/**
 * The OAuth clients Olympus recognizes by their client metadata document URL.
 *
 * ChatGPT identifies itself with a Client ID Metadata Document: with an
 * authorization server that returns RFC 9207 `iss` (Olympus does), it uses
 * the stable `https://chatgpt.com/oauth/client.json` and returns to
 * `https://chatgpt.com/connector_platform_oauth_redirect`; otherwise a
 * callback-specific `https://chatgpt.com/oauth/<callback_id>/client.json`
 * returning to `https://chatgpt.com/connector/oauth/<callback_id>`
 * (developers.openai.com/plugins/build/auth, read 2026-10-01).
 *
 * These are pinned here rather than fetched: Olympus never fetches a client
 * metadata document, so a stranger naming an arbitrary URL as client_id cannot
 * make the owner's Mac contact it (and reveal its address). Any other
 * metadata-URL client is refused.
 */
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
/** https://chatgpt.com/oauth/codex/client.json, read 2026-10-01. */
export const CHATGPT_CODEX_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';
const CHATGPT_CODEX_REDIRECT_URIS: readonly string[] = ['http://127.0.0.1/callback', 'http://localhost/callback'];
const CHATGPT_CALLBACK_CLIENT_ID =/^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{1,128})\/client\.json$/;

export interface PinnedClient {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  /** The host that vouches for the client: the client_id URL's host. */
  verifiedHost: string;
}

/** Whether a client_id is shaped like a metadata document URL. */
export function isClientIdMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://');
}

export function pinnedClient(clientId: string): PinnedClient | undefined {
  // Plugins installed in the ChatGPT desktop app sign in as its Codex native
  // client, whose published document registers loopback callbacks (any port,
  // RFC 8252) rather than a chatgpt.com redirect. Checked before the callback
  // pattern, which would otherwise read `codex` as a callback id.
  if (clientId === CHATGPT_CODEX_CLIENT_ID) {
    return { clientId, clientName: 'ChatGPT (desktop)', redirectUris: CHATGPT_CODEX_REDIRECT_URIS, verifiedHost: 'chatgpt.com' };
  }
  if (clientId === CHATGPT_CLIENT_ID) {
    return { clientId, clientName: 'ChatGPT', redirectUris: [CHATGPT_REDIRECT_URI], verifiedHost: 'chatgpt.com' };
  }
  const callback = CHATGPT_CALLBACK_CLIENT_ID.exec(clientId)?.[1];
  if (callback) {
    return {
      clientId,
      clientName: 'ChatGPT',
      redirectUris: [`https://chatgpt.com/connector/oauth/${callback}`],
      verifiedHost: 'chatgpt.com',
    };
  }
  return undefined;
}
