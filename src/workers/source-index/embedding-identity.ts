// The ONE place an embedding identity is constructed.
//
// An embedding identity is the tuple that determines what a stored vector
// MEANS: provider kind, model id, backend, dimension, and the epoch string
// that names the generation those vectors belong to. Every store in this repo
// records it, and `connectorStoreEmbeddingWriteAuthorityMatches` invalidates a
// whole corpus when the live provider's tuple stops matching the stored one —
// so two code paths that disagree about the SAME provider do not produce a
// cosmetic difference, they produce a vector wipe.
//
// They did disagree, live, on the private host (2026-08-24):
//
//   local:openai-compatible:secure-local-qwen3-embed:2560          (config-supplied)
//   local:local-openai-compatible:secure-local-qwen3-embed:provider-reported
//                                                                  (code default)
//
// Same endpoint, same model, same vectors, two epochs, alternating by which
// factory happened to build the provider. And because the config-supplied
// epoch rode a provider-BLIND environment variable
// (OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH), the local lane's epoch was also
// stamped onto genuinely-Gemini rows in the X and Readwise connector stores.
//
// The fix is structural: the epoch is DERIVED here, from the family
// descriptor, and nowhere else. There are no epoch literals in provider code.
//
// ## Why the two canonical strings look asymmetric
//
// The local family carries its dimension in the epoch; the Gemini family
// carries the token `provider-reported`. That is not tidy, and it is not
// negotiable: both strings are already written across live corpora, and an
// epoch string IS the vectors' identity. Changing one does not relabel
// vectors, it invalidates them. The canon is frozen at the value the live
// vectors were minted under, and any owner-approved change is a re-embed,
// not an edit here.
//
// The Gemini dimension token is stable for a second reason too: dimension is
// its own field in the write-authority tuple, so a genuine dimension change is
// already caught there. The epoch does not need to restate it, and when it
// tried to (a required-dimension change on 2026-08-17 flipped the derived
// Gemini epoch from `provider-reported` to `3072`) the only effect was to
// desynchronize new writes from every vector already stored.

import { OperationError } from '../../core/operation-error.ts';

export type EmbeddingIdentityBackend = 'local' | 'cloud';

/**
 * How one provider family spells itself inside an epoch string.
 *
 * `epochProviderToken` is deliberately allowed to differ from the runtime
 * provider kind. The local OpenAI-compatible provider reports its kind as
 * `local-openai-compatible` (which is what the write-authority tuple and the
 * sovereignty config compare on), but every live vector was minted under an
 * epoch that says `openai-compatible` — the backend segment already carries
 * `local`, so the prefix was redundant there and was dropped when the epoch
 * was first written by hand. The token map is what lets the runtime keep its
 * precise kind while the epoch keeps the string the corpus was built on.
 */
interface EmbeddingProviderFamily {
  readonly providerKind: string;
  readonly epochProviderToken: string;
  readonly dimensionToken: 'declared' | 'provider-reported';
}

const PROVIDER_REPORTED_DIMENSION_TOKEN = 'provider-reported';

const EMBEDDING_PROVIDER_FAMILIES: readonly EmbeddingProviderFamily[] = [
  {
    providerKind: 'local-openai-compatible',
    epochProviderToken: 'openai-compatible',
    dimensionToken: 'declared',
  },
  {
    providerKind: 'google-gemini',
    epochProviderToken: 'google-gemini',
    dimensionToken: PROVIDER_REPORTED_DIMENSION_TOKEN,
  },
];

// Any provider without a declared family — the deterministic test providers,
// and anything added later — keeps the plain shape: its own kind as the token
// and its declared dimension. This is what the shape was before the families
// existed, so unfamiliar providers are unaffected by this module.
function embeddingProviderFamily(providerKind: string): EmbeddingProviderFamily {
  return declaredEmbeddingProviderFamily(providerKind)
    ?? { providerKind, epochProviderToken: providerKind, dimensionToken: 'declared' };
}

function declaredEmbeddingProviderFamily(
  providerKind: string,
): EmbeddingProviderFamily | undefined {
  return EMBEDDING_PROVIDER_FAMILIES.find((family) => family.providerKind === providerKind);
}

