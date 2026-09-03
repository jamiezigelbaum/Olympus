// Dropbox provider primitives used by the thin SourceConnector.
//
// This module is deliberately independent of the grandfathered Dropbox index,
// crawl frontier, extraction queue, and answer runtime. Normal product startup
// can therefore use the provider without loading either legacy monolith.

import type { CredentialBrokerFetch } from '../credential-broker/index.ts';

/** Bounded retries for the statuses Dropbox uses to say "slow down". */
const DEFAULT_DROPBOX_MAX_RETRIES = 3;
const MAX_DROPBOX_RETRY_DELAY_MS = 30_000;

export interface DropboxMetadataPage {
  entries: DropboxMetadataEntry[];
  cursor?: string;
  hasMore?: boolean;
}

export type DropboxMetadataEntry = DropboxFileMetadataEntry | DropboxFolderMetadataEntry | DropboxDeletedMetadataEntry;

export interface DropboxFileMetadataEntry {
  tag: 'file';
  id: string;
  name: string;
  pathDisplay?: string;
  pathLower?: string;
  rev?: string;
  contentHash?: string;
  size?: number;
  clientModified?: string;
  serverModified?: string;
  mimeType?: string;
  sharingInfo?: DropboxSharingInfo;
}

export interface DropboxFolderMetadataEntry {
  tag: 'folder';
  id: string;
  name: string;
  pathDisplay?: string;
  pathLower?: string;
  sharingInfo?: DropboxSharingInfo;
}

export interface DropboxDeletedMetadataEntry {
  tag: 'deleted';
  name: string;
  pathDisplay?: string;
  pathLower?: string;
  id?: string;
}

export interface DropboxSharingInfo {
  sharedFolderId?: string;
  parentSharedFolderId?: string;
  namespaceId?: string;
}

export interface DropboxMetadataListRequest {
  path: string;
  recursive: boolean;
  limit: number;
  includeDeleted?: boolean;
}

export interface DropboxMetadataContinueRequest {
  cursor: string;
  limit: number;
}

export interface DropboxMetadataClient {
  readonly supportsNativeRecursive?: boolean;
  listFolder(request: DropboxMetadataListRequest): Promise<DropboxMetadataPage>;
  listFolderContinue(request: DropboxMetadataContinueRequest): Promise<DropboxMetadataPage>;
}

/**
 * A Dropbox API request that failed with a status and, when the provider
 * published one, its own error tag. Carrying both lets a caller classify the
 * failure without parsing the message — the only way to keep provider text,
 * which can name real folders, out of anything durable.
 */
export class DropboxApiError extends Error {
  readonly status: number;
  readonly tag: string | undefined;

  constructor(message: string, status: number, tag?: string) {
    super(message);
    this.name = 'DropboxApiError';
    this.status = status;
    this.tag = tag;
  }
}

/**
 * The provider invalidated the continuation cursor (409 `reset`).
 *
 * This is the one metadata failure a retry can never fix and the one the
 * caller MUST act on: the durable checkpoint is dead, so the traversal has to
 * restart from the beginning or the lane repeats this failure forever.
 */
export class DropboxCursorResetError extends DropboxApiError {
  readonly kind = 'dropbox_cursor_reset';

  constructor(status = 409) {
    super(
      `Dropbox metadata cursor was reset by the provider (${status}/reset); the traversal must restart.`,
      status,
      'reset',
    );
    this.name = 'DropboxCursorResetError';
  }
}

/**
 * Provider back-pressure (429), carrying the wait it asked for. The message
 * says "rate limited" deliberately: the shared scheduler classifies a failed
 * task from the message alone, and a bare "request failed (429)" was
 * indistinguishable from a broken lane.
 */
export class DropboxRateLimitError extends DropboxApiError {
  readonly kind = 'dropbox_rate_limited';
  readonly retryAfterMs: number | undefined;

  constructor(options: { status?: number; retryAfterMs?: number; tag?: string } = {}) {
    const status = options.status ?? 429;
    super(
      `Dropbox metadata API rate limited (${status})`
      + (options.retryAfterMs !== undefined
        ? `; retry after ${Math.ceil(options.retryAfterMs / 1_000)}s.`
        : '.'),
      status,
      options.tag,
    );
    this.name = 'DropboxRateLimitError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Duck-typed so a second module instance still classifies correctly. */
export function isDropboxCursorResetError(error: unknown): boolean {
  return dropboxErrorKind(error) === 'dropbox_cursor_reset';
}

export function isDropboxRateLimitError(error: unknown): boolean {
  return dropboxErrorKind(error) === 'dropbox_rate_limited';
}

export interface DropboxApiMetadataClientOptions {
  token: string;
  fetch?: CredentialBrokerFetch;
  baseUrl?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class DropboxApiMetadataClient implements DropboxMetadataClient {
  readonly supportsNativeRecursive = true;

  private readonly token: string;
  private readonly fetchImpl: CredentialBrokerFetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DropboxApiMetadataClientOptions) {
    this.token = required(options.token, 'Dropbox metadata token');
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, '') || 'https://api.dropboxapi.com/2';
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_DROPBOX_MAX_RETRIES));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listFolder(request: DropboxMetadataListRequest): Promise<DropboxMetadataPage> {
    return this.postMetadataPage('/files/list_folder', {
      path: request.path,
      recursive: request.recursive,
      limit: request.limit,
      include_deleted: request.includeDeleted === true,
      include_has_explicit_shared_members: false,
    });
  }

