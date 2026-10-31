import { fetchBoundedText, isAbortError } from './http-timeout.ts';
import { assertLocalModelIdNotCloudForwarding, isCloudForwardingModelId } from './local-model-policy.ts';
import { isModelEndpointRedirectError, modelEndpointFetch, type ModelTransportFetch } from './model-transport.ts';

export type LocalModelStep = 'endpoint' | 'models' | 'answer' | 'embedding' | 'complete';
export interface DiscoveredLocalModel { id: string; allowed: boolean; reason?: string }
export interface LocalModelDiscoveryResult {
  provider: 'ollama' | 'lm-studio' | 'openai-compatible';
  baseUrl: string;
  models: DiscoveredLocalModel[];
  working: boolean;
  step: LocalModelStep;
  detail: string;
}
export interface LocalModelTestResult {
  working: boolean;
  step: LocalModelStep;
  detail: string;
  embeddingDimension?: number;
}
export interface LocalModelSelection { baseUrl: string; answerModel: string }

/** Read-only discovery and synthetic checks. Never installs or downloads models. */
export class LocalModelDiscovery {
  private readonly fetchImpl: ModelTransportFetch;
  private readonly timeoutMs: number;

  constructor(options: { fetch?: ModelTransportFetch; timeoutMs?: number } = {}) {
    this.fetchImpl = modelEndpointFetch(options.fetch ?? fetch);
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async discover(baseUrl?: string): Promise<LocalModelDiscoveryResult[]> {
    const candidates = baseUrl === undefined
      ? ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1']
      : [baseUrl];
    return Promise.all(candidates.map(async candidate => {
      let normalized: URL;
      try { normalized = localBaseUrl(candidate); } catch {
        return { provider: 'openai-compatible' as const, baseUrl: '', models: [], working: false, step: 'endpoint' as const, detail: 'Use an HTTP or HTTPS loopback URL without credentials, query parameters or fragments.' };
      }
      const provider = normalized.port === '11434' ? 'ollama' : normalized.port === '1234' ? 'lm-studio' : 'openai-compatible';
      try {
        const ids = await this.models(normalized);
        const models = ids.map(id => ({ id, allowed: !isCloudForwardingModelId(id), ...(isCloudForwardingModelId(id) ? { reason: 'This cloud model can forward text off this computer and cannot be used as a local model.' } : {}) }));
        return { provider, baseUrl: normalized.href.replace(/\/$/, ''), models, working: true, step: 'models' as const, detail: models.length ? 'Choose an answer model.' : 'The server returned no installed models. Olympus does not download models.' };
      } catch (error) {
        return { provider, baseUrl: normalized.href.replace(/\/$/, ''), models: [], working: false, step: 'models' as const, detail: failureDetail(error) };
      }
    }));
  }

  async test(selection: LocalModelSelection): Promise<LocalModelTestResult> {
    let step: LocalModelStep = 'endpoint';
    try {
      const base = localBaseUrl(selection.baseUrl);
      // Validate both choices before even requesting the model list.
      step = 'answer';
      const answer = modelId(selection.answerModel);
      assertLocalModelIdNotCloudForwarding('Answer model', answer);
      step = 'models';
      const listed = await this.models(base);
      step = 'answer';
      if (!listed.includes(answer)) throw new CheckError('The selected answer model is not listed by this server. Refresh the models and choose an installed model.');
      step = 'answer';
      const completion = await this.request(base, 'chat/completions', {
        model: answer,
        messages: [{ role: 'user', content: 'Reply with one word: ready.' }],
        temperature: 0,
        max_tokens: 8,
      });
      const message = record(completion) && Array.isArray(completion.choices) && record(completion.choices[0]) ? completion.choices[0].message : undefined;
      if (!record(message) || typeof message.content !== 'string' || !message.content.trim()) {
        throw new CheckError('The answer model did not return text. Choose a model that supports chat completions.');
      }
      return { working: true, step: 'complete', detail: 'Working' };
    } catch (error) {
      return { working: false, step, detail: failureDetail(error) };
    }
  }

  private async models(base: URL): Promise<string[]> {
    const result = await this.request(base, 'models');
    if (!record(result) || !Array.isArray(result.data)) throw new CheckError('The server did not return an OpenAI-compatible model list. Check its API URL.');
    return [...new Set(result.data.flatMap(item => {
      if (!record(item) || typeof item.id !== 'string') return [];
      try { return [modelId(item.id)]; } catch { return []; }
    }))];
  }

  private async request(base: URL, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
    const { response, text } = await fetchBoundedText(this.fetchImpl, url.href, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }, { timeoutMs: this.timeoutMs, limitBytes: 256 * 1024 });
    if (!response.ok) throw new CheckError(`The local model server returned HTTP ${response.status}. Check the server and selected model.`);
    try { return JSON.parse(text); } catch { throw new CheckError('The local model server returned invalid JSON. Check its API URL.'); }
  }
}

/** Match the local readiness policy and use literal loopback for the request. */
function localBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CheckError('Use an HTTP or HTTPS loopback URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('?') || value.includes('#')
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new CheckError('Use an HTTP or HTTPS loopback URL without credentials, query parameters or fragments.');
  }
  // Do not rely on DNS even for localhost. All requests go to a literal loopback.
  if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
  if (url.pathname === '/' || !url.pathname) url.pathname = '/v1';
  return url;
}
function modelId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new CheckError('Choose a valid installed model ID.');
  return value.trim();
}
class CheckError extends Error {}
function failureDetail(error: unknown): string {
  if (error instanceof CheckError) return error.message;
  if (isModelEndpointRedirectError(error)) return 'The server returned a redirect. Olympus refuses redirects; use the server’s direct loopback API URL.';
  if (isAbortError(error)) return 'The local model check timed out. Start the model server or try again after the model has loaded.';
  // OperationError's policy message contains only the validated model ID, not response content.
  if (error instanceof Error && error.message.includes('reserved cloud-style tag')) return 'This cloud model can forward text off this computer. Choose a model that runs locally.';
  return 'Could not connect to the local model server. Start Ollama or LM Studio, or check the loopback API URL.';
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
