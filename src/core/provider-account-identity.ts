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
 * digests, so no address or Google id is written to the registry. A Google
 * account is named by up to three labels joined with `.` (see
 * sameProviderAccount):
 *
 * - `google-sub:` the OpenID subject, from tokeninfo. Immutable. Google gives
 *   it only to a token granted `openid`, which every Google connect requests
 *   since 2026-10-11; a grant from before then has none.
 * - `google-perm:` Drive's `about.user.permissionId`. Immutable, readable
 *   under `drive.readonly`, so Drive grants from before `openid` have it too.
 * - `google:` the account's address. A Workspace admin can rename it while
 *   the account and its mail and files stay the same, so it decides only
 *   when neither side carries an immutable label (a grant from before
 *   `openid`, or a delegated service-account token).
 */
export type AccountBoundProvider = 'dropbox' | 'gmail' | 'google_drive' | 'x';

export const ACCOUNT_BOUND_PROVIDERS: readonly AccountBoundProvider[] = ['dropbox', 'gmail', 'google_drive', 'x'];

export function isAccountBoundProvider(provider: string): provider is AccountBoundProvider {
  return (ACCOUNT_BOUND_PROVIDERS as readonly string[]).includes(provider);
}

/** Where each provider answers "who is this token". Overridable for tests and self-hosted mocks. */
export interface ProviderIdentityEndpoints {
  dropbox?: string;
  gmail?: string;
  google_drive?: string;
  x?: string;
  /** Google's tokeninfo, asked alongside Gmail or Drive for the OpenID subject. */
  google_tokeninfo?: string;
}

export const DEFAULT_PROVIDER_IDENTITY_ENDPOINTS: Required<ProviderIdentityEndpoints> = {
  // users/get_current_account needs account_info.read, which Dropbox registers
  // on every user-linked app and Olympus now requests explicitly.
  dropbox: 'https://api.dropboxapi.com/2/users/get_current_account',
  // Relative, as gmail.ts writes its paths: a literal `/users/<name>/` reads
  // as a home directory to the release owner-identifier scan.
  gmail: new URL('users/me/profile', 'https://gmail.googleapis.com/gmail/v1/').toString(),
  google_drive: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)',
  // X's own numeric user id, the same one connect records for the grant.
  x: 'https://api.x.com/2/users/me',
  // POSTed with the token as a bearer header, as google-auth-library does, so
  // the token is never written into a URL.
  google_tokeninfo: 'https://oauth2.googleapis.com/tokeninfo',
};

const IDENTITY_RESPONSE_LIMIT_BYTES = 64 * 1024;
const DROPBOX_ACCOUNT_ID = /^dbid:[A-Za-z0-9_-]{1,150}$/;
const X_USER_ID = /^\d{1,32}$/;

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

/** The opaque Google address label: never the address itself. */
export function googleAccountIdFromAddress(address: string): string {
  return `google:${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 40)}`;
}

/** The opaque label of a Google OpenID subject (`sub`). */
export function googleSubjectLabel(subject: string): string {
  return `google-sub:${createHash('sha256').update(`sub\n${subject.trim()}`).digest('hex').slice(0, 32)}`;
}

/** The opaque label of a Drive user's `permissionId`. */
export function googlePermissionLabel(permissionId: string): string {
  return `google-perm:${createHash('sha256').update(`perm\n${permissionId.trim()}`).digest('hex').slice(0, 32)}`;
}

/** Labels that name an account for good; anything else can be renamed. */
const IMMUTABLE_LABEL_KINDS = ['dbid', 'google-sub', 'google-perm'] as const;
const LABEL = /^([a-z-]+):[A-Za-z0-9_-]{1,150}$/;

/**
 * Join labels into the one account id stored in the registry and the
 * binding record: immutable labels first, at most one per kind. `.` never
 * occurs inside a label, and the result stays within the registry's label
 * alphabet (`[a-zA-Z0-9._:-]`).
 */
