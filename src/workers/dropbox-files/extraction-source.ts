/**
 * The Dropbox implementation of `FileExtractionSource`.
 *
 * This file is the Dropbox side of the extraction seam, and it is deliberately
 * the only place in the extraction path that knows Dropbox exists. Everything
 * the provider imposes concentrates here — `path_display` and `path_lower`,
 * the `rev:` download argument, the 4 MiB-block content hash, the mounted
 * local roots and their traversal containment rules — so that the factory that
 * consumes this source can stay genuinely source-neutral.
 *
 * The names are spelled out on purpose. A source module that euphemised its
 * own provider would move the coupling somewhere less visible without removing
 * any of it. The architecture guard's source-agnostic file list does not cover
 * this directory precisely because this is where family-shaped code is
 * supposed to live.
 *
 * Two substitutions distinguish this from the legacy extraction path it ports:
 *
 *   - The Dropbox path is read from the connector store's `locator_uri`, which
 *     the merged replay populates from `path_display`, instead of from the
 *     legacy index's private per-job metadata. No new file may import
 *     `local-index.ts`, and this one imports nothing from the legacy fleet at
 *     all: `dropbox-content-hash.ts` is its only Dropbox-side dependency, so
 *     nothing here has to be untangled again on the day the legacy index is
 *     deleted.
 *   - `approved_scope_key` is not a column in the shared store, so it is
 *     derived from the configured lane whose path prefix contains the item.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { computeDropboxContentHash } from './dropbox-content-hash.ts';
import {
  FileExtractionSourceError,
  splitScopedLocalItemId,
  type ExtractionCandidateReader,
  type ExtractionCandidateReaderOptions,
  type ExtractionCandidateRow,
} from '../../core/file-extraction-source.ts';
import type {
  ExtractionCandidateListOptions,
  ExtractionCandidatePage,
  ExtractionFetchOptions,
  ExtractionItemRef,
  FetchedBytes,
  FileExtractionSource,
} from '../file-extraction/types.ts';

export const DROPBOX_LOCAL_ROOTS_ENV = 'OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON';

const DROPBOX_CONTENT_BASE_URL = 'https://content.dropboxapi.com/2';
const DROPBOX_SCOPE_KEY_PROVIDER_PREFIX = 'dropbox.';
const DROPBOX_FOLDER_ID_SCOPE_PREFIX = 'folder_id:';
const MAX_PROVIDER_DETAIL_CHARS = 500;

/**
 * One char, because the locator lookup wants the item row and never the text.
 * Extraction candidates hold zero chunks by definition, so this budget only
 * matters if the method is ever called for an item that already has text.
 */
const LOCATOR_LOOKUP_MAX_CHARS = 1;

/**
 * One configured Dropbox lane.
 *
 * `approvedScopeKey` is the lane identity the job store already uses, spelled
 * `dropbox.<account>:<path prefix>` — for instance `dropbox.personal:/2 Areas`.
 * Account and path prefix are parsed from it, so a normal lane needs no other
 * configuration; supply them explicitly only to override the parse.
 */
export interface DropboxExtractionScopeConfig {
  approvedScopeKey: string;
  account?: string;
  pathPrefix?: string;
}

interface ResolvedDropboxExtractionScope {
  approvedScopeKey: string;
  account: string;
  pathPrefix: string;
}

/**
 * One mounted Dropbox root. Shape-compatible with the legacy resolver's root
 * config and with the JSON already deployed in `OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON`,
 * so the host's env needs no edit when the lane is cut over.
 */
export interface DropboxExtractionLocalRootConfig {
  rootPath: string;
  account?: string;
  approvedScopeKey?: string;
  dropboxPathPrefix?: string;
  rootId?: string;
}

