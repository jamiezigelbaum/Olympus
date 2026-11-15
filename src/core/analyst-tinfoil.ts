// The sole Tinfoil transport boundary. No ordinary fetch ever carries content.
import { SecureClient, TinfoilError } from 'tinfoil';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sharedDataPath } from './olympus-layout.ts';
import { withFileLeaseSync } from './file-lease.ts';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { OperationError } from './operation-error.ts';
import { createOpenAICompatibleAnalystModel, type OpenAIAnalystFetch } from './analyst-openai.ts';
import type { AnalystModel } from './analyst.ts';

export const TINFOIL_MODELS = ['kimi-k3-1-pro', 'glm-5-3', 'deepseek-v4-1-flash'] as const;
export const DEFAULT_TINFOIL_MODEL = TINFOIL_MODELS[0];
export const TINFOIL_JUDGE_MODEL = 'decision-medium';
// Owner's xanthos measurements / Tinfoil pricing, 15 Nov 2026 (USD / 1M).
// https://tinfoil.sh/models — cached input is listed separately, never assumed.
export const TINFOIL_PRICE_DATE = '2026-11-15';
export const TINFOIL_PRICES: Readonly<Record<string, { input: number; output: number; cached?: number }>> = Object.freeze({
  'kimi-k3-1-pro': { input: 4, output: 20, cached: 0.40 },
  'glm-5-3': { input: 1.80, output: 5.75, cached: 0.45 },
  'deepseek-v4-1-flash': { input: 0.60, output: 1.45, cached: 0.01 },
  'decision-medium': { input: 0.06, output: 0 },
});
export interface TinfoilStatus { state: 'ready' | 'refused' | 'limited'; reason: string; retryAt?: string; egress_destination?: 'tinfoil_attested' }
export function readTinfoilStatus(env: Record<string, string | undefined> = process.env): TinfoilStatus | undefined {
  try { return JSON.parse(readFileSync(sharedDataPath('tinfoil-status', env), 'utf8')) as TinfoilStatus; } catch { return undefined; }
}
export function recordTinfoilStatus(status: TinfoilStatus, env: Record<string, string | undefined> = process.env): void {
  const previous = readTinfoilStatus(env);
  if (status.state === 'ready' && previous?.state === 'limited' && previous.retryAt && Date.parse(previous.retryAt) > Date.now()) return;
  writePrivateFileAtomicSync(sharedDataPath('tinfoil-status', env), JSON.stringify(status));
}
/** Reasons are preserved, but credentials are removed even from malicious SDK errors. */
function safeReason(error: unknown, key: string): string {
  const text = error instanceof Error ? error.message : 'Attestation could not complete.';
  return text.split(key).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}
