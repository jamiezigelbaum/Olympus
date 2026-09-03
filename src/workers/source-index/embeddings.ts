import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { OperationError } from '../../core/operation-error.ts';
import { resolveEmbeddingEpoch } from './embedding-identity.ts';

export type SourceEmbeddingBackend = 'cloud' | 'local';
export type SourceEmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface SourceEmbeddingInput {
  text: string;
  title?: string;
  media?: SourceEmbeddingMediaInput[];
}

export interface SourceEmbeddingMediaInput {
  url: string;
  mimeType?: string;
}

export interface SourceEmbeddingProvider {
  provider: string;
  modelId: string;
  dimension: number;
  configHash: string;
  epochId: string;
  backend: SourceEmbeddingBackend;
  embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]>;
}

export interface SourceEmbeddingProviderFingerprint {
  provider: string;
  modelId: string;
  backend: SourceEmbeddingBackend;
  dimension: number;
  configHash: string;
  epochId: string;
}

export function sourceEmbeddingProviderFingerprint(
  provider: SourceEmbeddingProvider,
): SourceEmbeddingProviderFingerprint {
  return {
    provider: provider.provider,
    modelId: provider.modelId,
    backend: provider.backend,
    dimension: provider.dimension,
    configHash: provider.configHash,
    epochId: provider.epochId,
  };
}

export function sourceEmbeddingProviderFingerprintSha256(
  provider: SourceEmbeddingProvider,
): string {
  return hashString(JSON.stringify(sourceEmbeddingProviderFingerprint(provider)));
}

export interface GeminiSourceEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  outputDimensionality?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  epochId?: string;
  maxMediaPerInput?: number;
  maxMediaBytes?: number;
  mediaFetchTimeoutMs?: number;
  lookupIpAddresses?: (hostname: string) => Promise<string[]>;
  mediaFetchImpl?: MediaFetchImpl;
  maxMediaRedirects?: number;
}

export type MediaFetchImpl = (url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}) => Promise<Response>;

export interface OpenAICompatibleSourceEmbeddingProviderOptions {
  baseUrl: string;
  model: string;
  apiKeyProvider?: () => string | undefined;
  dimension?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  epochId?: string;
}

const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MAX_MEDIA_PER_INPUT = 0;
const MAX_MEDIA_PER_INPUT_LIMIT = 6;
const DEFAULT_MAX_MEDIA_REDIRECTS = 3;
const DEFAULT_MAX_MEDIA_BYTES = 5_000_000;
const DEFAULT_MEDIA_FETCH_TIMEOUT_MS = 5_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const MEDIA_FETCH_HEADERS = {
  Accept: 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
  'User-Agent': 'Mozilla/5.0 (compatible; OlympusSourceIndex/0.1)',
};

export class GeminiSourceEmbeddingProvider implements SourceEmbeddingProvider {
  provider = 'google-gemini';
  modelId: string;
  dimension: number;
  configHash: string;
  epochId: string;
  backend = 'cloud' as const;
  lastMediaPartsSkipped = 0;
  mediaPartsSkipped = 0;

  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private outputDimensionality: number | undefined;
  private maxMediaPerInput: number;
  private maxMediaBytes: number;
  private mediaFetchTimeoutMs: number;
  private lookupIpAddresses: (hostname: string) => Promise<string[]>;
  private mediaFetchImpl: MediaFetchImpl;
  private maxMediaRedirects: number;

  constructor(options: GeminiSourceEmbeddingProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new OperationError('config_error', 'Gemini source embedding API key must be configured.');
    }
    this.apiKey = apiKey;
    this.modelId = normalizeGeminiModelId(options.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL);
    this.baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_API_BASE_URL).replace(/\/+$/, '');
    this.outputDimensionality = normalizeOutputDimensionality(options.outputDimensionality);
    this.dimension = this.outputDimensionality ?? 0;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxMediaPerInput = normalizeMaxMediaPerInput(options.maxMediaPerInput);
    this.maxMediaBytes = normalizeMaxMediaBytes(options.maxMediaBytes);
    this.mediaFetchTimeoutMs = normalizeMediaFetchTimeoutMs(options.mediaFetchTimeoutMs);
    this.lookupIpAddresses = options.lookupIpAddresses ?? defaultLookupIpAddresses;
    this.mediaFetchImpl = options.mediaFetchImpl ?? defaultMediaFetch;
    this.maxMediaRedirects = normalizeMaxMediaRedirects(options.maxMediaRedirects);
    this.epochId = resolveEmbeddingEpoch({
      provider: this.provider,
      modelId: this.modelId,
      dimension: this.outputDimensionality,
      backend: this.backend,
      ...(options.epochId ? { epochOverride: options.epochId } : {}),
    });
    this.configHash = hashString(JSON.stringify({
      provider: this.provider,
      model: this.modelId,
      baseUrl: this.baseUrl,
      outputDimensionality: this.outputDimensionality ?? 'provider-reported',
      maxMediaPerInput: this.maxMediaPerInput,
      maxMediaBytes: this.maxMediaBytes,
      mediaFetchTimeoutMs: this.mediaFetchTimeoutMs,
      maxMediaRedirects: this.maxMediaRedirects,
      backend: this.backend,
    }));
  }

  async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const modelPath = `models/${this.modelId}`;
      let mediaPartsSkipped = 0;
      const requests = await Promise.all(inputs.map(async (input) => {
        const contentParts = await this.contentPartsForInput(input);
        mediaPartsSkipped += contentParts.mediaPartsSkipped;
        return {
          model: modelPath,
          content: {
            parts: contentParts.parts,
          },
          taskType: options.taskType,
          ...(options.taskType === 'RETRIEVAL_DOCUMENT' && input.title ? { title: input.title } : {}),
          ...(this.outputDimensionality !== undefined ? { outputDimensionality: this.outputDimensionality } : {}),
        };
      }));
      this.lastMediaPartsSkipped = mediaPartsSkipped;
      this.mediaPartsSkipped += mediaPartsSkipped;
      const response = await this.fetchImpl(`${this.baseUrl}/${modelPath}:batchEmbedContents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          requests,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OperationError(
          'source_index_error',
          `Gemini source embedding endpoint returned HTTP ${response.status}.`,
          'Check the configured Gemini API key, model, and source-index embedding policy.',
        );
      }
      const vectors = parseGeminiBatchEmbeddingResponse(await response.json());
      if (vectors.length !== inputs.length) {
        throw new OperationError('source_index_error', 'Gemini source embedding endpoint returned the wrong number of embeddings.');
      }
      if (this.dimension === 0 && vectors[0]) {
        this.dimension = vectors[0].length;
      }
      return vectors;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        'source_index_error',
        'Gemini source embedding endpoint failed.',
        error instanceof Error ? error.message : 'Check the configured cloud embedding provider.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async contentPartsForInput(input: SourceEmbeddingInput): Promise<{
    parts: Array<Record<string, unknown>>;
    mediaPartsSkipped: number;
  }> {
    const parts: Array<Record<string, unknown>> = [{ text: input.text }];
    const mediaInputs = input.media ?? [];
    const media = mediaInputs.slice(0, this.maxMediaPerInput);
    let mediaPartsSkipped = Math.max(0, mediaInputs.length - media.length);
    for (const item of media) {
      const part = await this.inlineMediaPart(item);
      if (part) {
        parts.push(part);
      } else {
        mediaPartsSkipped += 1;
      }
    }
    return { parts, mediaPartsSkipped };
  }

  private async inlineMediaPart(input: SourceEmbeddingMediaInput): Promise<Record<string, unknown> | undefined> {
    const url = parseSafeMediaUrl(input.url);
    if (!url) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mediaFetchTimeoutMs);
    try {
      const response = await this.fetchPublicMedia(url, controller.signal);
      if (!response) return undefined;
      if (!response.ok) return undefined;
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > this.maxMediaBytes) return undefined;
      const mimeType = normalizeImageMimeType(input.mimeType ?? response.headers.get('content-type'));
      if (!mimeType) return undefined;
      const bytes = await readCappedMediaBody(response, this.maxMediaBytes);
      if (!bytes) return undefined;
      if (bytes.byteLength === 0 || bytes.byteLength > this.maxMediaBytes) return undefined;
      return {
        inlineData: {
          mimeType,
          data: Buffer.from(bytes).toString('base64'),
        },
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchPublicMedia(initialUrl: URL, signal: AbortSignal): Promise<Response | undefined> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= this.maxMediaRedirects; redirects += 1) {
      const validatedAddresses = await publicMediaFetchAddresses(url, this.lookupIpAddresses);
      if (!validatedAddresses) return undefined;
      const response = await this.mediaFetchImpl(url, {
        validatedAddresses,
        signal,
      });
      if (!isRedirectStatus(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return undefined;
      const nextUrl = parseSafeMediaUrl(location, url);
      if (!nextUrl) return undefined;
      url = nextUrl;
    }
    return undefined;
  }
}

export class OpenAICompatibleSourceEmbeddingProvider implements SourceEmbeddingProvider {
  provider = 'local-openai-compatible';
  modelId: string;
  dimension: number;
  configHash: string;
  epochId: string;
  backend = 'local' as const;

  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private apiKeyProvider: (() => string | undefined) | undefined;

  constructor(options: OpenAICompatibleSourceEmbeddingProviderOptions) {
    this.baseUrl = normalizeLocalSourceEmbeddingBaseUrl(options.baseUrl);
    this.modelId = options.model.trim();
    if (!this.modelId) {
      throw new OperationError('config_error', 'Local source embedding model must be configured.');
    }
    this.dimension = options.dimension ?? 0;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKeyProvider = options.apiKeyProvider;
    this.epochId = resolveEmbeddingEpoch({
      provider: this.provider,
      modelId: this.modelId,
      dimension: this.dimension,
      backend: this.backend,
      ...(options.epochId ? { epochOverride: options.epochId } : {}),
    });
    this.configHash = hashString(JSON.stringify({
      provider: this.provider,
      baseUrl: this.baseUrl,
      model: this.modelId,
      dimension: this.dimension || 'provider-reported',
      backend: this.backend,
    }));
  }

  async embed(inputs: SourceEmbeddingInput[], _options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify({
          model: this.modelId,
          input: inputs.map((input) => [
            input.title ? `Title: ${input.title}` : undefined,
            input.text,
          ].filter((part): part is string => Boolean(part)).join('\n')),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OperationError(
          'source_index_error',
          `Local source embedding endpoint returned HTTP ${response.status}.`,
          'Check the local/private embedding endpoint configured for secure-local source-index embeddings.',
        );
      }
      const vectors = parseOpenAICompatibleEmbeddingResponse(await response.json());
      if (vectors.length !== inputs.length) {
        throw new OperationError('source_index_error', 'Local source embedding endpoint returned the wrong number of embeddings.');
      }
      if (this.dimension === 0 && vectors[0]) {
        this.dimension = vectors[0].length;
      }
      return vectors;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        'source_index_error',
        'Local source embedding endpoint failed.',
        error instanceof Error ? error.message : 'Check the local/private embedding endpoint.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestHeaders(): Headers {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const apiKey = this.apiKeyProvider?.()?.trim();
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    return headers;
  }
}

export class DeterministicSourceEmbeddingProvider implements SourceEmbeddingProvider {
  provider = 'deterministic-source-test';
  modelId: string;
  dimension: number;
  configHash: string;
  epochId: string;
  backend = 'local' as const;
  private conceptGroups: string[][];

  constructor(options: { modelId?: string; dimension?: number; epochId?: string; conceptGroups?: string[][] } = {}) {
    this.modelId = options.modelId ?? 'olympus-deterministic-source-embedding-v1';
    this.dimension = options.dimension ?? 48;
    this.conceptGroups = normalizeDeterministicConceptGroups(options.conceptGroups);
    this.epochId = resolveEmbeddingEpoch({
      provider: this.provider,
      modelId: this.modelId,
      dimension: this.dimension,
      backend: this.backend,
      ...(options.epochId ? { epochOverride: options.epochId } : {}),
    });
    this.configHash = hashString(JSON.stringify({
      provider: this.provider,
      model: this.modelId,
      dimension: this.dimension,
      conceptGroups: this.conceptGroups,
      version: 2,
      backend: this.backend,
    }));
  }

  async embed(inputs: SourceEmbeddingInput[], _options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    return inputs.map((input) => deterministicSourceVector([
      input.title ?? '',
      input.text,
      ...(input.media ?? []).map((item) => item.url),
    ].join('\n'), this.dimension, this.conceptGroups));
  }
}

// Scores one stored vector against a query vector. Accepts ArrayLike so the
// stored side can stay the Float32Array view decodeEmbedding hands back — the
// whole point of the 2026-07-28 rewrite is that a vector is never boxed into a
// JS number[] just to be read once and discarded.
//
// The arithmetic stays a full cosine rather than the bare dot product the
// currently-stored corpus would allow, and that is a measured choice rather
// than a cautious one. Over 2,560-dim unit vectors, interleaved in one process:
// full cosine 19.8 ms, bare dot 18.3 ms per 4,000 vectors. The loop is
// memory-bound, not ALU-bound, so dropping both norm accumulators buys ~8% of
// the scoring step — roughly 60 ms of a ~1.3s scan over 170k vectors.
//
// What it would cost is worse. MIN_VECTOR_SCORE and the semantic relevance bar
// are fixed thresholds on a value in [-1, 1]. A provider that ever returned
// unnormalized vectors would not read as "slightly off" under a dot product; it
// would move every score across those bars at once. Normalization is a property
// of the data, not something this function can enforce, so it is measured.
//
// The `?? 0` guards are also not a cost — 19.8 ms with, 21.3 ms for the
// unguarded cast. They stay because a sparse array would otherwise score NaN
// instead of skipping a hole.
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function encodeEmbedding(vector: number[], expectedDimension: number): Uint8Array {
  if (vector.length !== expectedDimension) {
    throw new OperationError(
      'source_index_error',
      `Embedding dimension mismatch: expected ${expectedDimension}, received ${vector.length}.`,
    );
  }
  const floats = new Float32Array(vector.length);
  vector.forEach((value, index) => {
    floats[index] = Number.isFinite(value) ? value : 0;
  });
  return new Uint8Array(floats.buffer);
}

// Reads a stored embedding blob as float32 WITHOUT copying it.
//
// This used to end in `Array.from(floats)`, which turned a 10 KB compact blob
// into a ~20 KB boxed JS number[] for every row of every vector scan. On the
// live Telegram corpus that single call was ~96% of a 17.5s query: 14.3s of
// boxing against 0.56s of actual arithmetic. The scan was never compute-bound,
// it was allocation-bound, and the fix is to stop allocating.
//
// The returned Float32Array is a VIEW over the blob's own buffer. bun:sqlite
// hands out a freshly allocated, 4-byte-aligned buffer per blob row (verified:
// distinct buffers per row, byteOffset 0, views stay valid after the statement
// advances), so a view is safe to hold and safe to read after iteration moves
// on. Callers must treat it as read-only; nothing in this repo writes through
// it.
export function decodeEmbedding(value: unknown): Float32Array {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new OperationError('source_index_error', 'Stored source embedding payload was not a BLOB.');
  }

  const usableBytes = bytes.byteLength - (bytes.byteLength % 4);
  // A blob whose start is not 4-byte aligned cannot be viewed as float32 in
  // place; that is the one case where a copy is unavoidable.
  if (bytes.byteOffset % 4 !== 0) {
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usableBytes));
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, usableBytes / 4);
}

function parseGeminiBatchEmbeddingResponse(value: unknown): number[][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('source_index_error', 'Gemini embedding response must be a JSON object.');
  }
  const embeddings = (value as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings)) {
    throw new OperationError('source_index_error', 'Gemini embedding response must include embeddings array.');
  }
  return embeddings.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperationError('source_index_error', `Gemini embeddings.${index} must be an object.`);
    }
    const values = (item as { values?: unknown }).values;
    if (!Array.isArray(values) || !values.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new OperationError('source_index_error', `Gemini embeddings.${index}.values must be a number array.`);
    }
    return values;
  });
}

function parseOpenAICompatibleEmbeddingResponse(value: unknown): number[][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('source_index_error', 'Local source embedding response must be a JSON object.');
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new OperationError('source_index_error', 'Local source embedding response must include data array.');
  }
  return data.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperationError('source_index_error', `Local source embedding data.${index} must be an object.`);
    }
    const embedding = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || !embedding.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new OperationError('source_index_error', `Local source embedding data.${index}.embedding must be a number array.`);
    }
    return embedding;
  });
}

function normalizeMaxMediaPerInput(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_MEDIA_PER_INPUT;
  return Math.max(0, Math.min(Math.floor(value), MAX_MEDIA_PER_INPUT_LIMIT));
}

function normalizeMaxMediaBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_MEDIA_BYTES;
  return Math.max(1, Math.floor(value));
}

function normalizeMediaFetchTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MEDIA_FETCH_TIMEOUT_MS;
  return Math.max(100, Math.floor(value));
}

function normalizeMaxMediaRedirects(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_MEDIA_REDIRECTS;
  return Math.max(0, Math.min(Math.floor(value), DEFAULT_MAX_MEDIA_REDIRECTS));
}

function normalizeImageMimeType(value: string | null | undefined): string | undefined {
  const mimeType = value?.split(';')[0]?.trim().toLowerCase();
  if (!mimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return undefined;
  return mimeType;
}

function parseSafeMediaUrl(value: string, base?: URL): URL | undefined {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  return url;
}

function defaultMediaFetch(url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}): Promise<Response> {
  const address = options.validatedAddresses[0];
  const family = address ? isIP(address) : 0;
  if (!address || !family || isPrivateOrReservedIp(address)) {
    return Promise.resolve(new Response(null, { status: 403 }));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers: MEDIA_FETCH_HEADERS,
      lookup: (_hostname, _options, callback) => {
        callback(null, address, family);
      },
      signal: options.signal,
    }, (message) => {
      resolvePromise(responseFromIncomingMessage(message));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

function responseFromIncomingMessage(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  const status = message.statusCode && message.statusCode >= 100 && message.statusCode <= 599
    ? message.statusCode
    : 502;
  const body = status === 204 || status === 304 ? null : readableStreamFromIncomingMessage(message);
  return new Response(body, {
    status,
    headers,
    ...(message.statusMessage ? { statusText: message.statusMessage } : {}),
  });
}

async function readCappedMediaBody(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? undefined : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readableStreamFromIncomingMessage(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (typeof chunk === 'string') {
          controller.enqueue(new TextEncoder().encode(chunk));
          return;
        }
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      });
      message.on('end', () => controller.close());
      message.on('error', (error) => controller.error(error));
    },
    cancel() {
      message.destroy();
    },
  });
}

async function publicMediaFetchAddresses(
  url: URL,
  lookupIpAddresses: (hostname: string) => Promise<string[]>,
): Promise<string[] | undefined> {
  const host = normalizedHostname(url);
  if (
    host === 'localhost'
    || host.endsWith('.local')
  ) {
    return undefined;
  }
  if (isIP(host)) return isPrivateOrReservedIp(host) ? undefined : [host];
  let addresses: string[];
  try {
    addresses = await lookupIpAddresses(host);
  } catch {
    return undefined;
  }
  return addresses.length > 0 && addresses.every((address) => !isPrivateOrReservedIp(address))
    ? addresses
    : undefined;
}

async function defaultLookupIpAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isPrivateOrReservedIpv4(normalized);
  if (version !== 6) return true;
  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped) return isPrivateOrReservedIpv4(mapped);
  const firstSegment = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('2001:db8:')
    || (firstSegment >= 0xfc00 && firstSegment <= 0xfdff)
    || (firstSegment >= 0xfe80 && firstSegment <= 0xfebf)
    || (firstSegment >= 0xff00 && firstSegment <= 0xffff);
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224;
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const words = expandIpv6Words(address);
  if (!words || words.length !== 8) return undefined;
  if (
    words.slice(0, 5).some((word) => word !== 0)
    || words[5] !== 0xffff
  ) {
    return undefined;
  }
  const [high = 0, low = 0] = words.slice(6);
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function expandIpv6Words(address: string): number[] | undefined {
  const normalized = replaceDottedIpv4Tail(address);
  if (!normalized) return undefined;
  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;
  const left = ipv6WordsFromPart(parts[0] ?? '');
  const right = parts.length === 2 ? ipv6WordsFromPart(parts[1] ?? '') : [];
  if (!left || !right) return undefined;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
}

function replaceDottedIpv4Tail(address: string): string | undefined {
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (!dotted) return address;
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
  const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
  return `${address.slice(0, -dotted.length)}${high.toString(16)}:${low.toString(16)}`;
}

function ipv6WordsFromPart(part: string): number[] | undefined {
  if (!part) return [];
  const words = part.split(':').map((segment) => {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return Number.NaN;
    return Number.parseInt(segment, 16);
  });
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function normalizeGeminiModelId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function normalizeLocalSourceEmbeddingBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OperationError('config_error', 'Local source embedding base URL must be a valid loopback HTTP(S) URL.');
  }
  const hostname = url.hostname.toLowerCase();
  const localHost = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
  if (!localHost) {
    throw new OperationError(
      'config_error',
      'secure_local source embeddings must use a local/private loopback endpoint.',
      'Use a loopback endpoint such as http://127.0.0.1:8000/v1 behind the approved local runtime path.',
    );
  }
  return value.replace(/\/+$/, '');
}

function normalizeOutputDimensionality(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new OperationError('config_error', 'Gemini embedding output dimensionality must be a positive integer.');
  }
  return value;
}

function deterministicSourceVector(text: string, dimension: number, conceptGroups: readonly string[][]): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const conceptDimensions = Math.min(conceptGroups.length, dimension);

  for (let index = 0; index < conceptDimensions; index += 1) {
    addConcept(vector, index, normalized, conceptGroups[index] ?? []);
  }

  for (const token of tokens) {
    const hash = fnv1a(token);
    const lexicalDimensions = Math.max(1, dimension - conceptDimensions);
    const index = conceptDimensions + (hash % lexicalDimensions);
    vector[index] = (vector[index] ?? 0) + 0.2;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function addConcept(vector: number[], index: number, text: string, terms: string[]): void {
  if (index >= vector.length) return;
  for (const term of terms) {
    if (text.includes(term)) vector[index] = (vector[index] ?? 0) + 1;
  }
}

function normalizeDeterministicConceptGroups(value: string[][] | undefined): string[][] {
  return (value ?? [])
    .map((group) => group
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean))
    .filter((group) => group.length > 0);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
