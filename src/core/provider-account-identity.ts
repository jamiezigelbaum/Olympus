import { createHash } from 'node:crypto';
import { fetchBoundedText, type TimeoutFetch } from './http-timeout.ts';

/**
 * Which provider account an OAuth access token belongs to, for the file
 * sources whose stored items must never come from two accounts at once.
 *
 * 2026-10-10: Dropbox was connected twice in quick succession with two
 * different accounts. The second connect replaced the refresh token, but the
 * worker kept syncing on the first account's cached access token, so the first
 * account's files were indexed under the second account's credential. Every
 * grant now carries the account it authorizes, and the worker checks the token
 * it is about to read with against that account and against the account the
 * source's stores were filled from.
 *
 * The identifier is an opaque label: Dropbox's own `account_id`, and for Google
 * a digest of the account's address (Gmail exposes no other stable id under
 * `gmail.readonly`), so no address is written to the registry.
 */
export type AccountBoundProvider = 'dropbox' | 'gmail' | 'google_drive';

export const ACCOUNT_BOUND_PROVIDERS: readonly AccountBoundProvider[] = ['dropbox', 'gmail', 'google_drive'];

export function isAccountBoundProvider(provider: string): provider is AccountBoundProvider {
  return (ACCOUNT_BOUND_PROVIDERS as readonly string[]).includes(provider);
}

/** Where each provider answers "who is this token". Overridable for tests and self-hosted mocks. */
export interface ProviderIdentityEndpoints {
  dropbox?: string;
  gmail?: string;
  google_drive?: string;
}

export const DEFAULT_PROVIDER_IDENTITY_ENDPOINTS: Required<ProviderIdentityEndpoints> = {
  // users/get_current_account needs account_info.read, which Dropbox registers
  // on every user-linked app and Olympus now requests explicitly.
  dropbox: 'https://api.dropboxapi.com/2/users/get_current_account',
  // Relative, as gmail.ts writes its paths: a literal `/users/<name>/` reads
  // as a home directory to the release owner-identifier scan.
  gmail: new URL('users/me/profile', 'https://gmail.googleapis.com/gmail/v1/').toString(),
  google_drive: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
};

const IDENTITY_RESPONSE_LIMIT_BYTES = 64 * 1024;
const DROPBOX_ACCOUNT_ID = /^dbid:[A-Za-z0-9_-]{1,150}$/;

export class ProviderAccountIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAccountIdentityError';
  }
}

/** Dropbox's token response names the account the grant belongs to. */
export function dropboxAccountIdFromTokenPayload(payload: Record<string, unknown>): string | undefined {
  const value = typeof payload.account_id === 'string' ? payload.account_id.trim() : '';
  return DROPBOX_ACCOUNT_ID.test(value) ? value : undefined;
}

/** The opaque Google account label: never the address itself. */
export function googleAccountIdFromAddress(address: string): string {
  return `google:${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 40)}`;
}

/**
 * Ask the provider which account `accessToken` belongs to. Throws
 * ProviderAccountIdentityError on any refusal, timeout or unexpected shape;
 * the caller decides whether an unknown answer blocks it.
 */
export async function fetchProviderAccountId(options: {
  provider: AccountBoundProvider;
  accessToken: string;
  fetchImpl?: TimeoutFetch;
  timeoutMs?: number;
  endpoints?: ProviderIdentityEndpoints;
}): Promise<string> {
  const endpoint = options.endpoints?.[options.provider] ?? DEFAULT_PROVIDER_IDENTITY_ENDPOINTS[options.provider];
  const init: RequestInit = options.provider === 'dropbox'
    ? {
        method: 'POST',
        // An argument-less Dropbox RPC call takes the JSON literal null.
        headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
        body: 'null',
      }
    : { method: 'GET', headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' } };
  let response: Response;
  let text: string;
  try {
    // One deadline and one byte cap over headers AND body: every guarded
    // sync awaits this, so a stalled or endless body must not hang a lane.
    ({ response, text } = await fetchBoundedText(
      options.fetchImpl ?? ((url, requestInit) => fetch(url, requestInit)),
      endpoint,
      init,
      { timeoutMs: options.timeoutMs ?? 15_000, limitBytes: IDENTITY_RESPONSE_LIMIT_BYTES },
    ));
  } catch {
    throw new ProviderAccountIdentityError(`${providerLabel(options.provider)} did not answer the account lookup.`);
  }
  if (!response.ok) {
    throw new ProviderAccountIdentityError(
      `${providerLabel(options.provider)} refused the account lookup with status ${response.status}.`,
    );
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new ProviderAccountIdentityError(`${providerLabel(options.provider)} returned an unreadable account lookup.`);
  }
  const id = accountIdFromIdentityPayload(options.provider, payload);
  if (!id) {
    throw new ProviderAccountIdentityError(`${providerLabel(options.provider)} did not name the connected account.`);
  }
  return id;
}

function accountIdFromIdentityPayload(provider: AccountBoundProvider, payload: Record<string, unknown>): string | undefined {
  if (provider === 'dropbox') return dropboxAccountIdFromTokenPayload(payload);
  const address = provider === 'gmail'
    ? payload.emailAddress
    : payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user)
      ? (payload.user as Record<string, unknown>).emailAddress
      : undefined;
  return typeof address === 'string' && address.includes('@') ? googleAccountIdFromAddress(address) : undefined;
}

