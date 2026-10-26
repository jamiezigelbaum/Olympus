// The X bookmarks lane's per-tier stores (design
// docs/design/per-item-four-tier-classification.md, sections 2 and 3.2).
//
// `internal.x.bookmarks` stays the lane's store: every bookmark stored before
// per-item routing keeps its S1/internal placement there, untouched, and a new
// bookmark judged Personal rests there at the same S1. A new bookmark whose
// text says it is private is raised to Private and goes to
// `secure_local.x.bookmarks`, created on first need; one carrying a secret is
// stored nowhere and only its location is kept. The lane has no Public store.

import { resolvedStorePath } from '../../core/source-placement.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { openConnectorStore } from '../../core/source-storage.ts';
import type { ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import { createExistingStoreTierLane, type ExistingStoreTierLane } from '../connector-store/tiered-store-set.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { X_BOOKMARKS_SOURCE_ID, X_BOOKMARKS_STORE_PLACEMENT } from './connector.ts';

export const X_BOOKMARKS_SECURE_CORPUS_ID = 'secure_local.x.bookmarks';
export const X_BOOKMARKS_TIER_SET_ID = 'x.bookmarks';

export function createXBookmarksTierLane(options: {
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
  const secureDbPath = resolvedStorePath(X_BOOKMARKS_SOURCE_ID, 'secure_local', env);
  return createExistingStoreTierLane({
    setId: X_BOOKMARKS_TIER_SET_ID,
    store: options.store,
    restingTier: X_BOOKMARKS_STORE_PLACEMENT.trustTier!,
    ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
    newLegs: {
      secure_local: {
        corpusId: X_BOOKMARKS_SECURE_CORPUS_ID,
        dbPath: secureDbPath,
        create: (ledger) => openConnectorStore({ sourceId: X_BOOKMARKS_SOURCE_ID }, {
          dbPath: secureDbPath,
          corpusId: X_BOOKMARKS_SECURE_CORPUS_ID,
          family: 'x',
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
