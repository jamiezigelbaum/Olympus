/**
 * One family's archive stores as a tiered store set, on the shared spine: the
 * same per-item tiers, set ledger and secret-locations index as every other
 * lane (see `local-files/store.ts`).
 *
 * What is particular to imports is one shared classification input:
 * `holdContentUntilJudged`. An import puts years of items in the judging
 * queue at once, so the wait the Personal-first default assumes does not
 * hold. Every imported item's content stays Private until the private model
 * judged it; cleared names follow the usual names rule. No format or
 * connector branches on it: this module is the only one that sets it.
 *
 * Every leg, the Private one included, is created on first need.
 */
import type { RawItem } from '../../core/contracts.ts';
import type { SourceFamily, SourceTrustDomain } from '../../core/source-index/types.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { openTierLedger } from '../../core/source-storage.ts';
import type { ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type OnDemandTierStore,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import type { TierMigrationLaneSpec } from '../classification/tier-migration-lanes.ts';
import { archiveImportFamilies } from '../../core/archive-formats.ts';
import { ARCHIVE_IMPORTS_SOURCE_ID } from './state.ts';
import {
  archiveConnectorStoreDbPath,
  archiveCorpusId,
  archiveTierSetId,
  createArchiveConnectorStore,
} from './store.ts';

export const ARCHIVE_TIER_CLASSIFICATION: ConnectorStoreTierClassification = Object.freeze({
  holdContentUntilJudged: true,
});

/**
 * A child's bytes are read after listing, by the extraction factory (docs/design/child-items.md):
 * its names go to their tier's store at listing and its content lands later, exactly as for any
 * item whose text arrives after listing. It names no source and no format: the connector says
 * so on the item (`deferredBytes`).
 */
export const archiveContentArrivesLaterFor = (item: RawItem): boolean => item.deferredBytes !== undefined;

export interface ArchiveTierLane {
  family: SourceFamily;
  /**
   * The environment the lane's files were resolved under.
   */
  env: Record<string, string | undefined>;
  set: TieredStoreSet;
  ledger: TierLedger;
  secure: OnDemandTierStore;
  internal: OnDemandTierStore;
  public: OnDemandTierStore;
  secretLocations?: SecretLocationsIndex;
}

export function archiveLaneLegs(lane: ArchiveTierLane): OnDemandTierStore[] {
  return [lane.secure, lane.internal, lane.public];
}

/**
 * The lane's stores that exist, opening any whose file is there. Never creates one.
 */
export function archiveLaneStores(lane: ArchiveTierLane): LocalConnectorStore[] {
  return lane.set.openStores();
}

export function createArchiveTierLane(options: {
  family: SourceFamily;
  env?: Record<string, string | undefined>;
  /**
   * Opens the secret-locations index beside the Private store.
   */
  openSecretLocations?: (secureDbPath: string) => SecretLocationsIndex | undefined;
  /**
   * Told once when a store opens, so a runtime can serve it.
   */
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): ArchiveTierLane {
  const env = options.env ?? process.env;
  const family = options.family;
  const secureDbPath = archiveConnectorStoreDbPath('secure_local', family, env);
  const ledger = openTierLedger({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID }, { dbPath: tieredStoreSetLedgerPath(secureDbPath) }, env);
  const leg = (domain: SourceTrustDomain): OnDemandTierStore => onDemandTierStore({
    corpusId: archiveCorpusId(domain, family),
    dbPath: archiveConnectorStoreDbPath(domain, family, env),
    create: () => createArchiveConnectorStore(domain, family, env, { tierLedger: ledger }),
    ...(options.onStoreOpened ? { onOpened: options.onStoreOpened } : {}),
  });
  const secure = leg('secure_local');
  const internal = leg('internal');
  const publicStore = leg('public_safe');
  const secretLocations = options.openSecretLocations?.(secureDbPath);
  const set = createTieredLaneSet({
    setId: archiveTierSetId(family),
    ledger,
    tierClassification: ARCHIVE_TIER_CLASSIFICATION,
    contentArrivesLaterFor: archiveContentArrivesLaterFor,
    ...(secretLocations ? { secretLocations } : {}),
    legs: {
      public_safe: { onDemand: publicStore },
      internal: { onDemand: internal },
      secure_local: { onDemand: secure, legacy: true },
    },
  });
  return {
    family,
    env,
    set,
    ledger,
    secure,
    internal,
    public: publicStore,
    ...(secretLocations ? { secretLocations } : {}),
  };
}

/**
 * The archive lanes as the tier migration opens them (tier-migration-lanes.ts):
 * the same stores, set ledger and classification input as the runtime's.
 */
export function archiveTierMigrationLaneSpecs(
  env: Record<string, string | undefined> = process.env,
): TierMigrationLaneSpec[] {
  return archiveImportFamilies().map((family) => {
    const leg = (domain: SourceTrustDomain, legacy: boolean) => ({
      corpusId: archiveCorpusId(domain, family),
      dbPath: archiveConnectorStoreDbPath(domain, family, env),
      family,
      ...(legacy ? { legacy: true } : {}),
      open: ({ readOnly, tierLedger }: { readOnly: boolean; tierLedger: TierLedger }) =>
        createArchiveConnectorStore(domain, family, env, { readOnly, tierLedger }),
    });
    return {
      sourceId: ARCHIVE_IMPORTS_SOURCE_ID,
      setId: archiveTierSetId(family),
      tierClassification: ARCHIVE_TIER_CLASSIFICATION,
      contentArrivesLaterFor: archiveContentArrivesLaterFor,
      legs: {
        public_safe: leg('public_safe', false),
        internal: leg('internal', false),
        secure_local: leg('secure_local', true),
      },
    };
  });
}
