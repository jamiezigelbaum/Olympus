export const READWISE_API_V2_BASE_URL = 'https://readwise.io/api/v2/';
export const READWISE_READER_API_V3_BASE_URL = 'https://readwise.io/api/v3/';

const DEFAULT_TIMEOUT_MS = 30_000;

export type ReadwiseFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReadwiseApiClientOptions {
  token: string;
  fetch?: ReadwiseFetch;
  apiV2BaseUrl?: string;
  readerApiV3BaseUrl?: string;
  timeoutMs?: number;
}

export interface ReadwiseReaderListRequest {
  documentId?: string;
  updatedAfter?: string;
  location?: string;
  category?: string;
  pageCursor?: string;
  limit?: number;
  withHtmlContent?: boolean;
  withRawSourceUrl?: boolean;
}

export interface ReadwiseReaderDocumentPage {
  count: number;
  nextPageCursor?: string;
  results: ReadwiseReaderDocument[];
}

export interface ReadwiseReaderFetchRequest extends Omit<ReadwiseReaderListRequest, 'pageCursor' | 'limit'> {
  pageLimit?: number;
  maxDocuments?: number;
}

export interface ReadwiseReaderFetchResult {
  documents: ReadwiseReaderDocument[];
  requestCount: number;
}

export interface ReadwiseExportRequest {
  updatedAfter?: string;
  pageCursor?: string;
}

export interface ReadwiseExportBookPage {
  nextPageCursor?: string;
  results: ReadwiseExportBook[];
}

export interface ReadwiseExportFetchRequest extends Omit<ReadwiseExportRequest, 'pageCursor'> {
  maxPages?: number;
}

export interface ReadwiseExportFetchResult {
  books: ReadwiseExportBook[];
  requestCount: number;
  nextPageCursor?: string;
  pageLimitReached: boolean;
}

export type ReadwiseReaderDocument = Record<string, unknown>;
export type ReadwiseExportBook = Record<string, unknown>;
export type ReadwiseExportHighlight = Record<string, unknown>;

export class ReadwiseApiError extends Error {
  status?: number;
  retryAfter?: string;

