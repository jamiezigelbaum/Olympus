// The Readwise lane's per-tier stores (design
// docs/design/per-item-four-tier-classification.md, sections 2 and 3.2).
//
// `internal.readwise.library` stays the lane's store: every item stored before
// per-item routing keeps its S1/internal placement there, untouched, and a new
// item judged Personal rests there at the same S1. A new item whose text says
// it is private (a private highlight, say) is raised to Private and goes to
// `secure_local.readwise.library`, created on first need; one carrying a
// secret is stored nowhere and only its location is kept. No Readwise item can
// be lowered to Public here: the lane has no Public store (the former
// `public_safe.readwise.library` id is still an input alias of the internal
// corpus).

import { resolvedStorePath } from '../../core/source-placement.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { openConnectorStore } from '../../core/source-storage.ts';
import type { ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import { createExistingStoreTierLane, type ExistingStoreTierLane } from '../connector-store/tiered-store-set.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { READWISE_SOURCE_ID, READWISE_STORE_PLACEMENT } from './connector.ts';

export const READWISE_SECURE_LIBRARY_CORPUS_ID = 'secure_local.readwise.library';
export const READWISE_TIER_SET_ID = 'readwise.library';

export function defaultReadwiseSecureConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolvedStorePath(READWISE_SOURCE_ID, 'secure_local', env);
}

export function createReadwiseTierLane(options: {
  store: LocalConnectorStore;
  env?: Record<string, string | undefined>;
  /** The lane's own (cloud) identity, for its internal store. */
  embeddingProvider?: SourceEmbeddingProvider;
  /** A local or approved private identity for the Private store. */
  secureEmbeddingProvider?: SourceEmbeddingProvider;
  secretLocations?: SecretLocationsIndex;
  tierClassification?: ConnectorStoreTierClassification;
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): ExistingStoreTierLane {
  const env = options.env ?? process.env;
  const secureDbPath = defaultReadwiseSecureConnectorStoreDbPath(env);
  return createExistingStoreTierLane({
    setId: READWISE_TIER_SET_ID,
    store: options.store,
    restingTier: READWISE_STORE_PLACEMENT.trustTier!,
    ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
    newLegs: {
      secure_local: {
        corpusId: READWISE_SECURE_LIBRARY_CORPUS_ID,
        dbPath: secureDbPath,
        create: (ledger) => openConnectorStore({ sourceId: READWISE_SOURCE_ID }, {
          dbPath: secureDbPath,
          corpusId: READWISE_SECURE_LIBRARY_CORPUS_ID,
          family: 'readwise',
          trustDomain: 'secure_local',
          tierLedger: ledger,
        }, env),
        ...(options.secureEmbeddingProvider ? { embeddingProvider: options.secureEmbeddingProvider } : {}),
      },
    },
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
    ...(options.onStoreOpened ? { onStoreOpened: options.onStoreOpened } : {}),
  });
}
