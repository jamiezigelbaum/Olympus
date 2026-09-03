import type { ArgusLane, ArgusModelProfile, OlympusConfig } from './config.ts';
import { OperationError } from './operation-error.ts';
import { resolveSecretRefValue } from './secret-store.ts';

export type DelphiFetch = (url: string, init: RequestInit) => Promise<Response>;
export type DelphiSecretResolver = (secretRef: string) => string | undefined | Promise<string | undefined>;

export interface DelphiRequestOptions {
  timeoutMs?: number;
}

export interface DelphiTransport {
  requestJson(
    url: string,
    init: RequestInit,
    lane: string,
    options?: DelphiRequestOptions,
  ): Promise<unknown>;
}

export interface DelphiModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  // The Delphi router reports the live backing model per profile here
  // (metadata.backendModel). Passed through verbatim so consumers can name
  // the model actually answering without hardcoding an id the router will
  // rotate without notice.
  metadata?: { backendModel?: string; [key: string]: unknown };
}

export interface DelphiPingResult {
  reachable: boolean;
  lane?: ArgusLane;
  profile?: ArgusModelProfile;
  base_url: string;
  model_count: number;
  latency_ms: number;
}

export interface DelphiCompletionResult {
  text: string;
  lane?: ArgusLane;
  profile?: ArgusModelProfile;
  model: string;
  usage?: unknown;
}

export interface DelphiClientOptions {
  resolveSecretRef?: DelphiSecretResolver;
}

export interface CompleteOptions {
  lane?: ArgusLane;
  profile?: ArgusModelProfile;
  prompt: string;
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export class DelphiClient {
  private config: OlympusConfig;
  private transport: DelphiTransport;
  private resolveSecretRef: DelphiSecretResolver;

  constructor(
    config: OlympusConfig,
    transport: DelphiTransport = createDelphiTransport(config),
    options: DelphiClientOptions = {},
  ) {
    this.config = config;
    this.transport = transport;
    this.resolveSecretRef = options.resolveSecretRef ?? resolveEnvSecretRef;
  }

  async ping(lane: ArgusLane): Promise<DelphiPingResult> {
    const startedAt = performance.now();
    const models = await this.listModels(lane);
    return {
      reachable: true,
      lane,
      base_url: this.config.argus.lanes[lane].baseUrl,
      model_count: models.length,
      latency_ms: Math.round(performance.now() - startedAt),
    };
  }

  async pingProfile(profile: ArgusModelProfile): Promise<DelphiPingResult> {
    const startedAt = performance.now();
    const models = await this.listModelsForProfile(profile);
    return {
      reachable: true,
      profile,
      base_url: this.config.argus.modelProfiles[profile].baseUrl,
      model_count: models.length,
      latency_ms: Math.round(performance.now() - startedAt),
    };
  }

  async listModels(lane: ArgusLane, signal?: AbortSignal): Promise<DelphiModel[]> {
    const laneConfig = this.config.argus.lanes[lane];
    const response = await this.fetchJson(
      `${laneConfig.baseUrl}/models`,
      await this.withAuth({
        method: 'GET',
        ...(signal ? { signal } : {}),
      }, laneConfig.secretRef),
      lane,
    );
    const data = response as { data?: unknown };
    if (!Array.isArray(data.data)) {
      throw new OperationError('argus_error', 'Argus models response did not include a data array.');
    }
    return data.data.map((item) => normalizeModel(item));
  }

  async listModelsForProfile(profile: ArgusModelProfile, signal?: AbortSignal): Promise<DelphiModel[]> {
    const profileConfig = this.config.argus.modelProfiles[profile];
    const response = await this.fetchJson(
      `${profileConfig.baseUrl}/models`,
      await this.withAuth({
        method: 'GET',
        ...(signal ? { signal } : {}),
      }, profileConfig.secretRef),
      `profile:${profile}`,
    );
    const data = response as { data?: unknown };
    if (!Array.isArray(data.data)) {
      throw new OperationError('argus_error', 'Argus models response did not include a data array.');
    }
    return data.data.map((item) => normalizeModel(item));
  }

  async complete(options: CompleteOptions): Promise<DelphiCompletionResult> {
    const route = this.resolveRoute(options);
    const model = options.model || route.model;
    const messages = [
      ...(options.system ? [{ role: 'system', content: options.system }] : []),
      { role: 'user', content: options.prompt },
    ];

    const response = await this.fetchJson(
      `${route.baseUrl}/chat/completions`,
      await this.withAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(options.signal ? { signal: options.signal } : {}),
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 2048,
          chat_template_kwargs: { enable_thinking: false },
        }),
      }, route.secretRef),
      route.errorLabel,
      options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : undefined,
    );

    const data = response as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new OperationError('argus_error', 'Argus completion response did not include message content.');
    }
    return {
      text,
      ...(options.lane ? { lane: options.lane } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      model: data.model || model,
      ...(data.usage !== undefined ? { usage: data.usage } : {}),
    };
  }

  private resolveRoute(options: CompleteOptions): { baseUrl: string; model: string; errorLabel: string; secretRef?: string } {
    if (options.profile) {
      const profileConfig = this.config.argus.modelProfiles[options.profile];
      return {
        baseUrl: profileConfig.baseUrl,
        model: profileConfig.model,
        errorLabel: `profile:${options.profile}`,
        ...(profileConfig.secretRef ? { secretRef: profileConfig.secretRef } : {}),
      };
    }
    const lane = options.lane ?? this.config.argus.defaultLane;
    const laneConfig = this.config.argus.lanes[lane];
    return {
      baseUrl: laneConfig.baseUrl,
      model: laneConfig.model,
      errorLabel: lane,
      ...(laneConfig.secretRef ? { secretRef: laneConfig.secretRef } : {}),
    };
  }

  private async withAuth(init: RequestInit, secretRef: string | undefined): Promise<RequestInit> {
    if (!secretRef) return init;
    const token = (await this.resolveSecretRef(secretRef))?.trim();
    if (!token) {
      throw new OperationError(
        'config_error',
        `Argus route secretRef ${redactedSecretRefLabel(secretRef)} did not resolve.`,
        'Configure the referenced environment variable before using this model lane.',
      );
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    lane: string,
    options?: DelphiRequestOptions,
  ): Promise<unknown> {
    return this.transport.requestJson(url, init, lane, options);
  }
}