export interface EmbeddingEpochInput {
  provider: string;
  modelId: string;
  backend: EmbeddingIdentityBackend;
  dimension: number | undefined;
}

/**
 * The single epoch template. Four colon-separated segments:
 * `<backend>:<providerToken>:<modelId>:<dimensionToken>`.
 */
export function buildEmbeddingEpoch(input: EmbeddingEpochInput): string {
  const family = embeddingProviderFamily(input.provider);
  const dimension = family.dimensionToken === PROVIDER_REPORTED_DIMENSION_TOKEN
    ? PROVIDER_REPORTED_DIMENSION_TOKEN
    : declaredDimensionToken(input.dimension);
  return `${input.backend}:${family.epochProviderToken}:${input.modelId}:${dimension}`;
}

function declaredDimensionToken(dimension: number | undefined): string {
  return dimension !== undefined && Number.isSafeInteger(dimension) && dimension >= 1
    ? String(dimension)
    : PROVIDER_REPORTED_DIMENSION_TOKEN;
}

/**
 * The epoch prefix that identifies a family: `<backend>:<providerToken>:`.
 * Two epochs sharing it describe the same provider running the same way; two
 * that do not describe different machinery entirely.
 */
export function embeddingEpochFamilyPrefix(input: {
  provider: string;
  backend: EmbeddingIdentityBackend;
}): string {
  return `${input.backend}:${embeddingProviderFamily(input.provider).epochProviderToken}:`;
}

export interface CanonicalEmbeddingIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly backend: EmbeddingIdentityBackend;
  readonly dimension: number;
  readonly epochId: string;
}

function canonicalIdentity(input: {
  provider: string;
  modelId: string;
  backend: EmbeddingIdentityBackend;
  dimension: number;
}): CanonicalEmbeddingIdentity {
  return { ...input, epochId: buildEmbeddingEpoch(input) };
}

/**
 * The models Olympus actually runs, and the identity their live vectors were
 * minted under. Owner-gated: adding a model here is a configuration decision,
 * and changing an existing entry's dimension or epoch invalidates a corpus.
 *
 * The epochs are DERIVED, never typed in — `test/embedding-identity.test.ts`
 * asserts each derived value against the frozen literal, so a change to the
 * template that would silently relabel a live corpus fails there instead of
 * on the private host.
 */
export const CANONICAL_EMBEDDING_IDENTITIES: readonly CanonicalEmbeddingIdentity[] = [
  canonicalIdentity({
    provider: 'local-openai-compatible',
    modelId: 'secure-local-qwen3-embed',
    backend: 'local',
    dimension: 2560,
  }),
  canonicalIdentity({
    provider: 'google-gemini',
    modelId: 'gemini-embedding-2',
    backend: 'cloud',
    dimension: 3072,
  }),
];

export function canonicalEmbeddingIdentityForModel(
  modelId: string,
): CanonicalEmbeddingIdentity | undefined {
  return CANONICAL_EMBEDDING_IDENTITIES.find((identity) => identity.modelId === modelId);
}

/**
 * The dimension a canonical model is known to emit, for callers that have no
 * configured dimension of their own.
 *
 * The email lane is the reason this exists: its provider factory never carried
 * a dimension, so it defaulted to 0, which rendered as `provider-reported` and
 * became the alternating half of the live epoch flip. Reading the canonical
 * dimension makes the email lane and the source-index lane agree by
 * construction instead of by configuration.
 */
export function canonicalEmbeddingDimension(modelId: string): number | undefined {
  return canonicalEmbeddingIdentityForModel(modelId)?.dimension;
}

/**
 * The epoch a provider will write, honouring an operator override unless the
 * override belongs to a DIFFERENT provider.
 *
 * Overrides stay supported, and deliberately loosely: bumping the epoch is how
 * an operator forces a re-embed, and live epochs have carried dated tokens
 * (`local:delphi:secure-local-qwen3-embed:2026-07-09`) and hand-written
 * provider spellings for as long as there have been epochs. None of that is a
 * problem — an epoch is a generation marker for THESE vectors.
 *
 * What is refused is the defect this module exists for: one provider-blind
 * environment variable on the private host carried the local qwen3 epoch and was applied
 * to whichever provider the factory happened to build, so Gemini vectors
 * ended up labelled with a local model's epoch. Two signals catch that
 * without catching a legitimate bump — an override cannot cross the
 * local/cloud backend line, and it cannot name a canonical model that is not
 * the one being embedded.
 *
 * The refusal is scoped to providers that HAVE a declared family. Test doubles
 * standing in for a real provider routinely carry that provider's epoch, and
 * nothing they write reaches a live corpus.
 */
