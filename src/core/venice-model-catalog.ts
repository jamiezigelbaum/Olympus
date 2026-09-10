import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  normalizeVeniceAnalystModelId,
  venicePrivacyCategoryForModel,
  type VenicePrivacyCategory,
} from './venice-models.ts';

export type VeniceModelCatalogFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface VeniceModelCatalogOptions {
  cachePath?: string;
  type?: 'text' | 'embedding';
  ttlMs?: number;
  refreshMinIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: VeniceModelCatalogFetch;
  now?: () => number;
}

export type VenicePrivacyCategoryResolver = (
  modelId: string,
  signal?: AbortSignal,
) => Promise<VenicePrivacyCategory | undefined>;

export const DEFAULT_VENICE_MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_VENICE_MODEL_CATALOG_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1_000;
export const DEFAULT_VENICE_MODEL_CATALOG_TIMEOUT_MS = 10_000;

const CACHE_SCHEMA_VERSION = 1;
const MAX_CATALOG_TIMEOUT_MS = 30_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

interface VeniceModelCatalog {
  fetchedAtMs: number;
  type: 'text' | 'embedding';
  models: Readonly<Record<string, VenicePrivacyCategory>>;
}

type CatalogRefreshOutcome =
  | { status: 'success'; catalog: VeniceModelCatalog }
  | { status: 'failed' }
  | { status: 'rate_limited' };

interface RefreshGate {
  lastAttemptAtMs?: number;
  inFlight?: Promise<CatalogRefreshOutcome>;
}

// One gate per durable cache prevents repeated unknown-model requests from
// creating a refresh storm, even when callers construct multiple adapters.
const REFRESH_GATES = new Map<string, RefreshGate>();

export function defaultVeniceModelCatalogCachePath(
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir(),
  type: 'text' | 'embedding' = 'text',
): string {
  const configuredRoot = env.XDG_CACHE_HOME?.trim();
  const cacheRoot = configuredRoot && isAbsolute(configuredRoot)
    ? configuredRoot
    : join(homeDir, '.cache');
  return join(cacheRoot, 'olympus', type === 'embedding'
    ? 'venice-embedding-model-catalog-v1.json'
    : 'venice-model-catalog-v1.json');
}

