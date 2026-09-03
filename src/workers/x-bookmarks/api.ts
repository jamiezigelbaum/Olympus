export const X_API_V2_BASE_URL = 'https://api.x.com/2';

export type XBookmarksFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

export interface XApiClientOptions {
  token: string;
  userId: string;
  fetch?: XBookmarksFetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface XBookmarkFolder {
  id: string;
  name: string;
}

export interface XBookmarkPost {
  id: string;
  text?: string;
  authorId?: string;
  authorUsername?: string;
  authorName?: string;
  createdAt?: string;
  lang?: string;
  url?: string;
  mediaUrls?: string[];
  /** Private acquisition identity used only for conservative usage accounting. */
  mediaKeys?: string[];
  sourceVersion?: string;
}

export interface XBookmarkFolderPage {
  folders: XBookmarkFolder[];
  nextToken?: string;
  rateLimit?: XApiRateLimit;
}

export interface XBookmarkPostPage {
  posts: XBookmarkPost[];
  nextToken?: string;
  rateLimit?: XApiRateLimit;
}

export interface XBookmarkPostLookupResult {
  posts: XBookmarkPost[];
  unavailableCount: number;
  rateLimit?: XApiRateLimit;
}

export interface XBookmarkPageRequest {
  maxResults?: number;
  paginationToken?: string;
  /** ID-only probe used by the 30-second head lane. */
  headOnly?: boolean;
  /** Fail-closed parsing used by deletion-authoritative snapshot traversals. */
  strictSnapshot?: boolean;
}

export interface XApiRateLimit {
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

export interface XApiProviderError {
  /** Provider-owned machine-readable problem type; never the response body. */
  type?: string;
  /** Provider-owned bounded problem title; detail/message fields are excluded. */
  title?: string;
  /** Provider-owned machine-readable error code normalized to a string. */
  code?: string;
}

export class XApiError extends Error {
  status?: number;
  rateLimit?: XApiRateLimit;
  providerErrorType?: string;
  providerErrorTitle?: string;
  providerErrorCode?: string;

