import { fetchBoundedText } from './http-timeout.ts';
import type {
  SovereigntyConfig,
  SovereigntyModelProfile,
  SovereigntyTrustDomainPolicy,
} from './sovereignty.ts';
import { canonicalEmbeddingDimension } from '../workers/source-index/embedding-identity.ts';

export interface ModelSetupCard {
  id: 'gemini' | 'venice' | 'local';
  label: string;
  required: boolean;
  state: 'not_configured' | 'applying' | 'needs_attention' | 'ready';
  detail: string;
}

export interface ModelSetupView {
  ready: boolean;
  checked_at: string;
  cards: ModelSetupCard[];
  attention?: string;
}

export type ModelCredentialState = 'missing' | 'applying' | 'ready';

export interface ModelSetupServiceOptions {
  config: SovereigntyConfig;
  credentialState: (id: string, profile: SovereigntyModelProfile) => ModelCredentialState;
  localApiKey?: (profileId: string) => string | undefined;
  expectedEmbeddingDimension?: (profileId: string) => number | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

type RequiredProfile = { id: string; profile: SovereigntyModelProfile };
type LocalUsage = RequiredProfile & { analyst: boolean; embedding: boolean };
type LocalTarget = LocalUsage & { apiKey?: string; baseUrl: URL; model: string; expectedEmbeddingDimension?: number };
type LocalCheckState = Extract<ModelSetupCard['state'], 'not_configured' | 'applying' | 'needs_attention' | 'ready'>;

const DOMAINS = ['public_safe', 'internal', 'secure_local'] as const;
const LOCAL_REQUEST_TIMEOUT_MS = 5_000;
const LOCAL_RESPONSE_LIMIT_BYTES = 64 * 1024;

const CARD_COPY: Record<ModelSetupCard['id'], {
  label: string;
  missing: string;
  applying: string;
  ready: string;
}> = {
  gemini: {
    label: 'Gemini',
    missing: 'Gemini makes Public and Personal content searchable. Add its API key to continue.',
    applying: 'Applying the Gemini key.',
    ready: 'The Gemini key is connected.',
  },
  venice: {
    label: 'Venice',
    missing: 'Venice handles Private data according to your privacy choice. Add its API key to continue.',
    applying: 'Applying the Venice key.',
    ready: 'The Venice key is connected.',
  },
  local: {
    label: 'Local models',
    missing: 'Configure the required local model credential before checking the server.',
    applying: 'Local model credentials are being applied.',
    ready: 'The required local model checks passed.',
  },
};

const LOCAL_UNCHECKED_DETAIL = 'Check the configured local models to verify their model IDs and required endpoints.';
const LOCAL_CHECKING_DETAIL = 'Checking the configured local model server.';
const LOCAL_ATTENTION_DETAIL = 'Start the configured loopback model server and verify its model IDs and required endpoints.';

/**
 * Resolve only profiles that the effective policy can use. Stored alternatives
 * are not setup prerequisites until an active analyst route or hybrid
 * retrieval policy references them.
 */
export function requiredModelProfiles(config: SovereigntyConfig): RequiredProfile[] {
  const required = new Map<string, SovereigntyModelProfile>();

  for (const domain of DOMAINS) {
    const route = config.routes[domain];
    if (!route || route.mode === 'disabled') continue;
    const ids = route.pool?.members ?? route.analyst ?? [];
    for (const id of ids) {
      const profile = config.modelProfiles[id];
      if (profile && !required.has(id)) required.set(id, profile);
    }
  }

  for (const domain of DOMAINS) {
    const policy = config.retrieval.trustDomains[domain];
    if (!policy?.embeddingProfile || !isActiveEmbeddingMode(policy.activationMode)) continue;
    const profile = config.modelProfiles[policy.embeddingProfile];
    if (profile && !required.has(policy.embeddingProfile)) {
      required.set(policy.embeddingProfile, profile);
    }
  }

  return [...required].map(([id, profile]) => ({ id, profile }));
}

export class ModelSetupService {
  private readonly config: SovereigntyConfig;
  private readonly credentialState: ModelSetupServiceOptions['credentialState'];
  private readonly localApiKey: ModelSetupServiceOptions['localApiKey'];
  private readonly expectedEmbeddingDimension: ModelSetupServiceOptions['expectedEmbeddingDimension'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private localCheckState: LocalCheckState = 'not_configured';
  private localCheckPromise: Promise<ModelSetupView> | undefined;

  constructor(options: ModelSetupServiceOptions) {
    this.config = options.config;
    this.credentialState = options.credentialState;
    this.localApiKey = options.localApiKey;
    this.expectedEmbeddingDimension = options.expectedEmbeddingDimension;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  getStatus(): ModelSetupView {
    const required = requiredModelProfiles(this.config);
    const cards: ModelSetupCard[] = [];

    const gemini = required.filter(({ profile }) => profile.provider === 'google-gemini');
    if (gemini.length > 0) cards.push(this.credentialCard('gemini', gemini));

    const venice = required.filter(({ profile }) => profile.provider === 'venice');
    if (venice.length > 0) cards.push(this.credentialCard('venice', venice));

    const local = required.filter(({ profile }) => profile.provider === 'local-openai-compatible');
    if (local.length > 0) cards.push(this.localCard(local));

    const additional = required.filter(({ profile }) => !['google-gemini', 'venice', 'local-openai-compatible', 'openclaw-infer'].includes(profile.provider));
    const additionalReady = this.aggregateCredentialState(additional) === 'ready';
    return {
      ready: additionalReady && cards.every((card) => card.state === 'ready'),
      ...(!additionalReady ? { attention: 'An additional model provider in your policy needs agent-assisted setup. These key forms manage Gemini and Venice only.' } : {}),
      checked_at: this.now().toISOString(),
      cards,
    };
  }

  checkLocalModels(): Promise<ModelSetupView> {
    if (this.localCheckPromise) return this.localCheckPromise;

    const local = this.localUsages();
    if (local.length === 0) return Promise.resolve(this.getStatus());

    const credentials = this.aggregateCredentialState(local);
    if (credentials !== 'ready') {
      this.localCheckState = 'not_configured';
      return Promise.resolve(this.getStatus());
    }

    const targets = this.localTargets(local);
    if (!targets) {
      this.localCheckState = 'needs_attention';
      return Promise.resolve(this.getStatus());
    }

    this.localCheckState = 'applying';
    const check = this.runLocalChecks(targets)
      .then((ready) => {
        this.localCheckState = ready ? 'ready' : 'needs_attention';
        return this.getStatus();
      })
      .catch(() => {
        this.localCheckState = 'needs_attention';
        return this.getStatus();
      })
      .finally(() => {
        this.localCheckPromise = undefined;
      });
    this.localCheckPromise = check;
    return check;
  }

  private credentialCard(id: 'gemini' | 'venice', profiles: RequiredProfile[]): ModelSetupCard {
    const state = this.aggregateCredentialState(profiles);
    const copy = CARD_COPY[id];
    return {
      id,
      label: copy.label,
      required: true,
      state: state === 'missing' ? 'not_configured' : state,
      detail: state === 'missing' ? copy.missing : state === 'applying' ? copy.applying : copy.ready,
    };
  }

  private localCard(profiles: RequiredProfile[]): ModelSetupCard {
    const credential = this.aggregateCredentialState(profiles);
    const copy = CARD_COPY.local;
    if (credential === 'missing') {
      return { id: 'local', label: copy.label, required: true, state: 'not_configured', detail: copy.missing };
    }
    if (credential === 'applying') {
      return { id: 'local', label: copy.label, required: true, state: 'applying', detail: copy.applying };
    }
    const detail = this.localCheckState === 'ready'
      ? copy.ready
      : this.localCheckState === 'applying'
        ? LOCAL_CHECKING_DETAIL
        : this.localCheckState === 'needs_attention'
          ? LOCAL_ATTENTION_DETAIL
          : LOCAL_UNCHECKED_DETAIL;
    return {
      id: 'local',
      label: copy.label,
      required: true,
      state: this.localCheckState,
      detail,
    };
  }

  private aggregateCredentialState(profiles: RequiredProfile[]): ModelCredentialState {
    let applying = false;
    for (const { id, profile } of profiles) {
      let state: ModelCredentialState;
      try {
        state = this.credentialState(id, profile);
      } catch {
        return 'missing';
      }
      if (state === 'missing') return 'missing';
      if (state === 'applying') applying = true;
    }
    return applying ? 'applying' : 'ready';
  }

  private localUsages(): LocalUsage[] {
    const usages = new Map<string, LocalUsage>();
    const add = (id: string, role: 'analyst' | 'embedding') => {
      const profile = this.config.modelProfiles[id];
      if (!profile || profile.provider !== 'local-openai-compatible') return;
      const usage = usages.get(id) ?? { id, profile, analyst: false, embedding: false };
      usage[role] = true;
      usages.set(id, usage);
    };

    for (const domain of DOMAINS) {
      const route = this.config.routes[domain];
      if (!route || route.mode === 'disabled') continue;
      for (const id of route.pool?.members ?? route.analyst ?? []) add(id, 'analyst');
    }
    for (const domain of DOMAINS) {
      const policy = this.config.retrieval.trustDomains[domain];
      if (policy?.embeddingProfile && isActiveEmbeddingMode(policy.activationMode)) {
        add(policy.embeddingProfile, 'embedding');
      }
    }
    return [...usages.values()];
  }

  private localTargets(usages: LocalUsage[]): LocalTarget[] | undefined {
    const targets: LocalTarget[] = [];
    for (const usage of usages) {
      const baseUrl = safeLocalBaseUrl(usage.profile.baseUrl);
      if (!baseUrl) return undefined;
      const model = usage.profile.model?.trim();
      if (!model) return undefined;
      let apiKey: string | undefined;
      if (usage.profile.secretRef) {
        try { apiKey = this.localApiKey?.(usage.id); } catch { return undefined; }
        if (!apiKey || /[\r\n\0]/.test(apiKey)) return undefined;
      }

      let expectedEmbeddingDimension: number | undefined;
      if (usage.embedding) {
        if (this.expectedEmbeddingDimension) {
          try {
            expectedEmbeddingDimension = this.expectedEmbeddingDimension(usage.id);
          } catch {
            return undefined;
          }
          if (typeof expectedEmbeddingDimension !== 'number'
            || !Number.isSafeInteger(expectedEmbeddingDimension)
            || expectedEmbeddingDimension < 1) {
            return undefined;
          }
        } else {
          expectedEmbeddingDimension = canonicalEmbeddingDimension(model);
        }
      }
      targets.push({
        ...usage,
        ...(apiKey ? { apiKey } : {}),
        baseUrl,
        model,
        ...(expectedEmbeddingDimension !== undefined ? { expectedEmbeddingDimension } : {}),
      });
    }
    return targets;
  }

  private async runLocalChecks(targets: LocalTarget[]): Promise<boolean> {
    for (const target of targets) {
      if (!await this.modelIsListed(target.baseUrl, target.model, target.apiKey)) return false;
      if (target.analyst && !await this.chatCompletes(target.baseUrl, target.model, target.apiKey)) return false;
      if (target.embedding && !await this.embeddingCompletes(
        target.baseUrl,
        target.model,
        target.expectedEmbeddingDimension,
        target.apiKey,
      )) return false;
    }
    return true;
  }

  private async modelIsListed(baseUrl: URL, model: string, apiKey?: string): Promise<boolean> {
    const result = await this.requestJson(endpoint(baseUrl, 'models'), { method: 'GET' }, apiKey);
    if (!isRecord(result) || !Array.isArray(result.data)) return false;
    return result.data.some((item) => isRecord(item) && item.id === model);
  }

  private async chatCompletes(baseUrl: URL, model: string, apiKey?: string): Promise<boolean> {
    const result = await this.requestJson(endpoint(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with one word: ready.' }],
        temperature: 0,
        max_tokens: 8,
      }),
    }, apiKey);
    if (!isRecord(result) || !Array.isArray(result.choices)) return false;
    const first = result.choices[0];
    const message = isRecord(first) ? first.message : undefined;
    return isRecord(message) && typeof message.content === 'string' && message.content.trim().length > 0;
  }