export function createVenicePrivacyCategoryResolver(input: {
  apiKey: string;
  baseUrl: string;
  catalog?: VeniceModelCatalogOptions;
}): VenicePrivacyCategoryResolver {
  const options = input.catalog ?? {};
  const type = options.type ?? 'text';
  const cachePath = options.cachePath ?? defaultVeniceModelCatalogCachePath(process.env, homedir(), type);
  const cacheKey = `${cachePath}\n${type}`;
  const ttlMs = boundedNonNegativeMs(options.ttlMs, DEFAULT_VENICE_MODEL_CATALOG_TTL_MS);
  const refreshMinIntervalMs = boundedNonNegativeMs(
    options.refreshMinIntervalMs,
    DEFAULT_VENICE_MODEL_CATALOG_REFRESH_MIN_INTERVAL_MS,
  );
  const timeoutMs = boundedPositiveMs(
    options.timeoutMs,
    DEFAULT_VENICE_MODEL_CATALOG_TIMEOUT_MS,
    MAX_CATALOG_TIMEOUT_MS,
  );
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const catalogUrl = `${input.baseUrl.replace(/\/+$/, '')}/models?type=${type}`;
  let cachedCatalog = readCatalogCache(cachePath, type);

  return async (
    rawModelId: string,
    signal?: AbortSignal,
  ): Promise<VenicePrivacyCategory | undefined> => {
    throwIfAborted(signal);
    const modelId = type === 'embedding' ? rawModelId.trim() : normalizeVeniceAnalystModelId(rawModelId);
    const resolvedAtMs = now();
    cachedCatalog = newerCatalog(cachedCatalog, readCatalogCache(cachePath, type));

    if (catalogIsFresh(cachedCatalog, resolvedAtMs, ttlMs)) {
      const cachedCategory = catalogCategory(cachedCatalog, modelId);
      if (cachedCategory) return cachedCategory;

      // A fresh cache miss gets one bounded live refresh before refusing. The
      // shared gate suppresses repeated unknown-model refreshes for a short
      // interval, but never promotes an absent model from the pinned snapshot.
      const refreshed = await refreshCatalog({
        apiKey: input.apiKey,
        cachePath,
        cacheKey,
        type,
        catalogUrl,
        fetchImpl,
        now,
        refreshMinIntervalMs,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (refreshed.status === 'success') {
        cachedCatalog = refreshed.catalog;
        return catalogCategory(refreshed.catalog, modelId);
      }
      cachedCatalog = newerCatalog(cachedCatalog, readCatalogCache(cachePath, type));
      return catalogIsFresh(cachedCatalog, now(), ttlMs)
        ? catalogCategory(cachedCatalog, modelId)
        : undefined;
    }

    // A stale or missing catalog is not authoritative. Try Venice once; only
    // an unavailable refresh permits the pinned snapshot as an offline floor.
    const refreshed = await refreshCatalog({
      apiKey: input.apiKey,
      cachePath,
      cacheKey,
      type,
      catalogUrl,
      fetchImpl,
      now,
      refreshMinIntervalMs,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (refreshed.status === 'success') {
      cachedCatalog = refreshed.catalog;
      return catalogCategory(refreshed.catalog, modelId);
    }
    cachedCatalog = newerCatalog(cachedCatalog, readCatalogCache(cachePath, type));
    if (catalogIsFresh(cachedCatalog, now(), ttlMs)) {
      return catalogCategory(cachedCatalog, modelId);
    }
    return type === 'embedding' ? undefined : venicePrivacyCategoryForModel(modelId);
  };
}

// Alias normalization lowercases unrecognized ids, while Venice keys its live
// catalog verbatim — so a newly shipped model whose id carries an uppercase
// character would miss an exact lookup and be refused as unknown despite the
// catalog vouching for it. Exact match first; otherwise one case-insensitive
// scan over a catalog of a few dozen entries. Categories still come only from
// the catalog entry itself, so this cannot promote anything.
function catalogCategory(
  catalog: VeniceModelCatalog | undefined,
  modelId: string,
): VenicePrivacyCategory | undefined {
  if (!catalog) return undefined;
  const exact = catalog.models[modelId];
  if (exact) return exact;
  const lower = modelId.toLowerCase();
  for (const [key, category] of Object.entries(catalog.models)) {
    if (key.toLowerCase() === lower) return category;
  }
  return undefined;
}

function newerCatalog(
  current: VeniceModelCatalog | undefined,
  candidate: VeniceModelCatalog | undefined,
): VeniceModelCatalog | undefined {
  if (!candidate) return current;
  if (!current || candidate.fetchedAtMs > current.fetchedAtMs) return candidate;
  return current;
}

function catalogIsFresh(
  catalog: VeniceModelCatalog | undefined,
  nowMs: number,
  ttlMs: number,
): catalog is VeniceModelCatalog {
  if (!catalog) return false;
  const ageMs = nowMs - catalog.fetchedAtMs;
  return ageMs >= -MAX_FUTURE_CLOCK_SKEW_MS && ageMs <= ttlMs;
}

async function refreshCatalog(input: {
  apiKey: string;
  cachePath: string;
  cacheKey: string;
  type: 'text' | 'embedding';
  catalogUrl: string;
  fetchImpl: VeniceModelCatalogFetch;
  now: () => number;
  refreshMinIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CatalogRefreshOutcome> {
  throwIfAborted(input.signal);
  const gate = REFRESH_GATES.get(input.cacheKey) ?? {};
  REFRESH_GATES.set(input.cacheKey, gate);

  if (gate.inFlight) return awaitWithAbort(gate.inFlight, input.signal);

  const attemptedAtMs = input.now();
  if (
    gate.lastAttemptAtMs !== undefined
    && attemptedAtMs - gate.lastAttemptAtMs < input.refreshMinIntervalMs
  ) {
    return { status: 'rate_limited' };
  }
  gate.lastAttemptAtMs = attemptedAtMs;

  const refresh = fetchCatalog(input, attemptedAtMs);
  gate.inFlight = refresh;
  try {
    return await refresh;
  } finally {
    delete gate.inFlight;
  }
}

async function fetchCatalog(
  input: {
    apiKey: string;
    cachePath: string;
    type: 'text' | 'embedding';
    catalogUrl: string;
    fetchImpl: VeniceModelCatalogFetch;
    timeoutMs: number;
    signal?: AbortSignal;
  },
  fetchedAtMs: number,
): Promise<CatalogRefreshOutcome> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(input.catalogUrl, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      signal: controller.signal,
    });
  } catch {
    throwIfAborted(input.signal);
    return { status: 'failed' };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }

  if (!response.ok) return { status: 'failed' };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: 'failed' };
  }
  const models = parseCatalogModels(payload);
  if (!models) return { status: 'failed' };

  const catalog: VeniceModelCatalog = { fetchedAtMs, type: input.type, models };
  writeCatalogCache(input.cachePath, catalog);
  return { status: 'success', catalog };
}

function parseCatalogModels(payload: unknown): Readonly<Record<string, VenicePrivacyCategory>> | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
    return undefined;
  }

  const models: Record<string, VenicePrivacyCategory> = {};
  for (const rawItem of payload.data) {
    if (!isRecord(rawItem) || typeof rawItem.id !== 'string' || !rawItem.id.trim()) continue;
    if (!isRecord(rawItem.model_spec)) continue;
    const category = parsePrivacyCategory(rawItem.model_spec.privacy);
    if (!category) continue;
    models[rawItem.id.trim()] = category;
  }
  return Object.keys(models).length > 0 ? Object.freeze(models) : undefined;
}

