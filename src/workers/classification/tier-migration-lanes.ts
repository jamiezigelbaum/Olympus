// The install's lanes, as the tier migration sees them (tier-migration.ts):
// each public source's per-tier stores, declared the same way its runtime
// declares them (legs, resting tiers, whether names and text may split, the
// lane floor), over the same files and the same set ledger. This is wiring
// data, like the data lifecycle's inventory: no classification decision is
// made here and nothing branches on a source downstream of it.
//
// A lane is opened only when at least one of its stores exists. `read` mode
// (the dry run) opens every existing store read-only and never creates one;
// `write` mode (run, rollback, purge) opens them for writing and lets a move
// create a destination store on first need.

import { existsSync } from 'node:fs';
import type { SourceFamily, SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import { READWISE_LIBRARY_CORPUS_ID } from '../../core/source-corpus-registry.ts';
import { LocalConnectorStore } from '../connector-store/local-index.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type TieredLaneFloor,
  type TieredLaneLeg,
  type TieredLaneSetOptions,
} from '../connector-store/tiered-store-set.ts';
import {
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  DROPBOX_TIER_CORPUS_IDS,
  createDropboxConnectorStore,
  createDropboxTierConnectorStore,
  defaultDropboxConnectorStoreDbPath,
  defaultDropboxInternalConnectorStoreDbPath,
  defaultDropboxPublicConnectorStoreDbPath,
} from '../dropbox-files/connector-store.ts';
import { DROPBOX_FILES_SOURCE_ID } from '../dropbox-files/corpus-adapter.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDrivePublicConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
} from '../google-connectors/drive.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  defaultGmailConnectorStoreDbPath,
  defaultGmailPublicConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
} from '../google-connectors/gmail.ts';
import { READWISE_STORE_PLACEMENT, defaultReadwiseConnectorStoreDbPath } from '../readwise/connector.ts';
import { READWISE_SECURE_LIBRARY_CORPUS_ID, READWISE_TIER_SET_ID, defaultReadwiseSecureConnectorStoreDbPath } from '../readwise/tier-set.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from '../telegram-messages/corpus-adapter.ts';
import { TELEGRAM_MESSAGES_SOURCE_ID } from '../telegram-messages/store-sync.ts';
import {
  WHATSAPP_INTERNAL_CORPUS_ID,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_SOURCE_ID,
  defaultWhatsAppConnectorStoreDbPath,
  defaultWhatsAppInternalConnectorStoreDbPath,
} from '../whatsapp/store-sync.ts';
import { X_BOOKMARKS_STORE_PLACEMENT, defaultXBookmarksConnectorStoreDbPath } from '../x-bookmarks/connector.ts';
import { X_BOOKMARKS_CORPUS_ID } from '../x-bookmarks/corpus-adapter.ts';
import { X_BOOKMARKS_SECURE_CORPUS_ID, X_BOOKMARKS_TIER_SET_ID, defaultXBookmarksSecureConnectorStoreDbPath } from '../x-bookmarks/tier-set.ts';
import { SecretLocationsIndex, secretLocationsPathForStore } from './secret-locations.ts';
import { TierLedger } from './tier-ledger.ts';
import type { TierMigrationLane } from './tier-migration.ts';

export type TierMigrationLaneMode = 'read' | 'write';

/** One store of a lane: where it lives and how to open it. */
export interface TierMigrationLegSpec {
  corpusId: string;
  dbPath: string;
  family: SourceFamily;
  /** One of the lane's pre-routing stores. */
  legacy?: boolean;
  restingTier?: SourceTrustTier;
  /** Opens the store (the lane's own factory when it has one: same exclusion gate and policy). */
  open?: (options: { readOnly: boolean; tierLedger: TierLedger }) => LocalConnectorStore;
}

export interface TierMigrationLaneSpec {
  sourceId: string;
  setId: string;
  legs: Partial<Record<SourceTrustDomain, TierMigrationLegSpec>> & { secure_local: TierMigrationLegSpec };
  splitLayers?: boolean;
  laneFloor?: TieredLaneFloor;
  contentArrivesLater?: boolean;
  storedPlacementIsPrior?: boolean;
}

