import { registerLimit } from '../../core/limit-stops.ts';
import type { Analyst } from '../../core/contracts.ts';
import { fetchModelEndpoint, type ModelTransportFetch } from '../../core/model-transport.ts';
import { BUILT_IN_REASONING_MODELS } from './built-in-reasoning/manifest.ts';

// Fallback when the local model's served window is unknown.
export const DEFAULT_LOCAL_ANALYST_PROMPT_BYTES = 13_500;
// Measured on subset L (13 Nov 2026): 27,000 bytes already kept every
// passage hit the pack held, so a larger prompt only adds prefill time.
export const LOCAL_ANALYST_PROMPT_BYTES_CEILING = 27_000;
registerLimit({ id: 'answer.local_prompt_bytes', kind: 'size', scope: 'answer', label: 'Local analyst prompt clamp', unit: 'bytes', continue: 'none' });
export interface LocalAnalystWindow { windowTokens: number; source: 'config' | 'manifest' | 'server' }
export interface LocalAnalystPromptBudget { bytes: number; source: 'env' | LocalAnalystWindow['source'] | 'fallback' }

export function localAnalystPromptBytesForWindow(windowTokens: number, outputTokens: number): number {
  // Two bytes/token deliberately leaves headroom for CJK as well as English.
  return Math.max(DEFAULT_LOCAL_ANALYST_PROMPT_BYTES,
    Math.min(LOCAL_ANALYST_PROMPT_BYTES_CEILING, Math.floor((windowTokens - outputTokens - 1_024) * 2)));
}

export function localAnalystPromptBudget(envBytes: number | undefined, window: LocalAnalystWindow | undefined, outputTokens: number): LocalAnalystPromptBudget {
  if (envBytes !== undefined) return { bytes: envBytes, source: 'env' };
  return window ? { bytes: localAnalystPromptBytesForWindow(window.windowTokens, outputTokens), source: window.source }
    : { bytes: DEFAULT_LOCAL_ANALYST_PROMPT_BYTES, source: 'fallback' };
}

interface WindowOptions {
  model: string;
  baseUrl?: string | undefined;
  contextTokens?: number | undefined;
  secretRef?: string | undefined;
  headers?: HeadersInit;
  authorize?: (init: RequestInit) => Promise<RequestInit>;
  fetchImpl?: ModelTransportFetch;
  scheduleTimeout?: (callback: () => void) => () => void;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
}

type WindowListener = (window: LocalAnalystWindow) => void;
interface WindowProbe {
  options: WindowOptions;
  result: Promise<LocalAnalystWindow | undefined>;
  listeners: Set<WindowListener>;
}
interface ProbeEndpoint {
  base: string;
  root: string;
  probes: Map<string, WindowProbe>;
  retries: Set<WindowProbe>;
}
const caches = new WeakMap<ModelTransportFetch, Map<string, ProbeEndpoint>>();
export const LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS = 10 * 60_000;

/** For startup. Answers read the analyst's current window without awaiting a probe. */
export function resolveLocalAnalystWindow(options: WindowOptions, onRefresh?: WindowListener): Promise<LocalAnalystWindow | undefined> {
  if (options.contextTokens !== undefined) return Promise.resolve({ windowTokens: options.contextTokens, source: 'config' });
  const manifest = BUILT_IN_REASONING_MODELS.find(spec => spec.modelId === options.model);
  if (manifest) return Promise.resolve({ windowTokens: manifest.contextTokens, source: 'manifest' });
  const address = probeAddress(options.baseUrl);
  if (!address) return Promise.resolve(undefined);
  const transport = options.fetchImpl ?? fetch;
  let cached = caches.get(transport);
  if (!cached) { cached = new Map(); caches.set(transport, cached); }
  let endpoint = cached.get(address.base);
  if (!endpoint) {
    endpoint = { ...address, probes: new Map(), retries: new Set() };
    cached.set(address.base, endpoint);
  }
  const key = JSON.stringify([options.model, options.secretRef]);
  let entry = endpoint.probes.get(key);
  if (!entry) {
    const current = { options, result: probe(endpoint, options), listeners: new Set<WindowListener>() };
    endpoint.probes.set(key, current);
    void current.result.then(window => {
      if (window) return;
      const idle = endpoint.retries.size === 0;
      endpoint.retries.add(current);
      if (idle) scheduleEndpointRetry(endpoint);
    });
    entry = current;
  }
  const { result, listeners } = entry;
  return onRefresh ? result.then(window => {
    if (!window) listeners.add(onRefresh);
    return window;
  }) : result;
}

function scheduleEndpointRetry(endpoint: ProbeEndpoint): void {
  const entry = endpoint.retries.values().next().value;
  if (!entry) return;
  const schedule = entry.options.scheduleRetry ?? ((callback, delayMs) => {
    setTimeout(callback, delayMs).unref();
  });
  schedule(() => {
    void probe(endpoint, entry.options).then(window => {
      endpoint.retries.delete(entry);
      if (window) {
        entry.result = Promise.resolve(window);
        for (const listener of entry.listeners) listener(window);
        entry.listeners.clear();
      } else {
        // Give other models on this endpoint a turn.
        endpoint.retries.add(entry);
      }
      scheduleEndpointRetry(endpoint);
    });
  }, LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS);
}