export function composeProviderAccountId(labels: readonly string[]): string | undefined {
  const byKind = new Map<string, string>();
  for (const label of labels) {
    const kind = LABEL.exec(label)?.[1];
    if (kind && !byKind.has(kind)) byKind.set(kind, label);
  }
  const ordered = [
    ...IMMUTABLE_LABEL_KINDS.map((kind) => byKind.get(kind)),
    byKind.get('google'),
  ].filter((label): label is string => Boolean(label));
  return ordered.length > 0 ? ordered.join('.') : undefined;
}

/** kind → label; undefined when `id` is not made of known labels (compared whole). */
function parseProviderAccountId(id: string): Map<string, string> | undefined {
  const labels = new Map<string, string>();
  for (const label of id.trim().split('.')) {
    const kind = LABEL.exec(label)?.[1];
    if (!kind || (kind !== 'google' && !(IMMUTABLE_LABEL_KINDS as readonly string[]).includes(kind))) return undefined;
    if (labels.has(kind)) return undefined;
    labels.set(kind, label);
  }
  return labels.size > 0 ? labels : undefined;
}

export type ProviderAccountMatch = 'same' | 'different' | 'unproven';

/**
 * Whether an observed account id names the account a record names.
 *
 * - Both carry an immutable label of the same kind: those decide alone. A
 *   renamed address is the same account; an address now held by another
 *   account is not.
 * - The record carries an immutable label and the observation shares none
 *   (a token without `openid`, an environment token): `unproven`, never
 *   decided by the address. The address may have passed to another account
 *   since the record learned who it was (independent review P1).
 * - The record is an address alone (recorded before immutable labels, or
 *   from tokens that never had one): the address decides, as it always did.
 *   That is the transition; such a record takes on the immutable labels of
 *   the first token that matches it (mergeProviderAccountIds).
 *
 * Ids that are not made of known labels compare whole.
 */
export function compareProviderAccounts(recorded: string, observed: string): ProviderAccountMatch {
  const a = parseProviderAccountId(recorded);
  const b = parseProviderAccountId(observed);
  if (!a || !b) return recorded.trim() === observed.trim() ? 'same' : 'different';
  let shared = false;
  for (const kind of IMMUTABLE_LABEL_KINDS) {
    const left = a.get(kind);
    const right = b.get(kind);
    if (left === undefined || right === undefined) continue;
    if (left !== right) return 'different';
    shared = true;
  }
  if (shared) return 'same';
  if (hasImmutableAccountLabel(recorded)) return 'unproven';
  const address = a.get('google');
  return address !== undefined && address === b.get('google') ? 'same' : 'different';
}

export function sameProviderAccount(recorded: string, observed: string): boolean {
  return compareProviderAccounts(recorded, observed) === 'same';
}

/**
 * Whether an import names its account by an address alone (an mbox's
 * delivered-to address): something the export's author wrote, and an address
 * can pass to another account. Such an id never proves an account by itself
 * (resolveImportAccount).
 */
export function namesAccountByAddressOnly(id: string): boolean {
  const labels = parseProviderAccountId(id);
  return labels !== undefined && labels.has('google') && !hasImmutableAccountLabel(id);
}

/**
 * How an address-only id (namesAccountByAddressOnly) stands against a record:
 * `same` when the record carries that address, `different` when it carries
 * another, `unproven` when it carries none (it is known by immutable labels
 * only, or by ids that are not made of known labels).
 */
export function compareAddressToRecord(recorded: string, address: string): ProviderAccountMatch {
  const mine = parseProviderAccountId(address)?.get('google');
  const theirs = parseProviderAccountId(recorded)?.get('google');
  if (mine === undefined || theirs === undefined) return 'unproven';
  return mine === theirs ? 'same' : 'different';
}

/** Whether `id` names its account by something no rename changes. */
export function hasImmutableAccountLabel(id: string): boolean {
  const labels = parseProviderAccountId(id);
  return labels !== undefined && IMMUTABLE_LABEL_KINDS.some((kind) => labels.has(kind));
}