/**
 * Point lookup for one item's Dropbox path.
 *
 * Narrow on purpose: `LocalConnectorStore.localContent` satisfies it
 * structurally as it stands today, so this leg needs nothing added to the
 * shared store. A path cannot ride on `ExtractionItemRef` — that type is
 * deliberately path-free, and the job that carries it is leased in a different
 * process from the pass that enqueued it, so the path has to be re-read at
 * fetch time rather than remembered.
 */
export interface DropboxItemLocatorReader {
  localContent(
    localItemId: string,
    maxChars?: number,
  ): { locatorUri?: string } | undefined | Promise<{ locatorUri?: string } | undefined>;
}

export type DropboxExtractionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<Response>;

export interface DropboxExtractionSourceOptions {
  /**
   * Source id, corpus id and provider are all data. Nothing in this class
   * defaults them: a second Dropbox lane on a different corpus is a second
   * construction, never a second copy of this file.
   */
  id: string;
  corpusId: string;
  provider: string;
  candidates: ExtractionCandidateReader;
  scopes: readonly DropboxExtractionScopeConfig[];
  token: string;
  locators?: DropboxItemLocatorReader;
  localRoots?: readonly DropboxExtractionLocalRootConfig[];
  fetch?: DropboxExtractionFetch;
  contentBaseUrl?: string;
}

export class DropboxExtractionSource implements FileExtractionSource {
  readonly id: string;
  readonly corpusId: string;
  readonly provider: string;

  private readonly candidates: ExtractionCandidateReader;
  private readonly scopes: readonly ResolvedDropboxExtractionScope[];
  private readonly token: string;
  private readonly locators: DropboxItemLocatorReader | undefined;
  private readonly localRoots: readonly DropboxExtractionLocalRootConfig[];
  private readonly fetchImpl: DropboxExtractionFetch;
  private readonly contentBaseUrl: string;
  private readonly canonicalRootCache = new Map<string, Promise<string | undefined>>();

  constructor(options: DropboxExtractionSourceOptions) {
    this.id = requireNonEmpty(options.id, 'Dropbox extraction source id');
    this.corpusId = requireNonEmpty(options.corpusId, 'Dropbox extraction source corpus id');
    this.provider = requireNonEmpty(options.provider, 'Dropbox extraction source provider');
    this.token = requireNonEmpty(options.token, 'Dropbox content token');
    this.candidates = options.candidates;
    this.locators = options.locators;
    this.scopes = options.scopes.map((scope) => resolveScope(scope));
    this.localRoots = (options.localRoots ?? [])
      .map((root) => normalizeRootConfig(root))
      .filter((root): root is DropboxExtractionLocalRootConfig => Boolean(root));
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.contentBaseUrl = options.contentBaseUrl?.replace(/\/+$/, '') || DROPBOX_CONTENT_BASE_URL;
  }

  /**
   * Candidates are items the store holds with no extracted text yet, narrowed
   * to the configured lanes.
   *
   * An item whose `locator_uri` falls under no configured path prefix is not a
   * candidate at all: it is out of lane, and enqueuing it would put a job in
   * the store under a scope key nobody approved. That filtering happens after
   * the store's own page is read, so a page may return fewer refs than `limit`
   * while `done` is still false — the cursor, not the count, is what says
   * whether enumeration is finished.
   */
  async listCandidates(options: ExtractionCandidateListOptions): Promise<ExtractionCandidatePage> {
    const scopes = this.scopesFor(options.approvedScopeKeys);
    if (scopes.length === 0) return { candidates: [], done: true };

    const readerOptions: ExtractionCandidateReaderOptions = {
      limit: options.limit,
      withoutChunksOnly: true,
    };
    if (options.cursor !== undefined) readerOptions.cursor = options.cursor;
    if (options.mimeTypes) readerOptions.mimeTypes = options.mimeTypes;
    const sharedAccount = singleAccount(scopes);
    if (sharedAccount) readerOptions.accountScope = sharedAccount;

    const page = await this.candidates.extractionCandidates(readerOptions);
    const candidates: ExtractionItemRef[] = [];
    for (const row of page.candidates) {
      const ref = this.refFromRow(row, scopes);
      if (ref) candidates.push(ref);
    }
    return {
      candidates,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      done: page.done,
    };
  }