  constructor(message: string, options: { status?: number; retryAfter?: string } = {}) {
    super(message);
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

export class ReadwiseApiClient {
  private token: string;
  private fetchImpl: ReadwiseFetch;
  private apiV2BaseUrl: string;
  private readerApiV3BaseUrl: string;
  private timeoutMs: number;

  constructor(options: ReadwiseApiClientOptions) {
    const token = options.token.trim();
    if (!token) throw new Error('Readwise API token is required.');
    this.token = token;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiV2BaseUrl = normalizeBaseUrl(options.apiV2BaseUrl ?? READWISE_API_V2_BASE_URL);
    this.readerApiV3BaseUrl = normalizeBaseUrl(options.readerApiV3BaseUrl ?? READWISE_READER_API_V3_BASE_URL);
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  }

  async verifyToken(): Promise<void> {
    const response = await this.request('auth/', { baseUrl: this.apiV2BaseUrl });
    if (response.status !== 204) {
      throw await errorFromResponse(response, 'Readwise auth check failed');
    }
  }

  async listReaderDocuments(request: ReadwiseReaderListRequest = {}): Promise<ReadwiseReaderDocumentPage> {
    const limit = normalizeReaderPageLimit(request.limit);
    const params = new URLSearchParams({ limit: String(limit) });
    appendParam(params, 'id', request.documentId);
    appendParam(params, 'updatedAfter', request.updatedAfter);
    appendParam(params, 'location', request.location);
    appendParam(params, 'category', request.category);
    appendParam(params, 'pageCursor', request.pageCursor);
    if (request.withHtmlContent === true) params.set('withHtmlContent', 'true');
    if (request.withRawSourceUrl === true) params.set('withRawSourceUrl', 'true');

    const payload = await this.requestJson(`list/?${params.toString()}`, {
      baseUrl: this.readerApiV3BaseUrl,
      context: 'Readwise Reader list request',
    });
    const record = requireRecord(payload, 'Readwise Reader list response');
    const results = requireRecordArray(record.results, 'Readwise Reader list response results');
    const count = optionalNumber(record.count) ?? results.length;
    const nextPageCursor = optionalString(record.nextPageCursor);
    return {
      count,
      ...(nextPageCursor ? { nextPageCursor } : {}),
      results,
    };
  }

  async fetchReaderDocuments(request: ReadwiseReaderFetchRequest = {}): Promise<ReadwiseReaderFetchResult> {
    const maxDocuments = normalizeOptionalPositiveInteger(request.maxDocuments, 'maxDocuments');
    const pageLimit = normalizeReaderPageLimit(request.pageLimit);
    const documents: ReadwiseReaderDocument[] = [];
    let pageCursor: string | undefined;
    let requestCount = 0;

    while (maxDocuments === undefined || documents.length < maxDocuments) {
      const remaining = maxDocuments === undefined ? pageLimit : Math.min(pageLimit, maxDocuments - documents.length);
      if (remaining <= 0) break;
      const page = await this.listReaderDocuments({
        ...request,
        limit: remaining,
        ...(pageCursor ? { pageCursor } : {}),
      });
      requestCount += 1;
      documents.push(...page.results);
      if (!page.nextPageCursor) break;
      pageCursor = page.nextPageCursor;
    }

    return { documents, requestCount };
  }

  async exportBooks(request: ReadwiseExportRequest = {}): Promise<ReadwiseExportBookPage> {
    const params = new URLSearchParams();
    appendParam(params, 'updatedAfter', request.updatedAfter);
    appendParam(params, 'pageCursor', request.pageCursor);
    const query = params.toString();
    const suffix = query ? `export/?${query}` : 'export/';
    const payload = await this.requestJson(suffix, {
      baseUrl: this.apiV2BaseUrl,
      context: 'Readwise export request',
    });
    const results = Array.isArray(payload)
      ? requireRecordArray(payload, 'Readwise export response')
      : requireRecordArray(requireRecord(payload, 'Readwise export response').results, 'Readwise export response results');
    const nextPageCursor = Array.isArray(payload)
      ? undefined
      : optionalString(requireRecord(payload, 'Readwise export response').nextPageCursor);
    return {
      ...(nextPageCursor ? { nextPageCursor } : {}),
      results,
    };
  }

  async fetchExportBooks(request: ReadwiseExportFetchRequest = {}): Promise<ReadwiseExportFetchResult> {
    const maxPages = normalizeOptionalPositiveInteger(request.maxPages, 'maxPages') ?? 10;
    const books: ReadwiseExportBook[] = [];
    let pageCursor: string | undefined;
    let requestCount = 0;

    while (requestCount < maxPages) {
      const page = await this.exportBooks({
        ...(request.updatedAfter ? { updatedAfter: request.updatedAfter } : {}),
        ...(pageCursor ? { pageCursor } : {}),
      });
      requestCount += 1;
      books.push(...page.results);
      if (!page.nextPageCursor) break;
      pageCursor = page.nextPageCursor;
    }

    return {
      books,
      requestCount,
      ...(pageCursor ? { nextPageCursor: pageCursor } : {}),
      pageLimitReached: pageCursor !== undefined && requestCount >= maxPages,
    };
  }

  private async requestJson(path: string, options: { baseUrl: string; context: string }): Promise<unknown> {
    const response = await this.request(path, { baseUrl: options.baseUrl });
    if (!response.ok) throw await errorFromResponse(response, options.context);
    try {
      return await response.json();
    } catch (error) {
      throw new ReadwiseApiError(`${options.context} returned invalid JSON.`);
    }
  }

  private async request(path: string, options: { baseUrl: string }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(path, options.baseUrl).toString();
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Token ${this.token}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ReadwiseApiError('Readwise API request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Readwise API base URL must be non-empty.');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(value));
}

function normalizeReaderPageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(Math.floor(value), 100));
}

function normalizeOptionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function appendParam(params: URLSearchParams, name: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) params.set(name, trimmed);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReadwiseApiError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ReadwiseApiError(`${label} must be an array.`);
  }
  return value.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item)
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function errorFromResponse(response: Response, context: string): Promise<ReadwiseApiError> {
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 240).trim();
  } catch {
    detail = '';
  }
  return new ReadwiseApiError(
    `${context} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`,
    {
      status: response.status,
      ...(retryAfter ? { retryAfter } : {}),
    },
  );
}