/**
 * The record after `observed` was confirmed to be `recorded`'s account
 * (sameProviderAccount): every immutable label either side holds, and the
 * address as it is now. Keeping the current address, not the first one, means
 * an address the account gave up never matches on its own.
 */
export function mergeProviderAccountIds(recorded: string, observed: string): string {
  const a = parseProviderAccountId(recorded);
  const b = parseProviderAccountId(observed);
  if (!a || !b) return observed.trim();
  const labels = IMMUTABLE_LABEL_KINDS
    .map((kind) => b.get(kind) ?? a.get(kind))
    .concat(b.get('google') ?? a.get('google'))
    .filter((label): label is string => Boolean(label));
  return composeProviderAccountId(labels)!;
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
  if (options.provider === 'x') {
    // X's raw numeric id, as connect records it and the bookmarks lane reads
    // as; it is not one of the Google or Dropbox labels and compares whole.
    const id = xUserIdFromPayload(payload);
    if (!id) throw new ProviderAccountIdentityError('X did not name the connected account.');
    return id;
  }
  const labels = labelsFromIdentityPayload(options.provider, payload);
  if (!labels) {
    throw new ProviderAccountIdentityError(`${providerLabel(options.provider)} did not name the connected account.`);
  }
  if (options.provider === 'gmail' || options.provider === 'google_drive') {
    // Asked every time, never skipped on failure: a Google answer without the
    // subject it could have carried would fall back to the renamable address.
    const subject = await fetchGoogleSubject({
      accessToken: options.accessToken,
      endpoint: options.endpoints?.google_tokeninfo ?? DEFAULT_PROVIDER_IDENTITY_ENDPOINTS.google_tokeninfo,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    if (subject) labels.push(googleSubjectLabel(subject));
  }
  return composeProviderAccountId(labels)!;
}

/**
 * The OpenID subject of a Google access token, or undefined when the token
 * was not granted `openid` (Google then leaves `sub` out). Throws when
 * tokeninfo cannot answer, or when it says `openid` was granted and names no
 * subject.
 */
async function fetchGoogleSubject(options: {
  accessToken: string;
  endpoint: string;
  fetchImpl: TimeoutFetch | undefined;
  timeoutMs: number | undefined;
}): Promise<string | undefined> {
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchBoundedText(
      options.fetchImpl ?? ((url, requestInit) => fetch(url, requestInit)),
      options.endpoint,
      { method: 'POST', headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' } },
      { timeoutMs: options.timeoutMs ?? 15_000, limitBytes: IDENTITY_RESPONSE_LIMIT_BYTES },
    ));
  } catch {
    throw new ProviderAccountIdentityError('Google did not answer the token lookup.');
  }
  if (!response.ok) throw new ProviderAccountIdentityError(`Google refused the token lookup with status ${response.status}.`);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new ProviderAccountIdentityError('Google returned an unreadable token lookup.');
  }
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (/^[A-Za-z0-9_-]{1,255}$/.test(subject)) return subject;
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
  if (subject || scopes.includes('openid')) {
    throw new ProviderAccountIdentityError('Google did not name the subject of an openid token.');
  }
  return undefined;
}

/** X's numeric user id from `users/me`; X ids never change. */
function xUserIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const data = payload.data;
  const id = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).id
    : undefined;
  return typeof id === 'string' && X_USER_ID.test(id.trim()) ? id.trim() : undefined;
}

function labelsFromIdentityPayload(provider: AccountBoundProvider, payload: Record<string, unknown>): string[] | undefined {
  if (provider === 'dropbox') {
    const id = dropboxAccountIdFromTokenPayload(payload);
    return id ? [id] : undefined;
  }
  const user = payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user)
    ? payload.user as Record<string, unknown>
    : undefined;
  const address = provider === 'gmail' ? payload.emailAddress : user?.emailAddress;
  if (typeof address !== 'string' || !address.includes('@')) return undefined;
  const labels = [googleAccountIdFromAddress(address)];
  const permissionId = typeof user?.permissionId === 'string' ? user.permissionId.trim() : '';
  if (provider === 'google_drive' && /^[A-Za-z0-9_-]{1,255}$/.test(permissionId)) {
    labels.push(googlePermissionLabel(permissionId));
  }
  return labels;
}

