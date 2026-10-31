import { fetchBoundedText } from './http-timeout.ts';
import type { OAuthFetch } from './connect.ts';
import type { SecretStore } from './secret-store.ts';

export interface GoogleDesktopClient { clientId: string; clientSecret: string }
const FILE_ERROR = 'Choose the JSON downloaded for a Desktop app in Google Cloud Clients. Web app keys cannot use this flow.';

/** Never trust endpoints embedded in an uploaded provider file. */
export function parseGoogleDesktopClient(text: string): GoogleDesktopClient {
  try {
    if (text.length > 64 * 1024) throw new Error();
    const value = JSON.parse(text)?.installed;
    if (!value || typeof value.client_id !== 'string' || typeof value.client_secret !== 'string') throw new Error();
    const client = { clientId: value.client_id.trim(), clientSecret: value.client_secret.trim() };
    validateClient(client);
    return client;
  } catch { throw new Error(FILE_ERROR); }
}

function validateClient(client: GoogleDesktopClient): void {
  if (typeof client?.clientId !== 'string' || typeof client?.clientSecret !== 'string' || !/^[A-Za-z0-9._-]{1,240}\.apps\.googleusercontent\.com$/.test(client.clientId) || !client.clientSecret || client.clientSecret.length > 1024 || /\s/.test(client.clientSecret)) {
    throw new Error('Copy the Client ID and secret from the same Desktop app in Google Cloud Clients.');
  }
}

/**
 * A deliberately invalid refresh grant probes client authentication without a
 * user token. It cannot prove API enablement, publishing state or consent;
 * those are checked during sign-in and the first authorized API request.
 */
export async function checkGoogleOwnApp(client: GoogleDesktopClient, fetchImpl: OAuthFetch = fetch): Promise<void> {
  validateClient(client);
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchBoundedText(fetchImpl, 'https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token', refresh_token: 'olympus-app-check-not-a-user-token' }).toString(),
    }, { timeoutMs: 10_000, limitBytes: 16 * 1024 }));
  } catch { throw new Error('Google could not be reached to check your app key. Try again.'); }
  let code: unknown;
  try { code = JSON.parse(text)?.error; } catch { /* fixed error below */ }
  if (response.status === 400 && code === 'invalid_grant') return;
  if (code === 'invalid_client' || code === 'unauthorized_client') throw new Error('Google did not accept this app key. Redo Make a Desktop app key and download it, then add the new file.');
  throw new Error('Google could not confirm this app key. Check the Desktop client in Google Cloud Clients, then try again.');
}

/** Prove the API for this consent before publishing a usable grant. */
export async function checkGoogleOwnAppAccess(source: 'gmail' | 'google-drive' | 'google', accessToken: string, fetchImpl: OAuthFetch = fetch): Promise<void> {
  const checks = source === 'google' ? ['gmail', 'google-drive'] as const : [source];
  for (const check of checks) {
    const url = check === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)';
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await fetchBoundedText(fetchImpl, url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' }, { timeoutMs: 10_000, limitBytes: 64 * 1024 }));
    } catch { throw new Error('Google could not be reached for the API check. Try signing in again.'); }
    if (response.status === 403) throw new Error('Google did not allow this API read. Redo Make the project and turn on Gmail and Drive, then sign in and allow read access.');
    if (response.status === 401) throw new Error('Google did not accept the sign-in. Sign in again and allow read access.');
    let value: { emailAddress?: unknown; user?: { permissionId?: unknown } } = {};
    try { value = JSON.parse(text) ?? {}; } catch { /* fixed error below */ }
    if (!response.ok || (check === 'gmail' ? typeof value.emailAddress !== 'string' : typeof value.user?.permissionId !== 'string')) throw new Error('Google could not confirm API access. Check your app settings and sign in again.');
  }
}

/** A registration is one encrypted write, never two independently replaceable halves. */
export async function readGoogleOwnAppRegistration(store: SecretStore): Promise<GoogleDesktopClient | undefined> {
  const raw = await store.get('google.own_app.registration');
  if (!raw) return undefined;
  try {
    const client = JSON.parse(raw) as GoogleDesktopClient;
    validateClient(client);
    return client;
  } catch { return undefined; }
}