  constructor(
    message: string,
    status?: number,
    rateLimit?: XApiRateLimit,
    providerError: XApiProviderError = {},
  ) {
    super(message);
    this.name = 'XApiError';
    if (status !== undefined) this.status = status;
    if (rateLimit && Object.keys(rateLimit).length > 0) this.rateLimit = rateLimit;
    if (providerError.type) this.providerErrorType = providerError.type;
    if (providerError.title) this.providerErrorTitle = providerError.title;
    if (providerError.code) this.providerErrorCode = providerError.code;
  }
}

export class XApiClient {
  private readonly token: string;
  private readonly userId: string;
  private readonly fetchImpl: XBookmarksFetch;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(options: XApiClientOptions) {
    const token = options.token.trim();
    if (!token) throw new Error('X API token is required.');
    const userId = options.userId.trim();
    if (!userId) throw new Error('X API user id is required.');

    this.token = token;
    this.userId = userId;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? X_API_V2_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async fetchBookmarkFolders(request: XBookmarkPageRequest = {}): Promise<XBookmarkFolderPage> {
    const response = await this.getJson(`/users/${encodeURIComponent(this.userId)}/bookmarks/folders`, {
      max_results: normalizePageSize(request.maxResults),
      ...(request.paginationToken ? { pagination_token: request.paginationToken } : {}),
    }, 'X bookmark folders request');
    const folderRecords = payloadDataRecords(
      response.payload,
      'X bookmark folders response',
      request.strictSnapshot === true,
    );
    return {
      folders: folderRecords.map(folderFromRecord),
      ...nextTokenFromPayload(response.payload),
      ...optionalRateLimit(response.rateLimit),
    };
  }

  async fetchBookmarks(request: XBookmarkPageRequest = {}): Promise<XBookmarkPostPage> {
    return this.fetchBookmarkPath(`/users/${encodeURIComponent(this.userId)}/bookmarks`, request);
  }

  async fetchBookmarksInFolder(folderId: string, request: XBookmarkPageRequest = {}): Promise<XBookmarkPostPage> {
    const id = folderId.trim();
    if (!id) throw new Error('X bookmark folder id is required.');
    const response = await this.getJson(
      `/users/${encodeURIComponent(this.userId)}/bookmarks/folders/${encodeURIComponent(id)}`,
      {
        max_results: normalizePageSize(request.maxResults),
        ...(request.paginationToken ? { pagination_token: request.paginationToken } : {}),
      },
      'X bookmark folder posts request',
    );
    return {
      posts: postsFromPayload(response.payload, request.strictSnapshot === true),
      ...nextTokenFromPayload(response.payload),
      ...optionalRateLimit(response.rateLimit),
    };
  }

  async fetchPostsByIds(postIds: readonly string[]): Promise<XBookmarkPostLookupResult> {
    const ids = [...new Set(postIds.map((value) => value.trim()).filter(Boolean))];
    if (ids.length < 1 || ids.length > 100 || ids.some((id) => !/^\d{1,32}$/.test(id))) {
      throw new TypeError('X post lookup requires between 1 and 100 numeric post ids.');
    }
    const response = await this.getJson('/tweets', {
      ids: ids.join(','),
      'tweet.fields': 'id,text,author_id,created_at,lang,attachments,entities,conversation_id,referenced_tweets,possibly_sensitive,public_metrics',
      expansions: 'author_id,attachments.media_keys',
      'user.fields': 'id,name,username',
      'media.fields': 'media_key,type,url,preview_image_url,alt_text',
    }, 'X post content lookup');
    const posts = postsFromPayload(response.payload);
    const requested = new Set(ids);
    if (posts.some((post) => !requested.has(post.id))
      || new Set(posts.map((post) => post.id)).size !== posts.length) {
      throw new XApiError('X post content lookup returned an invalid identity set.');
    }
    return {
      posts,
      unavailableCount: ids.length - posts.length,
      ...optionalRateLimit(response.rateLimit),
    };
  }

  private async fetchBookmarkPath(path: string, request: XBookmarkPageRequest): Promise<XBookmarkPostPage> {
    const richFields = request.headOnly === true ? {} : {
      'tweet.fields': 'id,text,author_id,created_at,lang,attachments,entities,conversation_id,referenced_tweets,possibly_sensitive,public_metrics',
      expansions: 'author_id,attachments.media_keys',
      'user.fields': 'id,name,username',
      'media.fields': 'media_key,type,url,preview_image_url,alt_text',
    };
    const response = await this.getJson(path, {
      max_results: normalizePageSize(request.maxResults),
      ...(request.paginationToken ? { pagination_token: request.paginationToken } : {}),
      ...richFields,
    }, 'X bookmarks request');
    return {
      posts: postsFromPayload(response.payload, request.strictSnapshot === true),
      ...nextTokenFromPayload(response.payload),
      ...optionalRateLimit(response.rateLimit),
    };
  }

  private async getJson(
    path: string,
    params: Record<string, string | number>,
    context: string,
  ): Promise<{ payload: Record<string, unknown>; rateLimit?: XApiRateLimit }> {
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const rateLimit = rateLimitFromHeaders(response.headers);
      if (!response.ok) {
        const providerError = providerErrorFromResponseBody(text, this.token);
        throw new XApiError(
          `${context} failed (${response.status}).`,
          response.status,
          rateLimit,
          providerError,
        );
      }
      return {
        payload: parseJsonObject(text, context),
        ...optionalRateLimit(rateLimit),
      };
    } catch (error) {
      if (error instanceof XApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new XApiError(`${context} timed out.`);
      }
      // Never let fetch implementation details, local paths, or credential
      // material escape into scheduler telemetry.
      throw new XApiError(`${context} network request failed.`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function rateLimitFromHeaders(headers: Headers): XApiRateLimit | undefined {
  const limit = nonNegativeHeaderInteger(headers.get('x-rate-limit-limit'));
  const remaining = nonNegativeHeaderInteger(headers.get('x-rate-limit-remaining'));
  const resetSeconds = nonNegativeHeaderInteger(headers.get('x-rate-limit-reset'));
  const rateLimit: XApiRateLimit = {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetSeconds !== undefined ? { resetAt: new Date(resetSeconds * 1_000).toISOString() } : {}),
  };
  return Object.keys(rateLimit).length > 0 ? rateLimit : undefined;
}

function nonNegativeHeaderInteger(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalRateLimit(rateLimit: XApiRateLimit | undefined): { rateLimit?: XApiRateLimit } {
  return rateLimit && Object.keys(rateLimit).length > 0 ? { rateLimit } : {};
}

function postsFromPayload(payload: Record<string, unknown>, strictSnapshot = false): XBookmarkPost[] {
  const usersById = new Map<string, Record<string, unknown>>();
  const mediaByKey = new Map<string, Record<string, unknown>>();
  const includes = recordAt(payload, 'includes');
  if (includes) {
    for (const user of recordArray(includes.users, 'X bookmarks users include')) {
      const id = optionalIdString(user.id);
      if (!id) throw new XApiError('X bookmarks users include contains a malformed identity.');
      usersById.set(id, user);
    }
    for (const media of recordArray(includes.media, 'X bookmarks media include')) {
      const key = optionalString(media.media_key);
      if (!key) throw new XApiError('X bookmarks media include contains a malformed identity.');
      mediaByKey.set(key, media);
    }
  }

  return payloadDataRecords(payload, 'X bookmarks response', strictSnapshot)
    .map((post) => postFromRecord(post, usersById, mediaByKey));
}

function postFromRecord(
  post: Record<string, unknown>,
  usersById: Map<string, Record<string, unknown>>,
  mediaByKey: Map<string, Record<string, unknown>>,
): XBookmarkPost {
  const id = optionalIdString(post.id);
  if (!id) throw new XApiError('X bookmarks response contains a malformed post row.');
  const authorId = optionalIdString(post.author_id);
  const author = authorId ? usersById.get(authorId) : undefined;
  const mediaKeys = mediaKeysFromPost(post);
  const mediaUrls = mediaKeys.flatMap((key) => mediaUrlsFromRecord(mediaByKey.get(key))).filter(Boolean);
  const createdAt = optionalString(post.created_at);
  const text = optionalString(post.text);
  const authorUsername = author ? optionalString(author.username) : undefined;
  const authorName = author ? optionalString(author.name) : undefined;
  const lang = optionalString(post.lang);
  return {
    id,
    ...(text ? { text } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorUsername ? { authorUsername } : {}),
    ...(authorName ? { authorName } : {}),
    ...(createdAt ? { createdAt, sourceVersion: createdAt } : {}),
    ...(lang ? { lang } : {}),
    url: `https://x.com/i/web/status/${id}`,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(mediaKeys.length > 0 ? { mediaKeys } : {}),
  };
}

function folderFromRecord(record: Record<string, unknown>): XBookmarkFolder {
  const id = optionalIdString(record.id);
  const name = optionalString(record.name);
  if (!id || !name) throw new XApiError('X bookmark folders response contains a malformed folder row.');
  return { id, name };
}

function mediaKeysFromPost(post: Record<string, unknown>): string[] {
  const attachments = recordAt(post, 'attachments');
  if (!attachments || !Array.isArray(attachments.media_keys)) return [];
  return attachments.media_keys
    .map((item) => optionalString(item))
    .filter((item): item is string => !!item);
}

function mediaUrlsFromRecord(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  return [
    optionalString(record.url),
    optionalString(record.preview_image_url),
  ].filter((item): item is string => !!item);
}

export function xBookmarkPostResourceIds(posts: readonly XBookmarkPost[]): string[] {
  const resources: string[] = [];
  for (const post of posts) {
    resources.push(`post:${post.id}`);
    if (post.authorId?.trim()) resources.push(`author:${post.authorId.trim()}`);
    else if (post.authorUsername?.trim()) resources.push(`author-username:${post.authorUsername.trim()}`);
    for (const mediaKey of post.mediaKeys ?? []) {
      if (mediaKey.trim()) resources.push(`media:${mediaKey.trim()}`);
    }
    if (!post.mediaKeys?.length) {
      for (const mediaUrl of post.mediaUrls ?? []) {
        if (mediaUrl.trim()) resources.push(`media-url:${mediaUrl.trim()}`);
      }
    }
  }
  return [...new Set(resources)];
}

function nextTokenFromPayload(payload: Record<string, unknown>): Pick<XBookmarkFolderPage | XBookmarkPostPage, 'nextToken'> {
  const meta = recordAt(payload, 'meta');
  const nextToken = meta ? optionalString(meta.next_token) : undefined;
  return nextToken ? { nextToken } : {};
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(Math.floor(value), 100));
}

function normalizeBaseUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('X API base URL must be non-empty.');
  return new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
}

function parseJsonObject(text: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new XApiError(`${context} returned invalid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new XApiError(`${context} did not return a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordArray(value: unknown, context: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new XApiError(`${context} is not an array.`);
  if (value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new XApiError(`${context} contains a malformed row.`);
  }
  return value as Record<string, unknown>[];
}

function payloadDataRecords(
  payload: Record<string, unknown>,
  context: string,
  strictSnapshot: boolean,
): Record<string, unknown>[] {
  const meta = recordAt(payload, 'meta');
  if (strictSnapshot && !meta) {
    throw new XApiError(`${context} is missing snapshot pagination metadata.`);
  }
  const resultCount = meta?.result_count;
  if (strictSnapshot && (!Number.isSafeInteger(resultCount) || (resultCount as number) < 0)) {
    throw new XApiError(`${context} has invalid snapshot result_count metadata.`);
  }
  if (strictSnapshot && meta && Object.prototype.hasOwnProperty.call(meta, 'next_token')
    && meta.next_token !== undefined
    && (typeof meta.next_token !== 'string' || !meta.next_token.trim())) {
    throw new XApiError(`${context} has invalid snapshot next_token metadata.`);
  }
  if ((payload.data === undefined || payload.data === null)
    && strictSnapshot && resultCount !== 0) {
    throw new XApiError(`${context} is missing snapshot data rows.`);
  }
  const rows = recordArray(payload.data, `${context} data`);
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'result_count')) {
    if (!Number.isSafeInteger(resultCount)
      || (resultCount as number) < 0
      || resultCount !== rows.length) {
      throw new XApiError(`${context} result count does not match its data rows.`);
    }
  }
  return rows;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalIdString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function providerErrorFromResponseBody(text: string, token: string): XApiProviderError {
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const root = parsed as Record<string, unknown>;
  const nestedError = recordAt(root, 'error');
  const firstError = Array.isArray(root.errors)
    && root.errors[0]
    && typeof root.errors[0] === 'object'
    && !Array.isArray(root.errors[0])
    ? root.errors[0] as Record<string, unknown>
    : undefined;
  const type = sanitizedProviderErrorText(
    root.type ?? nestedError?.type ?? firstError?.type,
    token,
    512,
  );
  const title = sanitizedProviderErrorText(
    root.title ?? nestedError?.title ?? firstError?.title,
    token,
    160,
  );
  const code = sanitizedProviderErrorCode(
    root.code ?? nestedError?.code ?? firstError?.code,
    token,
  );
  return {
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    ...(code ? { code } : {}),
  };
}

function sanitizedProviderErrorText(
  value: unknown,
  token: string,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value
    .replaceAll(token, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return sanitized || undefined;
}

function sanitizedProviderErrorCode(value: unknown, token: string): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return sanitizedProviderErrorText(value, token, 160);
}