function providerLabel(provider: AccountBoundProvider): string {
  return provider === 'dropbox' ? 'Dropbox' : provider === 'gmail' ? 'Gmail' : 'Google Drive';
}

/**
 * Whether every one of these Dropbox ids still opens for this token's
 * account: true when all do, false as soon as one is not found, undefined
 * when Dropbox could not say. Used with the ids of folders only the previous
 * account could open (see dropboxOwnRootFolderIds), never with arbitrary
 * stored items: a shared item opens for every account it is shared with.
 */
export async function dropboxItemsOpenForToken(options: {
  accessToken: string;
  itemIds: readonly string[];
  fetchImpl?: TimeoutFetch;
  timeoutMs?: number;
  endpoint?: string;
}): Promise<boolean | undefined> {
  const endpoint = options.endpoint ?? 'https://api.dropboxapi.com/2/files/get_metadata';
  for (const id of options.itemIds) {
    if (!/^id:[A-Za-z0-9_-]{1,200}$/.test(id)) return undefined;
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await fetchBoundedText(
        options.fetchImpl ?? ((url, requestInit) => fetch(url, requestInit)),
        endpoint,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: id }),
        },
        { timeoutMs: options.timeoutMs ?? 15_000, limitBytes: IDENTITY_RESPONSE_LIMIT_BYTES },
      ));
    } catch {
      return undefined;
    }
    if (response.ok) continue;
    // 409 carries a route error; only `path/not_found` means "not this account's".
    if (response.status === 409 && /"not_found"/.test(text)) return false;
    return undefined;
  }
  return true;
}

/**
 * Up to `limit` ids of folders in the root of this token's Dropbox that are
 * shared with no one. Only the account that owns such a folder can open it,
 * so they identify the account without `account_info.read`: the evidence a
 * grant made before that scope was requested leaves for a later reconnect to
 * be checked against (PR review). Undefined when Dropbox could not say.
 */
export async function dropboxOwnRootFolderIds(options: {
  accessToken: string;
  limit?: number;
  fetchImpl?: TimeoutFetch;
  timeoutMs?: number;
  endpoint?: string;
}): Promise<string[] | undefined> {
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchBoundedText(
      options.fetchImpl ?? ((url, requestInit) => fetch(url, requestInit)),
      options.endpoint ?? 'https://api.dropboxapi.com/2/files/list_folder',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '', recursive: false, limit: 200 }),
      },
      { timeoutMs: options.timeoutMs ?? 15_000, limitBytes: 1024 * 1024 },
    ));
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  try {
    const parsed = JSON.parse(text) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return undefined;
    return parsed.entries
      .filter((entry): entry is { '.tag': string; id: string; sharing_info?: unknown } =>
        !!entry && typeof entry === 'object'
        && (entry as Record<string, unknown>)['.tag'] === 'folder'
        && typeof (entry as Record<string, unknown>).id === 'string'
        && /^id:[A-Za-z0-9_-]{1,200}$/.test((entry as Record<string, unknown>).id as string)
        // Present on a shared folder and on anything inside one.
        && (entry as Record<string, unknown>).sharing_info === undefined)
      .slice(0, options.limit ?? 5)
      .map((entry) => entry.id);
  } catch {
    return undefined;
  }
}