export function resolveEmbeddingEpoch(input: EmbeddingEpochInput & {
  epochOverride?: string | undefined;
}): string {
  const derived = buildEmbeddingEpoch(input);
  const override = input.epochOverride?.trim();
  if (!override || override === derived) return derived;
  if (!declaredEmbeddingProviderFamily(input.provider)) return override;

  const [overrideBackend, , overrideModelId] = override.split(':');
  if ((overrideBackend === 'local' || overrideBackend === 'cloud')
    && overrideBackend !== input.backend) {
    throw refusedEmbeddingEpoch(
      override,
      input,
      `it names the ${overrideBackend} backend`,
    );
  }
  if (overrideModelId !== undefined
    && overrideModelId !== input.modelId
    && canonicalEmbeddingIdentityForModel(overrideModelId)) {
    throw refusedEmbeddingEpoch(
      override,
      input,
      `it names the model ${overrideModelId}`,
    );
  }
  // Configuring one of the strings the repair tool exists to erase would put
  // config and repair in a loop, each undoing the other.
  const contaminated = contaminatedEmbeddingEpoch(input.modelId, override);
  if (contaminated) {
    throw refusedEmbeddingEpoch(
      override,
      input,
      `it is a known contaminated epoch (${contaminated.origin})`,
    );
  }
  return override;
}

function refusedEmbeddingEpoch(
  override: string,
  input: EmbeddingEpochInput,
  because: string,
): OperationError {
  return new OperationError(
    'config_error',
    `Embedding epoch "${override}" cannot label ${input.backend} provider ${input.provider} `
    + `model ${input.modelId}: ${because}.`,
    'An epoch names the vectors a specific provider minted. Configure a per-provider epoch '
    + 'instead of sharing one variable across the local and cloud embedding lanes.',
  );
}

/**
 * Epoch strings that are known to be WRONG for a canonical identity, and that
 * a repair may correct in place. Every entry is a string this repository once
 * produced or once carried in config; none of them is a legitimate epoch bump.
 *
 * Kept beside the canon deliberately: the repair tool must never invent a
 * "close enough" match, so the set of correctable inputs is enumerated rather
 * than inferred.
 */
export interface ContaminatedEmbeddingEpoch {
  readonly modelId: string;
  readonly epochId: string;
  readonly origin: string;
}

export const KNOWN_CONTAMINATED_EMBEDDING_EPOCHS: readonly ContaminatedEmbeddingEpoch[] = [
  {
    modelId: 'secure-local-qwen3-embed',
    epochId: 'local:local-openai-compatible:secure-local-qwen3-embed:2560',
    origin: 'code default before the provider token was pinned (dimension configured)',
  },
  {
    modelId: 'secure-local-qwen3-embed',
    epochId: 'local:local-openai-compatible:secure-local-qwen3-embed:provider-reported',
    origin: 'code default before the provider token was pinned (dimension unconfigured)',
  },
  {
    modelId: 'gemini-embedding-2',
    epochId: 'local:openai-compatible:secure-local-qwen3-embed:2560',
    origin: 'provider-blind OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH stamped onto a Gemini provider',
  },
  {
    modelId: 'gemini-embedding-2',
    epochId: 'local:local-openai-compatible:secure-local-qwen3-embed:provider-reported',
    origin: 'provider-blind local code-default epoch stamped onto a Gemini provider',
  },
  {
    modelId: 'gemini-embedding-2',
    epochId: 'cloud:google-gemini:gemini-embedding-2:3072',
    origin: 'derived Gemini epoch drift after output dimensionality became required (2026-08-17)',
  },
];

export function contaminatedEmbeddingEpoch(
  modelId: string,
  epochId: string,
): ContaminatedEmbeddingEpoch | undefined {
  return KNOWN_CONTAMINATED_EMBEDDING_EPOCHS.find(
    (entry) => entry.modelId === modelId && entry.epochId === epochId,
  );
}
