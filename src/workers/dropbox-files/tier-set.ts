// The Dropbox lane's per-tier stores (design
// docs/design/per-item-four-tier-classification.md, sections 2 and 3.2).
//
// The lane's original store, `secure_local.dropbox.files`, keeps every file
// stored before per-item routing exactly where it is: those files take the
// lane's own placement on every later pass and never move. A NEW file is
// judged on its own:
// - its names (file name, path) go to the metadata tier's store, Personal by
//   default, when it is listed;
// - its text, read later by the shared extraction factory, goes to the content
//   tier's store: Personal for reference material, Private when the text says
//   so. Pending (an open name question) is Private. Secrets are stored nowhere.
//
// The set ledger is the secure store's own co-located ledger, so every
// lifecycle path that finds the secure store finds it.

import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import { TierLedger } from '../classification/tier-ledger.ts';
import type { SourceIngestionPolicy } from '../../core/source-ingestion-policy.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type OnDemandTierStore,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import {
  DROPBOX_TIER_CORPUS_IDS,
  createDropboxTierConnectorStore,
  defaultDropboxInternalConnectorStoreDbPath,
  defaultDropboxPublicConnectorStoreDbPath,
} from './connector-store.ts';
import { DROPBOX_FILES_SOURCE_ID } from './corpus-adapter.ts';

export interface DropboxTierLane {
  set: TieredStoreSet;
  ledger: TierLedger;
  internal: OnDemandTierStore;
  public: OnDemandTierStore;
}

export function createDropboxTierLane(options: {
  secureStore: LocalConnectorStore;
  env?: Record<string, string | undefined>;
  policy?: SourceIngestionPolicy;
  secretLocations?: SecretLocationsIndex;
  tierClassification?: ConnectorStoreTierClassification;
  /** Told once when the Personal or Public store opens, so a runtime can serve it. */
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): DropboxTierLane {
  const env = options.env ?? process.env;
  const ledger = options.secureStore.tierLedger()
    ?? new TierLedger({ dbPath: tieredStoreSetLedgerPath(options.secureStore.dbPath) });
  const leg = (domain: 'internal' | 'public_safe'): OnDemandTierStore => onDemandTierStore({
    corpusId: DROPBOX_TIER_CORPUS_IDS[domain],
    dbPath: domain === 'internal'
      ? defaultDropboxInternalConnectorStoreDbPath(env)
      : defaultDropboxPublicConnectorStoreDbPath(env),
    create: () => createDropboxTierConnectorStore(domain, env, {
      ...(options.policy ? { policy: options.policy } : {}),
      tierLedger: ledger,
    }),
    ...(options.onStoreOpened ? { onOpened: options.onStoreOpened } : {}),
  });
  const internal = leg('internal');
  const publicStore = leg('public_safe');
  const set = createTieredLaneSet({
    setId: DROPBOX_FILES_SOURCE_ID,
    ledger,
    contentArrivesLater: true,
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
    legs: {
      public_safe: { onDemand: publicStore },
      internal: { onDemand: internal },
      secure_local: { store: options.secureStore, legacy: true },
    },
  });
  return { set, ledger, internal, public: publicStore };
}
