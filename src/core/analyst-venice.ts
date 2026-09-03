import {
  createOpenAICompatibleAnalystModel,
  type OpenAIAnalystFetch,
  type OpenAIReasoningEffort,
} from './analyst-openai.ts';
import type { AnalystModel } from './analyst.ts';
import {
  createVenicePrivacyCategoryResolver,
  type VeniceModelCatalogOptions,
} from './venice-model-catalog.ts';
import {
  assertVeniceAnalystModelAllowed,
  normalizeVeniceAnalystModelId,
} from './venice-models.ts';

export type VeniceThinkingMode = 'enabled' | 'disabled';

export interface VeniceAnalystModelOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningHeadroomTokens?: number;
  thinking?: VeniceThinkingMode;
  timeoutMs?: number;
  fetchImpl?: OpenAIAnalystFetch;
  catalog?: VeniceModelCatalogOptions;
}

export const DEFAULT_VENICE_ANALYST_MODEL = 'kimi-k3';
export const DEFAULT_VENICE_BASE_URL = 'https://api.venice.ai/api/v1';
export const DEFAULT_VENICE_REASONING_HEADROOM_TOKENS = 8_192;

export function createVeniceAnalystModel(options: VeniceAnalystModelOptions): AnalystModel {
  const thinking = options.thinking ?? 'enabled';
  const baseUrl = approvedVeniceAnalystBaseUrl(options.baseUrl ?? DEFAULT_VENICE_BASE_URL);
  const model = normalizeVeniceAnalystModelId(options.model ?? DEFAULT_VENICE_ANALYST_MODEL);
  const resolvePrivacyCategory = createVenicePrivacyCategoryResolver({
    apiKey: options.apiKey,
    baseUrl,
    ...(options.catalog ? { catalog: options.catalog } : {}),
  });
  const delegate = createOpenAICompatibleAnalystModel({
    apiKey: options.apiKey,
    model,
    baseUrl,
    reasoningEffort: options.reasoningEffort ?? 'high',
    reasoningHeadroomTokens: options.reasoningHeadroomTokens ?? DEFAULT_VENICE_REASONING_HEADROOM_TOKENS,
    serviceTier: false,
    maxTokensField: 'max_completion_tokens',
    providerLabel: 'Venice analyst',
    apiKeyHint: 'Set OLYMPUS_SOURCE_INDEX_VENICE_API_KEY, VENICE_API_KEY, API_KEY_VENICE, or Venice-API-Key in the assistant runtime.',
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    extraBody: {
      venice_parameters: {
        enable_web_search: 'off',
        enable_web_scraping: false,
        enable_web_citations: false,
        include_venice_system_prompt: false,
        strip_thinking_response: true,
        disable_thinking: thinking === 'disabled',
      },
    },
  });
  return {
    async complete(request) {
      // Dispatch enforcement for docs/CONTRACTS.md#venice-s4-policy-normative.
      await assertVeniceAnalystModelAllowed(
        model,
        request.localOnly,
        resolvePrivacyCategory,
        request.signal,
      );
      return delegate.complete(request);
    },
  };
}

export function approvedVeniceAnalystBaseUrl(rawBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error('Venice analyst requires the approved Venice HTTPS endpoint.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.venice.ai') {
    throw new Error('Venice analyst requires the approved Venice HTTPS endpoint.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}