function resolveEnvSecretRef(secretRef: string): Promise<string | undefined> {
  return resolveSecretRefValue(secretRef);
}

function redactedSecretRefLabel(secretRef: string): string {
  const trimmed = secretRef.trim();
  if (trimmed.startsWith('env:')) return `env:${trimmed.slice('env:'.length).trim()}`;
  if (trimmed.startsWith('store:')) return `store:${trimmed.slice('store:'.length).trim()}`;
  return 'configured secretRef';
}

export function createDelphiTransport(config: OlympusConfig): DelphiTransport {
  return new DirectHttpDelphiTransport(fetch, config.argus.requestTimeoutSeconds * 1000);
}

export class DirectHttpDelphiTransport implements DelphiTransport {
  private fetchImpl: DelphiFetch;
  private timeoutMs: number;

  constructor(fetchImpl: DelphiFetch = fetch, timeoutMs = 0) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async requestJson(
    url: string,
    init: RequestInit,
    lane: string,
    options: DelphiRequestOptions = {},
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, init, timeoutMs);
    } catch (firstError) {
      if (isAbortError(firstError)) {
        throw argusTimeoutError(lane, url, timeoutMs);
      }
      // A restarted model server leaves stale keep-alive sockets in this
      // process's connection pool; the first reuse fails at the connection
      // level. One immediate retry gets a fresh socket. Anything that fails
      // twice is genuinely unreachable.
      try {
        response = await this.fetchWithTimeout(url, init, timeoutMs);
      } catch (secondError) {
        if (isAbortError(secondError)) {
          throw argusTimeoutError(lane, url, timeoutMs);
        }
        throw new OperationError(
          'argus_unreachable',
          `Argus ${lane} lane is unreachable at ${url}.`,
          firstError instanceof Error ? firstError.message : 'Check that the Argus endpoint is running or tunneled.',
        );
      }
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new OperationError(
        'argus_error',
        `Argus ${lane} lane returned HTTP ${response.status}.`,
        body || 'Check the local model endpoint logs.',
      );
    }

    return response.json();
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    if (timeoutMs <= 0) return this.fetchImpl(url, init);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abortFromCaller();
    else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function normalizeModel(item: unknown): DelphiModel {
  if (typeof item === 'string') return { id: item };
  if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
    return item as DelphiModel;
  }
  throw new OperationError('argus_error', 'Argus model entry did not include an id.');
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function argusTimeoutError(lane: string, url: string, timeoutMs: number): OperationError {
  return new OperationError(
    'argus_unreachable',
    `Argus ${lane} lane timed out at ${url} after ${timeoutMs}ms.`,
    'The local model lane did not complete within the configured request budget; failing closed instead of leaving the caller waiting indefinitely.',
  );
}