  /**
   * Local mount first, provider second — the same order the accelerated
   * download client uses today, and for the same reason: a verified local read
   * costs no API call and no egress.
   */
  async fetch(ref: ExtractionItemRef, options: ExtractionFetchOptions): Promise<FetchedBytes> {
    const local = await this.readFromLocalMount(ref, options.maxBytes);
    if (local) return local;
    return this.downloadFromProvider(ref, options.maxBytes);
  }

  /**
   * Dropbox is the family that can verify: the provider publishes the same
   * block-wise content hash the client can compute. Without a hash on the ref
   * there is nothing to verify against, and claiming the bytes are right would
   * be worse than admitting they are unchecked.
   */
  verifyBytes(ref: ExtractionItemRef, bytes: Uint8Array): boolean {
    if (!ref.contentHash) return false;
    return computeDropboxContentHash(bytes) === ref.contentHash;
  }

  private scopesFor(
    approvedScopeKeys: readonly string[] | undefined,
  ): readonly ResolvedDropboxExtractionScope[] {
    if (!approvedScopeKeys) return this.scopes;
    const wanted = new Set(approvedScopeKeys);
    return this.scopes.filter((scope) => wanted.has(scope.approvedScopeKey));
  }

  private refFromRow(
    row: ExtractionCandidateRow,
    scopes: readonly ResolvedDropboxExtractionScope[],
  ): ExtractionItemRef | undefined {
    const split = splitScopedLocalItemId(row.localItemId);
    const accountScope = row.accountScope ?? split?.accountScope;
    const providerItemId = row.providerItemId ?? split?.providerItemId;
    if (!accountScope || !providerItemId) return undefined;

    const scope = matchScope(scopes, accountScope, row.locatorUri);
    if (!scope) return undefined;

    const name = row.name ?? row.title;
    return {
      corpusId: this.corpusId,
      provider: this.provider,
      accountScope,
      approvedScopeKey: scope.approvedScopeKey,
      providerItemId,
      localItemId: row.localItemId,
      ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
      ...(name ? { name } : {}),
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
    };
  }

  /**
   * Undefined means "not available locally, ask the provider". The only
   * outcome that throws is the byte ceiling: a file too large on disk is too
   * large from the API too, and re-downloading it to learn that again would
   * spend an API call to reach the same refusal.
   */
  private async readFromLocalMount(
    ref: ExtractionItemRef,
    maxBytes: number | undefined,
  ): Promise<FetchedBytes | undefined> {
    if (this.localRoots.length === 0) return undefined;
    // Without a provider-supplied hash the equality gate below cannot run, and
    // an unverified local file is exactly what that gate exists to refuse.
    if (!ref.contentHash) return undefined;

    const roots = this.localRoots.filter((root) => rootMatchesRef(root, ref));
    if (roots.length === 0) return undefined;

    const dropboxPath = await this.dropboxPathFor(ref);
    if (!dropboxPath) return undefined;

    for (const root of roots) {
      const candidatePath = await this.candidatePath(root, dropboxPath);
      if (!candidatePath) continue;
      const bytes = await readVerifiedCandidate({
        candidatePath,
        contentHash: ref.contentHash,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(ref.sizeBytes !== undefined ? { declaredSizeBytes: ref.sizeBytes } : {}),
      });
      if (!bytes) continue;
      return {
        bytes,
        ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
        sizeBytes: bytes.byteLength,
      };
    }
    return undefined;
  }

  private async dropboxPathFor(ref: ExtractionItemRef): Promise<string | undefined> {
    if (!this.locators) return undefined;
    const content = await this.locators.localContent(ref.localItemId, LOCATOR_LOOKUP_MAX_CHARS);
    return content?.locatorUri;
  }