// Each server type answers one of these and 404s the others, so they are
// asked in turn, first usable window wins, all inside one bound. Only the
// runtime window counts, never a training length (llama.cpp n_ctx_train).
const WINDOW_READERS: ReadonlyArray<{ path: (base: string, root: string) => string; read: (body: Record<string, unknown>, model: string) => unknown }> = [
  // https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#get-props-get-server-global-properties
  { path: (_base, root) => `${root}/props`, read: body => object(body.default_generation_settings).n_ctx ?? body.n_ctx },
  // https://docs.vllm.ai/en/v0.23.0/api/vllm/entrypoints/openai/models/serving/ (show_available_models)
  { path: base => `${base}/models`, read: (body, model) => served(body.data, entry => entry.id === model).max_model_len },
  // https://docs.ollama.com/api/ps
  { path: (_base, root) => `${root}/api/ps`, read: (body, model) => served(body.models, entry => entry.name === model || entry.model === model).context_length },
  // https://lmstudio.ai/docs/developer/rest/list
  { path: (_base, root) => `${root}/api/v1/models`, read: (body, model) => {
    const instances = Array.isArray(body.models) ? body.models.flatMap(item => {
      const loaded = object(item).loaded_instances;
      return Array.isArray(loaded) ? loaded : [];
    }) : [];
    return object(served(instances, entry => entry.id === model).config).context_length;
  } },
];
export const LOCAL_ANALYST_WINDOW_PROBE_TIMEOUT_MS = 2_000;

function probeAddress(baseUrl: string | undefined): { base: string; root: string } | undefined {
  let url: URL;
  try { url = new URL(baseUrl ?? ''); } catch { return undefined; }
  // The probe goes only to the host the analyst already sends its prompts to.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
  const base = url.href.replace(/\/$/, '');
  const root = base.replace(/\/v1$/, '');
  // A prefixed router can hide the backing server: do not guess through it.
  if (new URL(root).pathname !== '/') return undefined;
  return { base, root };
}

async function probe({ base, root }: ProbeEndpoint, options: WindowOptions): Promise<LocalAnalystWindow | undefined> {
  const controller = new AbortController();
  const schedule = options.scheduleTimeout ?? (callback => {
    const timer = setTimeout(callback, LOCAL_ANALYST_WINDOW_PROBE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  });
  let cancel = () => {};
  const timeout = new Promise<undefined>(resolve => {
    cancel = schedule(() => { controller.abort(); resolve(undefined); });
  });
  const ask = async (): Promise<LocalAnalystWindow | undefined> => {
    const init = { method: 'GET', signal: controller.signal, ...(options.headers ? { headers: options.headers } : {}) };
    const authorized = options.authorize?.(init) ?? init;
    for (const reader of WINDOW_READERS) {
      if (controller.signal.aborted) return undefined;
      try {
        const request = await authorized;
        if (controller.signal.aborted) return undefined;
        const response = await fetchModelEndpoint(options.fetchImpl ?? fetch, reader.path(base, root), request);
        if (!response.ok) continue;
        const value = reader.read(object(await response.json()), options.model);
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { windowTokens: value, source: 'server' };
      } catch { /* the next reader, or the fallback */ }
    }
    return undefined;
  };
  try { return await Promise.race([timeout, ask()]); } finally { cancel(); }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function served(value: unknown, matches: (model: Record<string, unknown>) => boolean): Record<string, unknown> {
  return Array.isArray(value) ? object(value.find(model => matches(object(model)))) : {};
}

const windows = new WeakMap<Analyst, LocalAnalystWindow>();
const routeFitters = new WeakMap<Analyst, (fit: (analyst: Analyst) => Analyst) => Analyst>();
export interface LocalAnalystWindowReport { analyst: string; model: string; source: LocalAnalystPromptBudget['source']; windowTokens?: number }
const reports = new Map<string, LocalAnalystWindowReport>();
/**
 * Records the window on the analyst and, under `report`, for health: a
 * fallback to 13,500 bytes is visible there, never silent.
 */
export function setLocalAnalystWindow(analyst: Analyst, window: LocalAnalystWindow | undefined, report?: { analyst: string; model: string }): Analyst {
  if (window) windows.set(analyst, window);
  if (report) reports.set(report.analyst, { ...report, source: window?.source ?? 'fallback', ...(window ? { windowTokens: window.windowTokens } : {}) });
  return analyst;
}
export async function initializeLocalAnalystWindow(
  analyst: Analyst,
  options: WindowOptions,
  report: { analyst: string; model: string },
): Promise<void> {
  const window = await resolveLocalAnalystWindow(options, refreshed => {
    // Boot can replace a fallback report with the active Sovereignty profile
    // of the same name. That report belongs to the replacement analyst.
    setLocalAnalystWindow(analyst, refreshed, reports.get(report.analyst) === initialReport ? report : undefined);
  });
  setLocalAnalystWindow(analyst, window, report);
  const initialReport = reports.get(report.analyst);
}
/** The env override is reported for every local analyst it pins. */
export function reportLocalAnalystPromptOverride(report: { analyst: string; model: string }): void {
  reports.set(report.analyst, { ...report, source: 'env' });
}
export function localAnalystWindowReports(): LocalAnalystWindowReport[] { return [...reports.values()]; }
export function localAnalystWindowNotice(report: LocalAnalystWindowReport): string | undefined {
  if (report.source === 'fallback') {
    return `The private model's context size is unknown for profile "${report.analyst}", so answers read fewer sources. Set contextTokens on the model profile.`;
  }
  return undefined;
}
export function localAnalystWindow(analyst: Analyst): LocalAnalystWindow | undefined { return windows.get(analyst); }
/** Preserve individual leg fitting when a local service falls back to a smaller model. */
export function registerLocalAnalystFallback(analyst: Analyst, rebuild: (fit: (analyst: Analyst) => Analyst) => Analyst): Analyst {
  routeFitters.set(analyst, rebuild);
  return analyst;
}
export function fitLocalAnalystRoutes(analyst: Analyst, fit: (analyst: Analyst) => Analyst): Analyst {
  const rebuild = routeFitters.get(analyst);
  return rebuild ? rebuild(child => fitLocalAnalystRoutes(child, fit)) : fit(analyst);
}
