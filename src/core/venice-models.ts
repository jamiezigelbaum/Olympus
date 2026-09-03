import { OperationError } from './operation-error.ts';

export type VenicePrivacyCategory = 'anonymized' | 'private' | 'tee' | 'e2ee';

const VENICE_PRIVACY_CATEGORY_ORDER: Record<VenicePrivacyCategory, number> = {
  anonymized: 0,
  private: 1,
  tee: 2,
  e2ee: 3,
};

const VENICE_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'default': 'kimi-k3',
  'strong': 'kimi-k3',
  'strong-reasoning': 'kimi-k3',
  'reasoning': 'kimi-k3',
  'secure-reasoning': 'kimi-k3',
  'kimi': 'kimi-k3',
  'kimi-3': 'kimi-k3',
  'kimi-k-3': 'kimi-k3',
  'kimi-k3': 'kimi-k3',
  'normal': 'inkling',
  'normal-reasoning': 'inkling',
  'inkling': 'inkling',
  'most-secure': 'e2ee-glm-5-2-p',
  'slower-most-secure': 'e2ee-glm-5-2-p',
  'slow-most-secure': 'e2ee-glm-5-2-p',
  'glm-5-2-e2ee': 'e2ee-glm-5-2-p',
  'glm-5-2-ee2e': 'e2ee-glm-5-2-p',
  'glm-5-2-private': 'zai-org-glm-5-2',
  'glm-5-2-p': 'e2ee-glm-5-2-p',
  'e2ee-glm-5-2': 'e2ee-glm-5-2-p',
  'ee2e-glm-5-2': 'e2ee-glm-5-2-p',
  'venice-glm-5-2-e2ee': 'e2ee-glm-5-2-p',
  'venice-glm-5-2-ee2e': 'e2ee-glm-5-2-p',
  'venice-glm-5-2-private': 'zai-org-glm-5-2',
  'glm-5-2': 'zai-org-glm-5-2',
  'fast-reasoning': 'inkling',
  'faster-reasoning': 'inkling',
  'acceptable-reasoning': 'inkling',
  'glm-5-2-fast': 'zai-org-glm-5-2',
  'glm-5-2-acceptable': 'zai-org-glm-5-2',
  'glm-5-1-e2ee': 'e2ee-glm-5-1',
  'glm-5-1-ee2e': 'e2ee-glm-5-1',
  'e2ee-glm-5-1': 'e2ee-glm-5-1',
  'ee2e-glm-5-1': 'e2ee-glm-5-1',
  'venice-glm-5-1-e2ee': 'e2ee-glm-5-1',
  'venice-glm-5-1-ee2e': 'e2ee-glm-5-1',
  'glm-5-1': 'zai-org-glm-5-1',
  'qwen-3-6-35b-e2ee': 'e2ee-qwen3-6-35b-a3b',
  'qwen-3-6-35b-ee2e': 'e2ee-qwen3-6-35b-a3b',
  'qwen3-6-35b-e2ee': 'e2ee-qwen3-6-35b-a3b',
  'qwen3-6-35b-ee2e': 'e2ee-qwen3-6-35b-a3b',
  'qwen-3-6-35b-a3b-e2ee': 'e2ee-qwen3-6-35b-a3b',
  'qwen-3-6-35b-a3b-ee2e': 'e2ee-qwen3-6-35b-a3b',
  'qwen3-6-35b-a3b-e2ee': 'e2ee-qwen3-6-35b-a3b',
  'qwen3-6-35b-a3b-ee2e': 'e2ee-qwen3-6-35b-a3b',
  'vision': 'kimi-k3',
  'secure-vision': 'kimi-k3',
  'most-secure-vision': 'kimi-k3',
  'qwen-vision': 'qwen3-vl-235b-a22b',
  'qwen3-vl-vision': 'qwen3-vl-235b-a22b',
  'qwen-3-vl-vision': 'qwen3-vl-235b-a22b',
  'qwen3-vl-235b': 'qwen3-vl-235b-a22b',
  'qwen3-vl-235b-a22b': 'qwen3-vl-235b-a22b',
  'qwen-3-vl-235b': 'qwen3-vl-235b-a22b',
  'qwen-3-vl-235b-a22b': 'qwen3-vl-235b-a22b',
  'qwen3-vl-30b-e2ee': 'e2ee-qwen3-vl-30b-a3b-p',
  'qwen3-vl-30b-ee2e': 'e2ee-qwen3-vl-30b-a3b-p',
  'qwen3-vl-30b-a3b-e2ee': 'e2ee-qwen3-vl-30b-a3b-p',
  'qwen3-vl-30b-a3b-ee2e': 'e2ee-qwen3-vl-30b-a3b-p',
  'qwen-3-vl-30b-e2ee': 'e2ee-qwen3-vl-30b-a3b-p',
  'qwen-3-vl-30b-ee2e': 'e2ee-qwen3-vl-30b-a3b-p',
  // Grok is deprecated as a default (owner, 2026-07-29) but stays an approved
  // Private model: explicit grok-* names still resolve; tier labels do not.
  'vision-escalation': 'kimi-k3',
  'private-grok-4-3': 'grok-4-3',
  'grok-4-3-private': 'grok-4-3',
  'grok-4-3-vision': 'grok-4-3',
  'multimodal': 'kimi-k3',
  'fast-multimodal': 'kimi-k3',
  'faster-multimodal': 'kimi-k3',
  'acceptable-multimodal': 'kimi-k3',
  'grok-4-3': 'grok-4-3',
  'grok-4-3-multimodal': 'grok-4-3',
  'grok-4-5': 'grok-4-5',
  'grok-4-5-vision': 'grok-4-5',
  'private-grok-4-5': 'grok-4-5',
});