export class TinfoilRefusalError extends OperationError {
  readonly safeReason: string;
  constructor(readonly reason: string) {
    super('source_index_policy_violation', `Tinfoil refused: ${reason}`, 'Retry Tinfoil after resolving this reason, or explicitly choose another provider.');
    this.name = 'TinfoilRefusalError'; this.safeReason = reason;
  }
}
export class TinfoilLimitError extends OperationError {
  readonly safeReason: string;
  constructor(readonly status: number, readonly retryAfter: string | null) {
    const reason = `Tinfoil HTTP ${status}${retryAfter ? `; retry after ${retryAfter}` : ''}. ${status === 429 ? 'Rate or account usage limit reached.' : 'Payment or account usage limit reached.'}`;
    super('source_index_policy_violation', reason, 'Check the Tinfoil account limit or credit, then retry.');
    this.name = 'TinfoilLimitError'; this.safeReason = reason;
  }
}
export interface AttestedClient { ready(): Promise<void>; readonly fetch: typeof fetch }
export interface TinfoilTransportOptions {
  apiKey: string;
  env?: Record<string, string | undefined>;
  /** Tests inject the attested boundary, never an unencrypted production fallback. */
  clientFactory?: (options: { transport: 'ehbp'; userCacheSecret: string }) => AttestedClient;
  onStatus?: (status: TinfoilStatus) => void;
  /** Wraps only the attested transport, for the shared spending/pacing mechanics. */
  wrapFetch?: (fetch: OpenAIAnalystFetch) => OpenAIAnalystFetch;
  timeoutMs?: number;
}
export function tinfoilCacheSecret(env: Record<string, string | undefined> = process.env): string {
  const path = sharedDataPath('tinfoil-cache-seed', env);
  return withFileLeaseSync(path, () => {
    let seed: string;
    try { seed = readFileSync(path, 'utf8').trim(); if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('Invalid Tinfoil install seed.'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      seed = randomBytes(32).toString('hex'); writePrivateFileAtomicSync(path, seed);
    }
    return createHash('sha256').update(`olympus:tinfoil:prompt-cache:v1:${seed}`).digest('hex');
  });
}
export function createTinfoilFetch(options: TinfoilTransportOptions): OpenAIAnalystFetch {
  const key = options.apiKey.trim();
  if (!key || /[\r\n\0]/.test(key)) throw new TinfoilRefusalError('A valid Tinfoil API key is required.');
  const report = (status: TinfoilStatus) => { recordTinfoilStatus(status, options.env); options.onStatus?.(status); };
  let client: AttestedClient | undefined;
  const attested: OpenAIAnalystFetch = async (url, init) => {
    // The OpenAI adapter uses a fixed placeholder origin. SDK resolves relative
    // paths against the attested enclave; no host/attestation overrides exist.
    const path = new URL(url, 'https://tinfoil.invalid').pathname;
    if (!['/v1/chat/completions', '/v1/models', '/v1/decisions'].includes(path)) throw new TinfoilRefusalError('Unsupported Tinfoil endpoint.');
    const signal = init.signal!;
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await withSignal(client!.fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal, redirect: 'error' }), signal);
    } catch (error) {
      const reason = error instanceof TinfoilError ? safeReason(error, key) : 'The attested Tinfoil request could not complete.';
      report({ state: 'refused', reason }); throw new TinfoilRefusalError(reason);
    }
    if ([402, 403, 429].includes(response.status)) {
      const raw = response.headers.get('retry-after');
      const retryAfter = raw && /^(?:\d+(?:\.\d+)?|[A-Za-z]{3}, [\w :]+GMT)$/.test(raw) ? raw : null;
      const until = retryAfter ? (/^\d/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter)) : NaN;
      const error = new TinfoilLimitError(response.status, retryAfter);
      report({ state: 'limited', reason: error.safeReason, ...(Number.isFinite(until) ? { retryAt: new Date(until).toISOString() } : {}) });
      // The shared spender/pacer reads status and headers; never expose a body
      // which may echo credentials or source material.
      return new Response(null, { status: response.status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
    }
    if (!response.ok) {
      const reason = `Tinfoil returned HTTP ${response.status}.`; report({ state: 'refused', reason });
      return new Response(null, { status: response.status });
    }
    report({ state: 'ready', reason: 'Attestation verified.', egress_destination: 'tinfoil_attested' });
    return response;
  };
  const wrapped = options.wrapFetch?.(attested) ?? attested;
  let blockedUntil = 0;
  return async (url, init) => {
    // A caller can retry immediately, but dispatch still respects Retry-After.
    if (blockedUntil > Date.now()) throw new TinfoilLimitError(429, String(Math.ceil((blockedUntil - Date.now()) / 1000)));
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 60_000), ...(init.signal ? [init.signal] : [])]);
    try {
      // SDK 1.4.0 fixes the default repo to tinfoilsh/confidential-model-router.
      // Supplying configRepo requires an enclaveURL override, which Olympus
      // deliberately never supplies: retain the verified router/bundle defaults.
      client ??= (options.clientFactory ?? (config => new SecureClient(config)))({
        transport: 'ehbp', userCacheSecret: tinfoilCacheSecret(options.env),
      });
      // ready() has no signal API; race it so verification cannot hang a card.
      await withSignal(client.ready(), signal);
    } catch (error) {
      const reason = safeReason(error, key); report({ state: 'refused', reason }); throw new TinfoilRefusalError(reason);
    }
    // Verify before reserving money. The spending wrapper rechecks the owner's
    // exact provider choice after verification and immediately before dispatch.
    const response = await wrapped(url, { ...init, signal });
    if ([402, 403, 429].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      if (retry) blockedUntil = /^\d/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
      throw new TinfoilLimitError(response.status, retry);
    }
    if (!response.ok) throw new TinfoilRefusalError(`Tinfoil returned HTTP ${response.status}.`);
    return response;
  };
}
export function createTinfoilAnalystModel(options: TinfoilTransportOptions & { model?: string }): AnalystModel {
  const model = options.model ?? DEFAULT_TINFOIL_MODEL;
  if (!(TINFOIL_MODELS as readonly string[]).includes(model)) throw new TinfoilRefusalError('Unsupported Tinfoil answer model.');
  const delegate = createOpenAICompatibleAnalystModel({
    apiKey: options.apiKey, model, baseUrl: 'https://tinfoil.invalid/v1', providerLabel: 'Tinfoil',
    admitsLocalOnly: true, serviceTier: false, reasoningEffort: model === 'deepseek-v4-1-flash' ? 'none' : 'low',
    reasoningHeadroomTokens: model === 'glm-5-3' ? 8192 : 4096,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    extraBody: model === 'deepseek-v4-1-flash' ? { chat_template_kwargs: { thinking: false } } : {},
    fetchImpl: createTinfoilFetch(options),
  });
  return { async complete(request) {
    try { return await delegate.complete(request); }
    catch (error) {
      if (error instanceof TinfoilRefusalError || error instanceof TinfoilLimitError) throw error;
      throw new TinfoilRefusalError('Tinfoil did not produce a usable answer.');
    }
  } };
}

async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Attestation or request cancelled or timed out.'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