/** Every public source's lane on this install, from the same path helpers its runtime uses. */
export function installedTierMigrationLaneSpecs(
  env: Record<string, string | undefined> = process.env,
): TierMigrationLaneSpec[] {
  return [
    {
      sourceId: 'gmail.email',
      setId: 'gmail.email',
      legs: {
        public_safe: { corpusId: GMAIL_PUBLIC_CONNECTOR_CORPUS_ID, dbPath: defaultGmailPublicConnectorStoreDbPath(env), family: 'email' },
        internal: { corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, dbPath: defaultGmailConnectorStoreDbPath(env), family: 'email', legacy: true },
        secure_local: { corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, dbPath: defaultGmailSecureConnectorStoreDbPath(env), family: 'email', legacy: true },
      },
    },
    {
      sourceId: 'google_drive.docs',
      setId: 'google_drive.docs',
      legs: {
        public_safe: { corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID, dbPath: defaultGoogleDrivePublicConnectorStoreDbPath(env), family: 'file' },
        internal: { corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, dbPath: defaultGoogleDriveConnectorStoreDbPath(env), family: 'file', legacy: true },
        secure_local: { corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID, dbPath: defaultGoogleDriveSecureConnectorStoreDbPath(env), family: 'file', legacy: true },
      },
    },
    {
      sourceId: DROPBOX_FILES_SOURCE_ID,
      setId: DROPBOX_FILES_SOURCE_ID,
      contentArrivesLater: true,
      legs: {
        public_safe: {
          corpusId: DROPBOX_TIER_CORPUS_IDS.public_safe,
          dbPath: defaultDropboxPublicConnectorStoreDbPath(env),
          family: 'file',
          open: ({ readOnly, tierLedger }) => createDropboxTierConnectorStore('public_safe', env, { readOnly, tierLedger }),
        },
        internal: {
          corpusId: DROPBOX_TIER_CORPUS_IDS.internal,
          dbPath: defaultDropboxInternalConnectorStoreDbPath(env),
          family: 'file',
          open: ({ readOnly, tierLedger }) => createDropboxTierConnectorStore('internal', env, { readOnly, tierLedger }),
        },
        secure_local: {
          corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
          dbPath: defaultDropboxConnectorStoreDbPath(env),
          family: 'file',
          legacy: true,
          open: ({ readOnly }) => createDropboxConnectorStore(env, { readOnly }),
        },
      },
    },
    {
      sourceId: TELEGRAM_MESSAGES_SOURCE_ID,
      setId: TELEGRAM_MESSAGES_SOURCE_ID,
      splitLayers: false,
      // A chat's store is its configured chat-level rule (the connector
      // publishes it as a prior): messages are never lowered below it.
      storedPlacementIsPrior: true,
      legs: {
        internal: { corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, dbPath: defaultInternalTelegramConnectorStoreDbPath(env), family: 'chat', legacy: true },
        secure_local: { corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, dbPath: defaultProtectedTelegramConnectorStoreDbPath(env), family: 'chat', legacy: true },
      },
    },
    {
      sourceId: 'readwise.library',
      setId: READWISE_TIER_SET_ID,
      legs: {
        internal: {
          corpusId: READWISE_LIBRARY_CORPUS_ID,
          dbPath: defaultReadwiseConnectorStoreDbPath(env),
          family: 'readwise',
          legacy: true,
          ...(READWISE_STORE_PLACEMENT.trustTier ? { restingTier: READWISE_STORE_PLACEMENT.trustTier } : {}),
        },
        secure_local: { corpusId: READWISE_SECURE_LIBRARY_CORPUS_ID, dbPath: defaultReadwiseSecureConnectorStoreDbPath(env), family: 'readwise' },
      },
    },
    {
      sourceId: 'x.bookmarks',
      setId: X_BOOKMARKS_TIER_SET_ID,
      legs: {
        internal: {
          corpusId: X_BOOKMARKS_CORPUS_ID,
          dbPath: defaultXBookmarksConnectorStoreDbPath(env),
          family: 'x',
          legacy: true,
          ...(X_BOOKMARKS_STORE_PLACEMENT.trustTier ? { restingTier: X_BOOKMARKS_STORE_PLACEMENT.trustTier } : {}),
        },
        secure_local: { corpusId: X_BOOKMARKS_SECURE_CORPUS_ID, dbPath: defaultXBookmarksSecureConnectorStoreDbPath(env), family: 'x' },
      },
    },
    {
      sourceId: WHATSAPP_PERSONAL_SOURCE_ID,
      setId: WHATSAPP_PERSONAL_SOURCE_ID,
      splitLayers: false,
      laneFloor: { trustDomain: 'secure_local', liftedByOwnerRule: ['chat'] },
      legs: {
        internal: { corpusId: WHATSAPP_INTERNAL_CORPUS_ID, dbPath: defaultWhatsAppInternalConnectorStoreDbPath(env), family: 'chat' },
        secure_local: { corpusId: WHATSAPP_LIVE_CORPUS_ID, dbPath: defaultWhatsAppConnectorStoreDbPath(env), family: 'chat', legacy: true },
      },
    },
  ];
}