  async listFolderContinue(request: DropboxMetadataContinueRequest): Promise<DropboxMetadataPage> {
    return this.postMetadataPage('/files/list_folder/continue', { cursor: request.cursor });
  }

  private async postMetadataPage(path: string, body: Record<string, unknown>): Promise<DropboxMetadataPage> {
    const response = await this.send(path, body);
    const text = await response.text();
    return metadataPageFromDropboxJson(parseJsonObject(text, 'Dropbox metadata API'));
  }

  /**
   * The request and its bounded retries, and nothing about the body.
   *
   * Every failure is read for the provider's own error tag before it is
   * discarded. Throwing a bare Error here was what wedged the lane: a 409
   * `reset` — the provider saying "this cursor is dead" — arrived at the sync
   * layer indistinguishable from a transient failure, so the same dead cursor
   * was resumed on every later pull.
   */
  private async send(path: string, body: Record<string, unknown>): Promise<Response> {
    let attempt = 0;
    while (true) {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (response.ok) return response;
      // Drained on every failed attempt, retried or not, so a discarded
      // response never holds its connection open.
      const detail = await response.text().catch(() => '');
      const error = dropboxMetadataError(response, detail);
      if (isRetryableDropboxError(error) && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(dropboxRetryDelayMs(error, attempt));
        continue;
      }
      throw error;
    }
  }
}

function dropboxMetadataError(response: Response, detail: string): DropboxApiError {
  const tag = dropboxErrorTag(detail);
  // A `reset` tag is Dropbox's closed-vocabulary word for an invalidated
  // list_folder cursor. It arrives as a 409; any other 4xx carrying it means
  // the same thing and is treated the same way.
  if (tag === 'reset' && response.status >= 400 && response.status < 500) {
    return new DropboxCursorResetError(response.status);
  }
  if (response.status === 429) {
    const retryAfterMs = dropboxRetryAfterMs(response);
    return new DropboxRateLimitError({
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(tag ? { tag } : {}),
    });
  }
  return new DropboxApiError(
    `Dropbox metadata API request failed (${response.status}${tag ? `/${tag}` : ''}).`,
    response.status,
    tag,
  );
}

function isRetryableDropboxError(error: DropboxApiError): boolean {
  // Deliberately status-shaped, which also keeps a cursor reset out: replaying
  // a dead cursor produces the same 409, and only the sync layer can fix it.
  return error.status === 429 || (error.status >= 500 && error.status < 600);
}

function dropboxRetryDelayMs(error: DropboxApiError, attempt: number): number {
  const declared = error instanceof DropboxRateLimitError ? error.retryAfterMs : undefined;
  if (declared !== undefined) return Math.min(declared, MAX_DROPBOX_RETRY_DELAY_MS);
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 5_000);
}

function dropboxRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * The provider's error tag, and nothing else from the body. Dropbox error
 * payloads can carry user-facing text naming real folders, so only a bounded
 * lowercase token crosses this boundary.
 */
function dropboxErrorTag(detail: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const error = record.error;
  const nested = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>)['.tag']
    : undefined;
  const summary = typeof record.error_summary === 'string'
    ? record.error_summary.split('/')[0]
    : undefined;
  return boundedErrorTag(nested) ?? boundedErrorTag(summary);
}