  private async embeddingCompletes(
    baseUrl: URL,
    model: string,
    expectedDimension: number | undefined,
    apiKey?: string,
  ): Promise<boolean> {
    const result = await this.requestJson(endpoint(baseUrl, 'embeddings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'Olympus model readiness check.' }),
    }, apiKey);
    if (!isRecord(result) || !Array.isArray(result.data)) return false;
    const first = result.data[0];
    const vector = isRecord(first) ? first.embedding : undefined;
    if (!Array.isArray(vector) || vector.length === 0
      || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return false;
    }
    return expectedDimension === undefined || vector.length === expectedDimension;
  }

  private async requestJson(url: string, init: RequestInit, apiKey?: string): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    const { response, text } = await fetchBoundedText(this.fetchImpl, url, {
      ...init,
      headers,
      redirect: 'error',
    }, {
      timeoutMs: LOCAL_REQUEST_TIMEOUT_MS,
      limitBytes: LOCAL_RESPONSE_LIMIT_BYTES,
    });
    if (!response.ok || response.redirected || response.status >= 300) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}

function isActiveEmbeddingMode(
  mode: SovereigntyTrustDomainPolicy['activationMode'],
): boolean {
  return mode === 'hybrid_shadow' || mode === 'hybrid_primary';
}

function safeLocalBaseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || value.includes('?')
      || value.includes('#')
      || url.search !== ''
      || url.hash !== ''
      || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function endpoint(baseUrl: URL, suffix: string): string {
  const url = new URL(baseUrl.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`;
  return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