function readCatalogCache(path: string, type: 'text' | 'embedding'): VeniceModelCatalog | undefined {
  if (!existsSync(path)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || payload.schema_version !== CACHE_SCHEMA_VERSION) return undefined;
  if (payload.catalog_type !== undefined && payload.catalog_type !== type) return undefined;
  if (type === 'embedding' && payload.catalog_type !== 'embedding') return undefined;
  if (typeof payload.fetched_at !== 'string' || !isRecord(payload.models)) return undefined;
  const fetchedAtMs = Date.parse(payload.fetched_at);
  if (!Number.isFinite(fetchedAtMs)) return undefined;

  const models: Record<string, VenicePrivacyCategory> = {};
  for (const [modelId, rawCategory] of Object.entries(payload.models)) {
    const category = parsePrivacyCategory(rawCategory);
    if (!modelId.trim() || !category) continue;
    // A same-UID process can rewrite this unsigned durability layer. Never let
    // disk cache alone promote a snapshot-anonymized id across the S4 floor;
    // omitting the forged promotion forces the existing bounded live refresh.
    // Live catalog parsing remains untouched and authoritative.
    if (
      venicePrivacyCategoryForModel(modelId.toLowerCase()) === 'anonymized'
      && category !== 'anonymized'
    ) {
      continue;
    }
    models[modelId] = category;
  }
  if (Object.keys(models).length === 0) return undefined;
  return { fetchedAtMs, type, models: Object.freeze(models) };
}

function writeCatalogCache(path: string, catalog: VeniceModelCatalog): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const models = Object.fromEntries(Object.entries(catalog.models).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(tempPath, `${JSON.stringify({
      schema_version: CACHE_SCHEMA_VERSION,
      catalog_type: catalog.type,
      fetched_at: new Date(catalog.fetchedAtMs).toISOString(),
      models,
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch {
    // The live catalog remains authoritative for this request even if the
    // durability layer is temporarily read-only.
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function parsePrivacyCategory(value: unknown): VenicePrivacyCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'anonymized'
    || normalized === 'private'
    || normalized === 'tee'
    || normalized === 'e2ee'
  ) {
    return normalized;
  }
  return undefined;
}

function boundedNonNegativeMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function boundedPositiveMs(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') {
    throw signal.reason;
  }
  const error = new Error('Venice model catalog request was cancelled.');
  error.name = 'AbortError';
  throw error;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        abortListener = () => {
          try {
            throwIfAborted(signal);
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}
