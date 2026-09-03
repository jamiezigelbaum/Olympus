import {
  buildSourceIndexStorageProfile,
  buildSourceSensitivity,
  type SourceFamily,
  type SourceIndexStorageProfile,
  type SourceIndexStorageProfileInput,
  type SourceSensitivity,
  type SourceSensitivityInput,
  type SourceTrustDomain,
  type SourceTrustTier,
} from './types.ts';

export const SOURCE_INDEX_ACTIVATION_MODES = ['lexical_only', 'hybrid_shadow', 'hybrid_primary'] as const;
export const SOURCE_INDEX_EMBEDDING_POLICIES = ['disabled', 'local_only', 'cloud_allowed_by_policy', 'cloud_allowed'] as const;

export type SourceIndexActivationMode = (typeof SOURCE_INDEX_ACTIVATION_MODES)[number];
export type SourceIndexCorpusEmbeddingPolicy = (typeof SOURCE_INDEX_EMBEDDING_POLICIES)[number];

export interface SourceIndexCorpusDefinition {
  corpusId: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  activationMode: SourceIndexActivationMode;
  storageProfile: SourceIndexStorageProfile;
  defaultSensitivity: SourceSensitivity;
  embeddingPolicy: SourceIndexCorpusEmbeddingPolicy;
  description?: string;
}

export type SourceIndexCorpusDefinitionInput = {
  corpusId: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  activationMode?: SourceIndexActivationMode;
  storageProfile?: SourceIndexStorageProfile;
  storageProfileInput?: Omit<SourceIndexStorageProfileInput, 'trustDomain'>;
  defaultSensitivity?: SourceSensitivityInput;
  embeddingPolicy?: SourceIndexCorpusEmbeddingPolicy;
  description?: string;
};

export interface SourceIndexCorpusRegistry {
  get(corpusId: string): SourceIndexCorpusDefinition | undefined;
  require(corpusId: string): SourceIndexCorpusDefinition;
  list(): SourceIndexCorpusDefinition[];
  select(filters?: SourceIndexCorpusSelection): SourceIndexCorpusDefinition[];
}

export interface SourceIndexCorpusSelection {
  corpusIds?: readonly string[];
  families?: readonly SourceFamily[];
  trustDomains?: readonly SourceTrustDomain[];
}

export function defineSourceIndexCorpus(input: SourceIndexCorpusDefinitionInput): SourceIndexCorpusDefinition {
  const corpusId = input.corpusId.trim();
  if (!corpusId) {
    throw new Error('Source-index corpus definitions require a corpus id.');
  }

  const storageProfile =
    input.storageProfile ??
    buildSourceIndexStorageProfile({
      trustDomain: input.trustDomain,
      ...input.storageProfileInput,
    });
  if (storageProfile.trustDomain !== input.trustDomain) {
    throw new Error('Source-index corpus storage profile trust domain must match the corpus trust domain.');
  }

  const defaultSensitivity = buildSourceSensitivity(
    input.defaultSensitivity ?? {
      trustTier: defaultTrustTierForDomain(input.trustDomain),
      trustDomain: input.trustDomain,
      cloudEmbeddingEligible: storageProfile.embeddingBackend === 'cloud',
    },
  );
  if (defaultSensitivity.trustDomain !== input.trustDomain) {
    throw new Error('Source-index corpus default sensitivity trust domain must match the corpus trust domain.');
  }

  const embeddingPolicy = input.embeddingPolicy ?? defaultEmbeddingPolicyForStorage(storageProfile);
  assertEmbeddingPolicyMatchesStorage(embeddingPolicy, storageProfile);

  return {
    corpusId,
    family: input.family,
    trustDomain: input.trustDomain,
    activationMode: input.activationMode ?? 'lexical_only',
    storageProfile,
    defaultSensitivity,
    embeddingPolicy,
    ...(input.description ? { description: input.description } : {}),
  };
}

export function buildSourceIndexCorpusRegistry(corpora: readonly SourceIndexCorpusDefinition[]): SourceIndexCorpusRegistry {
  const byId = new Map<string, SourceIndexCorpusDefinition>();
  for (const corpus of corpora) {
    if (byId.has(corpus.corpusId)) {
      throw new Error(`Duplicate source-index corpus id "${corpus.corpusId}".`);
    }
    byId.set(corpus.corpusId, corpus);
  }

  return {
    get(corpusId: string): SourceIndexCorpusDefinition | undefined {
      return byId.get(corpusId);
    },
    require(corpusId: string): SourceIndexCorpusDefinition {
      const corpus = byId.get(corpusId);
      if (!corpus) {
        throw new Error(`Unknown source-index corpus "${corpusId}".`);
      }
      return corpus;
    },
    list(): SourceIndexCorpusDefinition[] {
      return Array.from(byId.values());
    },
    select(filters?: SourceIndexCorpusSelection): SourceIndexCorpusDefinition[] {
      return Array.from(byId.values()).filter((corpus) => corpusMatchesSelection(corpus, filters));
    },
  };
}

function corpusMatchesSelection(corpus: SourceIndexCorpusDefinition, filters: SourceIndexCorpusSelection | undefined): boolean {
  if (!filters) return true;
  if (filters.corpusIds && !filters.corpusIds.includes(corpus.corpusId)) return false;
  if (filters.families && !filters.families.includes(corpus.family)) return false;
  if (filters.trustDomains && !filters.trustDomains.includes(corpus.trustDomain)) return false;
  return true;
}

function defaultTrustTierForDomain(trustDomain: SourceTrustDomain): SourceTrustTier {
  if (trustDomain === 'secure_local') return 'S4';
  if (trustDomain === 'public_safe') return 'S0';
  return 'S3';
}

function defaultEmbeddingPolicyForStorage(storageProfile: SourceIndexStorageProfile): SourceIndexCorpusEmbeddingPolicy {
  if (storageProfile.embeddingBackend === 'none') return 'disabled';
  if (storageProfile.embeddingBackend === 'local') return 'local_only';
  if (storageProfile.trustDomain === 'public_safe') return 'cloud_allowed';
  return 'cloud_allowed_by_policy';
}

function assertEmbeddingPolicyMatchesStorage(
  embeddingPolicy: SourceIndexCorpusEmbeddingPolicy,
  storageProfile: SourceIndexStorageProfile,
): void {
  if (storageProfile.embeddingBackend === 'cloud' && embeddingPolicy === 'local_only') {
    throw new Error('Cloud embedding storage cannot use a local-only corpus embedding policy.');
  }
  if (storageProfile.embeddingBackend === 'local' && embeddingPolicy === 'cloud_allowed') {
    throw new Error('Local embedding storage cannot use an always-cloud corpus embedding policy.');
  }
  if (storageProfile.trustDomain === 'secure_local' && embeddingPolicy.startsWith('cloud_')) {
    throw new Error('secure_local corpora cannot use cloud embedding policies.');
  }
}