  private async candidatePath(
    root: DropboxExtractionLocalRootConfig,
    dropboxPath: string,
  ): Promise<string | undefined> {
    const relativePath = dropboxRelativePath(root.dropboxPathPrefix, dropboxPath);
    if (relativePath === undefined) return undefined;

    // realpath, not a string comparison: the containment check is only
    // meaningful against a symlink if the link has already been followed.
    const rootRealPath = await this.canonicalRoot(root.rootPath);
    if (!rootRealPath) return undefined;

    const candidatePath = resolve(rootRealPath, relativePath);
    const relativeToRoot = relative(rootRealPath, candidatePath);
    if (relativeToRoot.startsWith('..') || relativeToRoot === '' || relativeToRoot.includes(`..${sep}`)) {
      return undefined;
    }
    return candidatePath;
  }

  private canonicalRoot(rootPath: string): Promise<string | undefined> {
    let cached = this.canonicalRootCache.get(rootPath);
    if (!cached) {
      cached = realpath(rootPath).catch(() => undefined);
      this.canonicalRootCache.set(rootPath, cached);
    }
    return cached;
  }

  private async downloadFromProvider(
    ref: ExtractionItemRef,
    maxBytes: number | undefined,
  ): Promise<FetchedBytes> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.contentBaseUrl}/files/download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify(dropboxDownloadArg(ref)),
        },
      });
    } catch {
      // The transport never reached Dropbox, so this says nothing about the
      // item. Spelled as the job store spells it, so the janitor's network
      // escape hatch applies to it.
      throw new FileExtractionSourceError('network_unreachable');
    }

    if (!response.ok) throw await downloadFailure(response);

    const declaredSize = parsePositiveInteger(response.headers.get('content-length') ?? undefined);
    // Both checks, not one: the header lets an oversized file be refused
    // before its body is read, and the body check catches a provider that
    // declared nothing or declared wrongly.
    if (maxBytes !== undefined && declaredSize !== undefined && declaredSize > maxBytes) {
      throw new FileExtractionSourceError('source_too_large');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new FileExtractionSourceError('source_too_large');
    }

    const contentType = response.headers.get('content-type');
    return {
      bytes,
      ...(contentType ? { mimeType: contentType } : {}),
      sizeBytes: declaredSize ?? bytes.byteLength,
    };
  }
}

/**
 * Prefer the revision over the path.
 *
 * This is what makes a download reproducible against the exact bytes the job
 * was enqueued for: a path resolves to whatever is there now, a `rev:` resolves
 * to what was there then. Falling back to `providerItemId` rather than the path
 * keeps that property as far as it goes — Dropbox accepts its own `id:` form in
 * the same argument, and an id survives a rename where a path does not.
 */
export function dropboxDownloadArg(ref: ExtractionItemRef): Record<string, string> {
  if (ref.sourceVersion) {
    return {
      path: ref.sourceVersion.startsWith('rev:') ? ref.sourceVersion : `rev:${ref.sourceVersion}`,
    };
  }
  return { path: ref.providerItemId };
}

/**
 * Parse the deployed local-roots JSON. Same env var and same accepted shape as
 * the legacy resolver, including the snake_case spellings, so cutting the lane
 * over to this source is not also a host config change.
 */