function boundedErrorTag(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function dropboxErrorKind(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = (error as { kind?: unknown }).kind;
  return typeof candidate === 'string' ? candidate : undefined;
}

export interface DropboxContentDownloadRequest {
  job: {
    provider_file_id: string;
    revision?: string;
  };
  max_bytes_per_file?: number;
}

export interface DropboxContentDownloadResult {
  bytes: Uint8Array;
  mime_type?: string;
  size_bytes?: number;
}

export interface DropboxContentDownloadClient {
  download(request: DropboxContentDownloadRequest): Promise<DropboxContentDownloadResult>;
}

export interface DropboxApiContentDownloadClientOptions {
  token: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  contentBaseUrl?: string;
}

export class DropboxContentTooLargeError extends Error {
  readonly kind = 'dropbox_content_too_large';

  constructor(message = 'Dropbox content exceeds the approved byte cap.') {
    super(message);
    this.name = 'DropboxContentTooLargeError';
  }
}

export class DropboxApiContentDownloadClient implements DropboxContentDownloadClient {
  private readonly token: string;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly contentBaseUrl: string;

  constructor(options: DropboxApiContentDownloadClientOptions) {
    this.token = required(options.token, 'Dropbox content token');
    this.fetchImpl = options.fetch ?? fetch;
    this.contentBaseUrl = options.contentBaseUrl?.replace(/\/+$/, '') || 'https://content.dropboxapi.com/2';
  }

  async download(request: DropboxContentDownloadRequest): Promise<DropboxContentDownloadResult> {
    const response = await this.fetchImpl(`${this.contentBaseUrl}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Dropbox-API-Arg': JSON.stringify(dropboxDownloadArg(request.job)),
      },
    });
    if (!response.ok) throw new Error(`Dropbox content API request failed (${response.status}).`);
    const declaredSize = parsePositiveInteger(response.headers.get('content-length') ?? undefined);
    if (
      request.max_bytes_per_file !== undefined
      && declaredSize !== undefined
      && declaredSize > request.max_bytes_per_file
    ) {
      throw new DropboxContentTooLargeError();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (request.max_bytes_per_file !== undefined && bytes.byteLength > request.max_bytes_per_file) {
      throw new DropboxContentTooLargeError();
    }
    const mimeType = response.headers.get('content-type');
    return {
      bytes,
      ...(mimeType ? { mime_type: mimeType } : {}),
      size_bytes: declaredSize ?? bytes.byteLength,
    };
  }
}

export function dropboxMimeTypeFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return undefined;
}

function metadataPageFromDropboxJson(payload: Record<string, unknown>): DropboxMetadataPage {
  if (!Array.isArray(payload.entries)) {
    throw new Error('Dropbox metadata API page did not include entries.');
  }
  return {
    entries: payload.entries
      .map(metadataEntryFromDropboxJson)
      .filter((entry): entry is DropboxMetadataEntry => entry !== undefined),
    ...(typeof payload.cursor === 'string' && payload.cursor.trim()
      ? { cursor: payload.cursor.trim() }
      : {}),
    hasMore: payload.has_more === true,
  };
}

function metadataEntryFromDropboxJson(value: unknown): DropboxMetadataEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tag = normalizedTag(stringValue(record['.tag']) ?? stringValue(record.tag));
  const name = stringValue(record.name) ?? '';
  const pathDisplay = stringValue(record.path_display) ?? stringValue(record.pathDisplay);
  const pathLower = stringValue(record.path_lower) ?? stringValue(record.pathLower);
  if (tag === 'deleted') {
    const id = stringValue(record.id);
    return {
      tag,
      name,
      ...(pathDisplay ? { pathDisplay } : {}),
      ...(pathLower ? { pathLower } : {}),
      ...(id ? { id } : {}),
    };
  }
  const id = stringValue(record.id);
  if (!id || (tag !== 'file' && tag !== 'folder')) return undefined;
  const sharingInfo = sharingInfoFromDropboxJson(record);
  if (tag === 'folder') {
    return {
      tag,
      id,
      name,
      ...(pathDisplay ? { pathDisplay } : {}),
      ...(pathLower ? { pathLower } : {}),
      ...(sharingInfo ? { sharingInfo } : {}),
    };
  }
  const size = numberValue(record.size);
  const rev = stringValue(record.rev);
  const contentHash = stringValue(record.content_hash) ?? stringValue(record.contentHash);
  const clientModified = stringValue(record.client_modified) ?? stringValue(record.clientModified);
  const serverModified = stringValue(record.server_modified) ?? stringValue(record.serverModified);
  const mimeType = stringValue(record.mime_type) ?? stringValue(record.mimeType);
  return {
    tag,
    id,
    name,
    ...(pathDisplay ? { pathDisplay } : {}),
    ...(pathLower ? { pathLower } : {}),
    ...(rev ? { rev } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(clientModified ? { clientModified } : {}),
    ...(serverModified ? { serverModified } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sharingInfo ? { sharingInfo } : {}),
  };
}

function sharingInfoFromDropboxJson(record: Record<string, unknown>): DropboxSharingInfo | undefined {
  const value = record.sharing_info ?? record.sharingInfo;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const sharing = value as Record<string, unknown>;
  const sharedFolderId = stringValue(sharing.shared_folder_id) ?? stringValue(sharing.sharedFolderId);
  const parentSharedFolderId = stringValue(sharing.parent_shared_folder_id) ?? stringValue(sharing.parentSharedFolderId);
  const namespaceId = stringValue(sharing.namespace_id) ?? stringValue(sharing.namespaceId);
  return sharedFolderId || parentSharedFolderId || namespaceId
    ? {
        ...(sharedFolderId ? { sharedFolderId } : {}),
        ...(parentSharedFolderId ? { parentSharedFolderId } : {}),
        ...(namespaceId ? { namespaceId } : {}),
      }
    : undefined;
}

function dropboxDownloadArg(job: DropboxContentDownloadRequest['job']): Record<string, string> {
  if (job.revision) {
    return { path: job.revision.startsWith('rev:') ? job.revision : `rev:${job.revision}` };
  }
  return { path: job.provider_file_id };
}

function normalizedTag(value: string | undefined): DropboxMetadataEntry['tag'] | undefined {
  return value === 'file' || value === 'folder' || value === 'deleted' ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned a non-object JSON payload.`);
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
