// One automatic-move policy for the background executor and cached sync verdicts.
import type { AutomaticTierMoveContext } from '../classification/installed-tier-classification-registry.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import { BUILT_IN_EMBEDDING_PROVIDER } from '../source-index/built-in-embedding/provider.ts';
import type { ConnectorStoreItemCopy } from './local-index.ts';
import type { TierMoveEmbeddingIdentity, TierMoveOptions } from './tier-move.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export const AUTO_MOVE_WHY = 'Automatic tier move after the privacy check: every embedding involved is the built-in local model (owner approval 2026-10-01).';

/** Call only after automaticTierMovesAllowed (or the executor's equivalent per-pass checks). */
export function automaticTierMoveOptions(
  set: TieredStoreSet,
  context: AutomaticTierMoveContext,
): Pick<TierMoveOptions, 'replaceOwnSupersededCopy' | 'vectorIdentitiesFor' | 'embeddingLedger'> {
  return {
    replaceOwnSupersededCopy: true,
    vectorIdentitiesFor: exported => matchingVectorIdentities(set, exported),
    embeddingLedger: { path: context.embeddingLedgerPath, approvedBy: 'system-automatic', why: AUTO_MOVE_WHY },
  };
}

export function automaticTierMovesAllowed(set: TieredStoreSet, context: AutomaticTierMoveContext | undefined): boolean {
  try {
    return context !== undefined && context.localEmbeddingsOnly() && setEmbedsWithBuiltInOnly(set);
  } catch {
    return false;
  }
}

/**
 * For each store of the set, its configured embedding identity (or recorded
 * identity when the lane declares none), if it matches the identity the
 * item's vectors were minted under: a move may copy them instead of embedding
 * again. A store with no such identity gets none (it embeds with its own model).
 */
function matchingVectorIdentities(
  set: TieredStoreSet,
  exported: ConnectorStoreItemCopy,
): Partial<Record<SourceTrustDomain, TierMoveEmbeddingIdentity>> {
  const identities: Partial<Record<SourceTrustDomain, TierMoveEmbeddingIdentity>> = {};
  for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
    try {
      const store = set.store(domain);
      if (!store) continue;
      const configured = domain === 'secure_local'
        ? set.privateEmbeddingProvider()
        : set.legSpec(domain)?.embeddingProvider;
      const candidates = configured ? [configured] : store.embeddingAuthorities();
      const own = candidates.find((authority) => exported.vectorAuthorities.some((minted) =>
        minted.modelId === authority.modelId
        && minted.provider === authority.provider
        && minted.backend === authority.backend
        && minted.dimension === authority.dimension
        && minted.epochId === authority.epochId));
      if (!own || (own.backend !== 'local' && own.backend !== 'cloud')) continue;
      identities[domain] = {
        modelId: own.modelId,
        provider: own.provider,
        backend: own.backend,
        dimension: own.dimension,
        epochId: own.epochId,
        configHash: own.configHash ?? '',
      };
    } catch {
      // That store embeds with its own model.
    }
  }
  return identities;
}

/** Every open store of the set embeds (if at all) with the built-in local model only. */
export function setEmbedsWithBuiltInOnly(set: TieredStoreSet): boolean {
  try {
    return set.openStores().every((store) => store.embeddingAuthorities()
      .every((authority) => authority.provider === BUILT_IN_EMBEDDING_PROVIDER));
  } catch {
    return false;
  }
}

