/**
 * Placement of the local files stores on the shared spine: the same three
 * per-tier stores, exclusion gate and tier set as every other file source
 * (see `dropbox-files/connector-store.ts` and `tier-set.ts` for the design).
 *
 * - `secure_local.local.files`: the lane's original store; Private items land
 *   here, and everything stored before per-item routing would.
 * - `internal.local.files` and `public_safe.local.files`: created only when a
 *   file is first routed to them.
 */
import { resolvedRawPath, resolvedStorePath } from '../../core/source-placement.ts';
import { defineSourceIndexCorpus, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import {
  createSourceExclusionMatcher,
  loadSourceIngestionExclusions,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import {
  defaultLocalFilesIngestionPolicy,
  type SourceIngestionPolicy,
} from '../../core/source-ingestion-policy.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { openConnectorStore, openTierLedger } from '../../core/source-storage.ts';
import { fileLaneIngestionMatcher } from '../connector-store/file-ingestion-matcher.ts';
import type {
  ConnectorStorePlacementRule,
  ConnectorStoreTierClassification,
} from '../connector-store/tier-placement.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type OnDemandTierStore,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import { LOCAL_FILES_SOURCE_ID } from './scope.ts';

export const LOCAL_FILES_CORPUS_ID = 'secure_local.local.files';
export const LOCAL_FILES_INTERNAL_CORPUS_ID = 'internal.local.files';
export const LOCAL_FILES_PUBLIC_CORPUS_ID = 'public_safe.local.files';

export const LOCAL_FILES_TIER_CORPUS_IDS: Readonly<Record<SourceTrustDomain, string>> = Object.freeze({
  public_safe: LOCAL_FILES_PUBLIC_CORPUS_ID,
  internal: LOCAL_FILES_INTERNAL_CORPUS_ID,
  secure_local: LOCAL_FILES_CORPUS_ID,
});

export const LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV = 'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_CONNECTOR_STORE_DB_PATH';
export const LOCAL_FILES_INTERNAL_CONNECTOR_STORE_DB_PATH_ENV =
  'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_INTERNAL_CONNECTOR_STORE_DB_PATH';
export const LOCAL_FILES_PUBLIC_CONNECTOR_STORE_DB_PATH_ENV =
  'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_PUBLIC_CONNECTOR_STORE_DB_PATH';

/** The source key this connector's exclusion rules are written against. */
export const LOCAL_FILES_INGESTION_EXCLUSION_SOURCE = LOCAL_FILES_SOURCE_ID;

/** Path prefixes, and file-type rules where the listing carries a size: the same two the file lanes declare. */
export const LOCAL_FILES_ENFORCEABLE_EXCLUSION_CRITERIA = ['path_prefix', 'media'] as const;

/** Where a stored file rests when no per-item route applies: S4 / secure_local, raised to S5 for a secret. */
export const LOCAL_FILES_STORE_PLACEMENT: ConnectorStorePlacementRule = Object.freeze({
  trustTier: 'S4',
  trustDomain: 'secure_local',
  secretsInContent: true,
});

export function defineLocalFilesCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: LOCAL_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    description: 'Secure-local file metadata, revisions, and bounded extraction state for approved folders on this computer.',
  });
}

/** Where change snapshots for the watched folders are kept. */
export function localFilesWatchDir(env: Record<string, string | undefined> = process.env): string {
  return resolvedRawPath(LOCAL_FILES_SOURCE_ID, 'watch', env);
}

/** Every local files tier store's path: the lifecycle deletes all of them with the source. */
export function localFilesTierConnectorStoreDbPaths(env: Record<string, string | undefined> = process.env): string[] {
  return [
    resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'secure_local', env),
    resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'internal', env),
    resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'public_safe', env),
  ];
}

export function localFilesIngestionExclusionMatcher(
  env: Record<string, string | undefined> = process.env,
): SourceExclusionMatcher {
  return createSourceExclusionMatcher(
    loadSourceIngestionExclusions({ env }),
    LOCAL_FILES_INGESTION_EXCLUSION_SOURCE,
    { enforceable: LOCAL_FILES_ENFORCEABLE_EXCLUSION_CRITERIA },
  );
}

export function localFilesCanonicalIngestionMatcher(
  policy: SourceIngestionPolicy,
  env: Record<string, string | undefined> = process.env,
): SourceExclusionMatcher {
  return fileLaneIngestionMatcher(policy, env, {
    standing: localFilesIngestionExclusionMatcher,
    ruleIdPrefix: 'local-files-policy',
    defaultRules: (ready) => defaultLocalFilesIngestionPolicy({ stillImagesRead: ready }).rules,
  });
}

export function createLocalFilesConnectorStore(
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; policy?: SourceIngestionPolicy } = {},
): LocalConnectorStore {
  const policy = options.policy ?? defaultLocalFilesIngestionPolicy();
  return openConnectorStore({ sourceId: LOCAL_FILES_SOURCE_ID }, {
    dbPath: resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'secure_local', env),
    corpusId: LOCAL_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    exclusions: localFilesCanonicalIngestionMatcher(policy, env),
    ...(options.readOnly === true ? { readOnly: true } : {}),
  }, env);
}

export function createLocalFilesTierConnectorStore(
  trustDomain: 'internal' | 'public_safe',
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; policy?: SourceIngestionPolicy; tierLedger?: TierLedger } = {},
): LocalConnectorStore {
  const policy = options.policy ?? defaultLocalFilesIngestionPolicy();
  return openConnectorStore({ sourceId: LOCAL_FILES_SOURCE_ID }, {
    dbPath: trustDomain === 'internal'
      ? resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'internal', env)
      : resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'public_safe', env),
    corpusId: LOCAL_FILES_TIER_CORPUS_IDS[trustDomain],
    family: 'file',
    trustDomain,
    exclusions: localFilesCanonicalIngestionMatcher(policy, env),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.tierLedger ? { tierLedger: options.tierLedger } : {}),
  }, env);
}

export interface LocalFilesTierLane {
  set: TieredStoreSet;
  ledger: TierLedger;
  internal: OnDemandTierStore;
  public: OnDemandTierStore;
}

export function createLocalFilesTierLane(options: {
  secureStore: LocalConnectorStore;
  env?: Record<string, string | undefined>;
  policy?: SourceIngestionPolicy;
  secretLocations?: SecretLocationsIndex;
  tierClassification?: ConnectorStoreTierClassification;
  /** Told once when the Personal or Public store opens, so a runtime can serve it. */
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): LocalFilesTierLane {
  const env = options.env ?? process.env;
  const ledger = options.secureStore.tierLedger()
    ?? openTierLedger({ sourceId: LOCAL_FILES_SOURCE_ID }, { dbPath: tieredStoreSetLedgerPath(options.secureStore.dbPath) }, env);
  const leg = (domain: 'internal' | 'public_safe'): OnDemandTierStore => onDemandTierStore({
    corpusId: LOCAL_FILES_TIER_CORPUS_IDS[domain],
    dbPath: domain === 'internal'
      ? resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'internal', env)
      : resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'public_safe', env),
    create: () => createLocalFilesTierConnectorStore(domain, env, {
      ...(options.policy ? { policy: options.policy } : {}),
      tierLedger: ledger,
    }),
    ...(options.onStoreOpened ? { onOpened: options.onStoreOpened } : {}),
  });
  const internal = leg('internal');
  const publicStore = leg('public_safe');
  const set = createTieredLaneSet({
    setId: LOCAL_FILES_SOURCE_ID,
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