export interface OpenedTierMigrationLanes {
  lanes: TierMigrationLane[];
  close(): void;
}

/**
 * Open the lanes whose stores exist. Every opened store, ledger and secret
 * index is closed by `close()` with the stores' deterministic close.
 */
export function openTierMigrationLanes(
  specs: readonly TierMigrationLaneSpec[],
  options: {
    mode: TierMigrationLaneMode;
    tierClassification?: TieredLaneSetOptions['tierClassification'];
  },
): OpenedTierMigrationLanes {
  const readOnly = options.mode === 'read';
  const opened: Array<{ close(): void }> = [];
  const lanes: TierMigrationLane[] = [];
  try {
    for (const spec of specs) {
      const legs = Object.entries(spec.legs) as Array<[SourceTrustDomain, TierMigrationLegSpec]>;
      if (!legs.some(([, leg]) => leg.dbPath !== ':memory:' && existsSync(leg.dbPath))) continue;
      const secure = spec.legs.secure_local;
      const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(secure.dbPath) });
      opened.push(ledger);
      const secretLocations = readOnly ? undefined : new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secure.dbPath) });
      if (secretLocations) opened.push(secretLocations);
      const laneLegs: Partial<Record<SourceTrustDomain, TieredLaneLeg>> = {};
      for (const [domain, leg] of legs) {
        const store = onDemandTierStore({
          corpusId: leg.corpusId,
          dbPath: leg.dbPath,
          create: () => {
            const created = leg.open
              ? leg.open({ readOnly, tierLedger: ledger })
              : new LocalConnectorStore({
                  dbPath: leg.dbPath,
                  corpusId: leg.corpusId,
                  family: leg.family,
                  trustDomain: domain,
                  tierLedger: ledger,
                  ...(readOnly ? { readOnly: true } : {}),
                });
            opened.push(created);
            return created;
          },
        });
        laneLegs[domain] = {
          onDemand: store,
          ...(leg.legacy ? { legacy: true } : {}),
          ...(leg.restingTier ? { restingTier: leg.restingTier } : {}),
        };
      }
      const set = createTieredLaneSet({
        setId: spec.setId,
        ledger,
        legs: laneLegs as TieredLaneSetOptions['legs'],
        ...(spec.splitLayers === false ? { splitLayers: false } : {}),
        ...(spec.laneFloor ? { laneFloor: spec.laneFloor } : {}),
        ...(spec.contentArrivesLater ? { contentArrivesLater: true } : {}),
        ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
        ...(secretLocations ? { secretLocations } : {}),
      });
      lanes.push({
        sourceId: spec.sourceId,
        set,
        ...(spec.storedPlacementIsPrior ? { storedPlacementIsPrior: true } : {}),
      });
    }
  } catch (error) {
    closeAll(opened);
    throw error;
  }
  return { lanes, close: () => closeAll(opened) };
}

function closeAll(opened: Array<{ close(): void }>): void {
  // Stores before ledgers: a store may hold a handle on its set ledger.
  for (const handle of [...opened].reverse()) {
    try {
      handle.close();
    } catch {
      // Keep closing the rest; a failed close of one handle must not leak the others.
    }
  }
}