export function parseDropboxExtractionLocalRootsFromEnv(
  env: Record<string, string | undefined> = process.env,
): DropboxExtractionLocalRootConfig[] {
  const raw = env[DROPBOX_LOCAL_ROOTS_ENV];
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${DROPBOX_LOCAL_ROOTS_ENV} must be a JSON array.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${DROPBOX_LOCAL_ROOTS_ENV} must be a JSON array.`);
  }
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Dropbox local root ${index} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const rootPath = optionalString(record.rootPath) ?? optionalString(record.root_path);
    if (!rootPath) {
      throw new Error(`Dropbox local root ${index} requires rootPath.`);
    }
    const account = optionalString(record.account);
    const approvedScopeKey = optionalString(record.approvedScopeKey) ?? optionalString(record.approved_scope_key);
    const dropboxPathPrefix = optionalString(record.dropboxPathPrefix) ?? optionalString(record.dropbox_path_prefix);
    const rootId = optionalString(record.rootId) ?? optionalString(record.root_id);
    const root: DropboxExtractionLocalRootConfig = { rootPath };
    if (account) root.account = account;
    if (approvedScopeKey) root.approvedScopeKey = approvedScopeKey;
    if (dropboxPathPrefix) root.dropboxPathPrefix = dropboxPathPrefix;
    if (rootId) root.rootId = rootId;
    return root;
  });
}

/**
 * Longest matching path prefix wins, so a lane nested inside another lane
 * claims its own items. Matching is case-insensitive because Dropbox paths are:
 * the provider keeps `path_lower` for exactly this reason.
 */
function matchScope(
  scopes: readonly ResolvedDropboxExtractionScope[],
  accountScope: string,
  locatorUri: string | undefined,
): ResolvedDropboxExtractionScope | undefined {
  const path = normalizeDropboxPath(locatorUri);
  if (!path) return undefined;
  const lowerPath = path.toLowerCase();
  let best: ResolvedDropboxExtractionScope | undefined;
  for (const scope of scopes) {
    if (scope.account !== accountScope) continue;
    const prefix = scope.pathPrefix.toLowerCase();
    const contains = prefix === '/'
      ? lowerPath.length > 1
      : lowerPath.startsWith(`${prefix}/`);
    if (!contains) continue;
    if (!best || scope.pathPrefix.length > best.pathPrefix.length) best = scope;
  }
  return best;
}

function resolveScope(scope: DropboxExtractionScopeConfig): ResolvedDropboxExtractionScope {
  const approvedScopeKey = scope.approvedScopeKey?.trim();
  if (!approvedScopeKey) {
    throw new Error('Dropbox extraction scope requires an approvedScopeKey.');
  }
  const separator = approvedScopeKey.indexOf(':');
  const parsedAccount = approvedScopeKey.startsWith(DROPBOX_SCOPE_KEY_PROVIDER_PREFIX) && separator > 0
    ? approvedScopeKey.slice(DROPBOX_SCOPE_KEY_PROVIDER_PREFIX.length, separator)
    : undefined;
  const account = scope.account?.trim() || parsedAccount;
  if (!account) {
    throw new Error(`Dropbox extraction scope ${approvedScopeKey} needs an account it cannot parse from its key.`);
  }
  const parsedPath = separator > 0 ? approvedScopeKey.slice(separator + 1) : undefined;
  // A folder_id scope names a folder by id, and an id cannot be prefix-matched
  // against a path. Refusing it at construction is the honest failure: the
  // alternative is a lane that silently enumerates nothing forever.
  const rawPrefix = scope.pathPrefix?.trim()
    || (parsedPath && !parsedPath.startsWith(DROPBOX_FOLDER_ID_SCOPE_PREFIX) ? parsedPath : undefined);
  const pathPrefix = normalizeDropboxPath(rawPrefix);
  if (!pathPrefix) {
    throw new Error(`Dropbox extraction scope ${approvedScopeKey} requires an explicit pathPrefix.`);
  }
  return { approvedScopeKey, account, pathPrefix };
}

function singleAccount(scopes: readonly ResolvedDropboxExtractionScope[]): string | undefined {
  const accounts = new Set(scopes.map((scope) => scope.account));
  return accounts.size === 1 ? [...accounts][0] : undefined;
}

async function readVerifiedCandidate(input: {
  candidatePath: string;
  contentHash: string;
  maxBytes?: number;
  declaredSizeBytes?: number;
}): Promise<Uint8Array | undefined> {
  let fileStat;
  try {
    fileStat = await stat(input.candidatePath);
  } catch {
    return undefined;
  }
  if (!fileStat.isFile()) return undefined;
  if (input.maxBytes !== undefined && fileStat.size > input.maxBytes) {
    throw new FileExtractionSourceError('source_too_large');
  }
  if (input.declaredSizeBytes !== undefined && input.declaredSizeBytes !== fileStat.size) {
    return undefined;
  }

  const bytes = new Uint8Array(await readFile(input.candidatePath));
  if (input.maxBytes !== undefined && bytes.byteLength > input.maxBytes) {
    throw new FileExtractionSourceError('source_too_large');
  }
  // The gate. Bytes whose Dropbox content hash disagrees with the one the job
  // was enqueued for are a different file than the one that was approved, and
  // they fall through to the provider rather than being handed up.
  if (computeDropboxContentHash(bytes) !== input.contentHash) return undefined;
  return bytes;
}

function normalizeRootConfig(
  root: DropboxExtractionLocalRootConfig,
): DropboxExtractionLocalRootConfig | undefined {
  const rootPath = root.rootPath.trim();
  if (!rootPath) return undefined;
  const normalized: DropboxExtractionLocalRootConfig = { rootPath };
  if (root.account?.trim()) normalized.account = root.account.trim();
  if (root.approvedScopeKey?.trim()) normalized.approvedScopeKey = root.approvedScopeKey.trim();
  const dropboxPathPrefix = normalizeDropboxPath(root.dropboxPathPrefix ?? '/');
  if (dropboxPathPrefix) normalized.dropboxPathPrefix = dropboxPathPrefix;
  if (root.rootId?.trim()) normalized.rootId = root.rootId.trim();
  return normalized;
}

function rootMatchesRef(root: DropboxExtractionLocalRootConfig, ref: ExtractionItemRef): boolean {
  if (root.account && root.account !== ref.accountScope) return false;
  if (root.approvedScopeKey && root.approvedScopeKey !== ref.approvedScopeKey) return false;
  return true;
}

function dropboxRelativePath(prefix: string | undefined, dropboxPath: string | undefined): string | undefined {
  const normalizedPath = normalizeDropboxPath(dropboxPath);
  if (!normalizedPath) return undefined;
  const normalizedPrefix = normalizeDropboxPath(prefix ?? '/');
  if (!normalizedPrefix || normalizedPrefix === '/') {
    return normalizedPath.slice(1);
  }
  if (normalizedPath.toLowerCase() === normalizedPrefix.toLowerCase()) {
    return undefined;
  }
  if (!normalizedPath.toLowerCase().startsWith(`${normalizedPrefix.toLowerCase()}/`)) {
    return undefined;
  }
  return normalizedPath.slice(normalizedPrefix.length + 1);
}

function normalizeDropboxPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!trimmed) return undefined;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Map the provider's status onto a bounded kind, and fingerprint the failure
 * without keeping it. The response body is read only to be hashed: a Dropbox
 * error body is free-form provider text, which the job store may not hold.
 */
async function downloadFailure(response: Response): Promise<FileExtractionSourceError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, MAX_PROVIDER_DETAIL_CHARS);
  } catch {
    detail = '';
  }
  const options = { detailForHash: `${response.status}:${detail}` };
  if (response.status === 401) return new FileExtractionSourceError('source_auth_expired', options);
  if (response.status === 403) return new FileExtractionSourceError('source_permission_denied', options);
  if (response.status === 429) return new FileExtractionSourceError('source_rate_limited', options);
  // 409 is how the Dropbox content endpoints report an endpoint-specific
  // error, and for `files/download` that is a path or rev that no longer
  // resolves. Terminal either way: the same request will fail the same way.
  if (response.status === 404 || response.status === 409) {
    return new FileExtractionSourceError('source_item_not_found', options);
  }
  if (response.status >= 500) return new FileExtractionSourceError('source_unavailable', options);
  if (response.status >= 400) return new FileExtractionSourceError('source_request_rejected', options);
  return new FileExtractionSourceError('source_unavailable', options);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}