// Pinned provider metadata is the offline fallback for the Venice-published
// catalog authority in docs/CONTRACTS.md#venice-s4-policy-normative.
const VENICE_MODEL_PRIVACY_CATEGORIES: Readonly<Record<string, VenicePrivacyCategory>> = Object.freeze({
  'kimi-k3': 'private',
  'inkling': 'private',
  'e2ee-glm-5-2-p': 'e2ee',
  'zai-org-glm-5-2': 'private',
  'e2ee-glm-5-1': 'e2ee',
  'zai-org-glm-5-1': 'private',
  'e2ee-qwen3-6-35b-a3b': 'e2ee',
  'grok-4-5': 'private',
  'qwen3-vl-235b-a22b': 'private',
  'e2ee-qwen3-vl-30b-a3b-p': 'e2ee',
  'grok-4-3': 'private',
  'claude-opus-4-7-fast': 'anonymized',
  'qwen3-6-27b': 'private',
  'tee-qwen3-5-122b-a10b': 'tee',
});

export class VeniceModelPolicyDeniedError extends OperationError {
  readonly modelId: string;
  readonly privacyCategory: VenicePrivacyCategory | 'unknown';

  constructor(modelId: string, privacyCategory: VenicePrivacyCategory | undefined) {
    const category = privacyCategory ?? 'unknown';
    super(
      'source_index_policy_violation',
      `Venice model "${modelId}" has privacy category ${category}; secure_local evidence requires Venice category private or above.`,
      'Choose a Venice model published with private, TEE, or E2EE metadata. Policy refusals never fall back to another provider.',
    );
    this.name = 'VeniceModelPolicyDeniedError';
    this.modelId = modelId;
    this.privacyCategory = category;
  }
}

export function normalizeVeniceAnalystModelId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const key = trimmed
    .toLowerCase()
    .replace(/\bvenice\b/g, ' ')
    .replace(/\bgl m\b/g, 'glm')
    .replace(/\bqwen\s*3\.6\b/g, 'qwen-3-6')
    .replace(/\bqwen\s*3\s*vl\b/g, 'qwen3-vl')
    .replace(/\bgrok\s*4\.3\b/g, 'grok-4-3')
    .replace(/\bgrok\s*4\.5\b/g, 'grok-4-5')
    .replace(/\bglm\s*5\.2\b/g, 'glm-5-2')
    .replace(/\bglm\s*5\.1\b/g, 'glm-5-1')
    .replace(/\be2e\b/g, 'e2ee')
    .replace(/\bee2e\b/g, 'e2ee')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return VENICE_MODEL_ALIASES[key] ?? trimmed.toLowerCase();
}

export function venicePrivacyCategoryForModel(value: string): VenicePrivacyCategory | undefined {
  return VENICE_MODEL_PRIVACY_CATEGORIES[normalizeVeniceAnalystModelId(value)];
}

export function isVenicePrivacyCategoryApprovedForSecureLocal(
  category: VenicePrivacyCategory,
): boolean {
  return VENICE_PRIVACY_CATEGORY_ORDER[category] >= VENICE_PRIVACY_CATEGORY_ORDER.private;
}

export async function assertVeniceAnalystModelAllowed(
  modelId: string,
  containsSecureLocal: boolean,
  resolveCategory: (
    modelId: string,
    signal?: AbortSignal,
  ) => Promise<VenicePrivacyCategory | undefined> = async (value) => venicePrivacyCategoryForModel(value),
  signal?: AbortSignal,
): Promise<void> {
  if (!containsSecureLocal) return;
  const resolvedModelId = normalizeVeniceAnalystModelId(modelId);
  const category = await resolveCategory(resolvedModelId, signal);
  if (!category || !isVenicePrivacyCategoryApprovedForSecureLocal(category)) {
    throw new VeniceModelPolicyDeniedError(resolvedModelId, category);
  }
}

export function veniceAnalystModelAliasTargets(): readonly string[] {
  return [...new Set(Object.values(VENICE_MODEL_ALIASES))].sort();
}