function providerLabel(provider: AccountBoundProvider): string {
  return provider === 'dropbox' ? 'Dropbox' : provider === 'gmail' ? 'Gmail' : provider === 'x' ? 'X' : 'Google Drive';
}

/**
 * Whether this token's account owns one of these folders, recorded earlier as
 * unshared root folders of the previous account (see dropboxOwnRootFolderIds).
 * True as soon as one opens and is still shared with no one: only its owner
 * can open such a folder. False when every one is not found or now shared
 * (deleted, or another account's); undefined when Dropbox could not say for a
 * folder and none proved it. One proving folder is enough, so deleting or
 * sharing some of them does not strand a same-account reconnect
 * (independent review round 14). Never used with arbitrary stored items: a
 * shared item opens for every account it is shared with.
 */
export async function dropboxOwnsOneOfFolders(options: {
  accessToken: string;
  folderIds: readonly string[];
  fetchImpl?: TimeoutFetch;
  timeoutMs?: number;
  endpoint?: string;
}): Promise<boolean | undefined> {
  const endpoint = options.endpoint ?? 'https://api.dropboxapi.com/2/files/get_metadata';
  let unknown = false;
  for (const id of options.folderIds) {
    if (!/^id:[A-Za-z0-9_-]{1,200}$/.test(id)) { unknown = true; continue; }
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
      unknown = true;
      continue;
    }
    if (response.ok) {
      let entry: Record<string, unknown> | undefined;
      try { entry = JSON.parse(text) as Record<string, unknown>; } catch { entry = undefined; }
      if (!entry || typeof entry !== 'object') { unknown = true; continue; }
      if (entry['.tag'] === 'folder' && entry.id === id && entry.sharing_info === undefined) return true;
      // Opens, but shared now (or not the folder recorded): proves nothing.
      continue;
    }
    // 409 carries a route error; only `path/not_found` means "not this account's".
    if (response.status === 409 && /"not_found"/.test(text)) continue;
    unknown = true;
  }
  return unknown ? undefined : false;
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
  const limit = options.limit ?? 5;
  const listUrl = options.endpoint ?? 'https://api.dropboxapi.com/2/files/list_folder';
  const found: string[] = [];
  let cursor: string | undefined;
  // Follow the listing until enough folders are found or it ends (independent
  // review round 14); a root this large without one is treated as unknown.
  for (let page = 0; page < 20; page += 1) {
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await fetchBoundedText(
        options.fetchImpl ?? ((url, requestInit) => fetch(url, requestInit)),
        cursor === undefined ? listUrl : `${listUrl}/continue`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cursor === undefined ? { path: '', recursive: false, limit: 200 } : { cursor }),
        },
        { timeoutMs: options.timeoutMs ?? 15_000, limitBytes: 1024 * 1024 },
      ));
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    let parsed: { entries?: unknown; has_more?: unknown; cursor?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed.entries)) return undefined;
    for (const raw of parsed.entries) {
      const entry = raw as Record<string, unknown> | null;
      if (entry && typeof entry === 'object'
        && entry['.tag'] === 'folder'
        && typeof entry.id === 'string'
        && /^id:[A-Za-z0-9_-]{1,200}$/.test(entry.id)
        // Present on a shared folder and on anything inside one.
        && entry.sharing_info === undefined) {
        found.push(entry.id);
        if (found.length >= limit) return found;
      }
    }
    if (parsed.has_more !== true) return found;
    if (typeof parsed.cursor !== 'string' || !parsed.cursor) return undefined;
    cursor = parsed.cursor;
  }
  return found.length > 0 ? found : undefined;
}
