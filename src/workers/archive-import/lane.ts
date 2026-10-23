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
import type { SourceFamily, SourceTrustDomain } from '../../core/source-index/types.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import { TierLedger } from '../classification/tier-ledger.ts';
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
  archiveConnectorStoreDbPath,
  archiveCorpusId,
  archiveTierSetId,
  createArchiveConnectorStore,
} from './store.ts';

export const ARCHIVE_TIER_CLASSIFICATION: ConnectorStoreTierClassification = Object.freeze({
  holdContentUntilJudged: true,
});

export interface ArchiveTierLane {
  family: SourceFamily;
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

/** The lane's stores that exist, opening any whose file is there. */
export function archiveLaneStores(lane: ArchiveTierLane): LocalConnectorStore[] {
  return archiveLaneLegs(lane).flatMap((leg) => {
    if (leg.current()) return [leg.current()!];
    return leg.exists() ? [leg.open()] : [];
  });
}

export function createArchiveTierLane(options: {
  family: SourceFamily;
  env?: Record<string, string | undefined>;
  /** Opens the secret-locations index beside the Private store. */
  openSecretLocations?: (secureDbPath: string) => SecretLocationsIndex | undefined;
  /** Told once when a store opens, so a runtime can serve it. */
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): ArchiveTierLane {
  const env = options.env ?? process.env;
  const family = options.family;
  const secureDbPath = archiveConnectorStoreDbPath('secure_local', family, env);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(secureDbPath) });
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
    ...(secretLocations ? { secretLocations } : {}),
    legs: {
      public_safe: { onDemand: publicStore },
      internal: { onDemand: internal },
      secure_local: { onDemand: secure, legacy: true },
    },
  });
  return {
    family,
    set,
    ledger,
    secure,
    internal,
    public: publicStore,
    ...(secretLocations ? { secretLocations } : {}),
  };
}
