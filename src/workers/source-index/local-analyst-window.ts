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
export interface LocalAnalystWindow { windowTokens: number; source: 'manifest' | 'server' }
export interface LocalAnalystPromptBudget { bytes: number; source: 'env' | 'manifest' | 'server' | 'fallback' }

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
  baseUrl?: string;
  headers?: HeadersInit;
  fetchImpl?: ModelTransportFetch;
  scheduleTimeout?: (callback: () => void) => () => void;
}
const caches = new WeakMap<ModelTransportFetch, Map<string, Promise<LocalAnalystWindow | undefined>>>();

/** One read-only probe, cached (including failure) for this process. No route discovery. */
export function resolveLocalAnalystWindow(options: WindowOptions): Promise<LocalAnalystWindow | undefined> {
  const manifest = BUILT_IN_REASONING_MODELS.find(spec => spec.modelId === options.model);
  if (manifest) return Promise.resolve({ windowTokens: manifest.contextTokens, source: 'manifest' });
  const key = JSON.stringify([options.baseUrl, options.model]);
  const transport = options.fetchImpl ?? fetch;
  let cached = caches.get(transport);
  if (!cached) { cached = new Map(); caches.set(transport, cached); }
  let result = cached.get(key);
  if (!result) { result = probe(options); cached.set(key, result); }
  return result;
}

// Each server type answers one of these and 404s the others, so they are
// asked in turn, first usable window wins, all inside one bound. Only the
// runtime window counts, never a training length (llama.cpp n_ctx_train).
const WINDOW_READERS: ReadonlyArray<{ path: (base: string, root: string) => string; read: (body: Record<string, unknown>, model: string) => unknown }> = [
  { path: (_base, root) => `${root}/props`, read: body => object(body.default_generation_settings).n_ctx ?? body.n_ctx },
  { path: base => `${base}/models`, read: (body, model) => served(body.data, entry => entry.id === model).max_model_len },
  { path: (_base, root) => `${root}/api/ps`, read: (body, model) => served(body.models, entry => entry.name === model || entry.model === model).context_length },
];
export const LOCAL_ANALYST_WINDOW_PROBE_TIMEOUT_MS = 2_000;

async function probe(options: WindowOptions): Promise<LocalAnalystWindow | undefined> {
  let url: URL;
  try { url = new URL(options.baseUrl ?? ''); } catch { return undefined; }
  // The probe goes only to the host the analyst already sends its prompts to.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
  const base = url.href.replace(/\/$/, '');
  const root = base.replace(/\/v1$/, '');
  // A prefixed router can hide the backing server: do not guess through it.
  if (new URL(root).pathname !== '/') return undefined;
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
    for (const reader of WINDOW_READERS) {
      if (controller.signal.aborted) return undefined;
      try {
        const response = await fetchModelEndpoint(options.fetchImpl ?? fetch, reader.path(base, root), {
          method: 'GET', signal: controller.signal, ...(options.headers ? { headers: options.headers } : {}),
        });
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
/** The env override is reported for every local analyst it pins. */
export function reportLocalAnalystPromptOverride(report: { analyst: string; model: string }): void {
  reports.set(report.analyst, { ...report, source: 'env' });
}
export function localAnalystWindowReports(): LocalAnalystWindowReport[] { return [...reports.values()]; }
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
