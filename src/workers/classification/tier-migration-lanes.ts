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

import { resolvedStorePath } from '../../core/source-placement.ts';
import { existsSync } from 'node:fs';
import type { SourceFamily, SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import { READWISE_LIBRARY_CORPUS_ID } from '../../core/source-corpus-registry.ts';
import type { LocalConnectorStore } from '../connector-store/local-index.ts';
import { openConnectorStore, openSecretLocations, openTierLedger } from '../../core/source-storage.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type TieredLaneLeg,
  type TieredLaneSetOptions,
} from '../connector-store/tiered-store-set.ts';
import {
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  DROPBOX_TIER_CORPUS_IDS,
  createDropboxConnectorStore,
  createDropboxTierConnectorStore,
} from '../dropbox-files/connector-store.ts';
import { DROPBOX_FILES_SOURCE_ID } from '../dropbox-files/corpus-adapter.ts';
import {
  LOCAL_FILES_TIER_CORPUS_IDS,
  createLocalFilesConnectorStore,
  createLocalFilesTierConnectorStore,
} from '../local-files/store.ts';
import { LOCAL_FILES_SOURCE_ID } from '../local-files/scope.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
} from '../google-connectors/drive.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
} from '../google-connectors/gmail.ts';
import { READWISE_STORE_PLACEMENT } from '../readwise/connector.ts';
import { READWISE_SECURE_LIBRARY_CORPUS_ID, READWISE_TIER_SET_ID } from '../readwise/tier-set.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
} from '../telegram-messages/corpus-adapter.ts';
import { TELEGRAM_MESSAGES_SOURCE_ID } from '../telegram-messages/store-sync.ts';
import {
  WHATSAPP_INTERNAL_CORPUS_ID,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_SOURCE_ID,
} from '../whatsapp/store-sync.ts';
import { X_BOOKMARKS_STORE_PLACEMENT } from '../x-bookmarks/connector.ts';
import { X_BOOKMARKS_CORPUS_ID } from '../x-bookmarks/corpus-adapter.ts';
import { X_BOOKMARKS_SECURE_CORPUS_ID, X_BOOKMARKS_TIER_SET_ID } from '../x-bookmarks/tier-set.ts';
import { archiveTierMigrationLaneSpecs } from '../archive-import/lane.ts';
import { secretLocationsPathForStore } from './secret-locations.ts';
import type { TierLedger } from './tier-ledger.ts';
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
  /** The lane's own classification input, as its runtime sets it; the run's shared inputs are added to it. */
  tierClassification?: TieredLaneSetOptions['tierClassification'];
  splitLayers?: boolean;
  contentArrivesLater?: boolean;
  /** The lane's per-item form of `contentArrivesLater`, as its runtime sets it. */
  contentArrivesLaterFor?: TieredLaneSetOptions['contentArrivesLaterFor'];
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
        public_safe: { corpusId: GMAIL_PUBLIC_CONNECTOR_CORPUS_ID, dbPath: resolvedStorePath('gmail.email', 'public_safe', env), family: 'email' },
        internal: { corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, dbPath: resolvedStorePath('gmail.email', 'internal', env), family: 'email', legacy: true },
        secure_local: { corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, dbPath: resolvedStorePath('gmail.email', 'secure_local', env), family: 'email', legacy: true },
      },
    },
    {
      sourceId: 'google_drive.docs',
      setId: 'google_drive.docs',
      legs: {
        public_safe: { corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID, dbPath: resolvedStorePath('google_drive.docs', 'public_safe', env), family: 'file' },
        internal: { corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, dbPath: resolvedStorePath('google_drive.docs', 'internal', env), family: 'file', legacy: true },
        secure_local: { corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID, dbPath: resolvedStorePath('google_drive.docs', 'secure_local', env), family: 'file', legacy: true },
      },
    },
    {
      sourceId: DROPBOX_FILES_SOURCE_ID,
      setId: DROPBOX_FILES_SOURCE_ID,
      contentArrivesLater: true,
      legs: {
        public_safe: {
          corpusId: DROPBOX_TIER_CORPUS_IDS.public_safe,
          dbPath: resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'public_safe', env),
          family: 'file',
          open: ({ readOnly, tierLedger }) => createDropboxTierConnectorStore('public_safe', env, { readOnly, tierLedger }),
        },
        internal: {
          corpusId: DROPBOX_TIER_CORPUS_IDS.internal,
          dbPath: resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'internal', env),
          family: 'file',
          open: ({ readOnly, tierLedger }) => createDropboxTierConnectorStore('internal', env, { readOnly, tierLedger }),
        },
        secure_local: {
          corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
          dbPath: resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'secure_local', env),
          family: 'file',
          legacy: true,
          open: ({ readOnly }) => createDropboxConnectorStore(env, { readOnly }),
        },
      },
    },
    {
      sourceId: LOCAL_FILES_SOURCE_ID,
      setId: LOCAL_FILES_SOURCE_ID,
      contentArrivesLater: true,
      legs: {
        public_safe: {
          corpusId: LOCAL_FILES_TIER_CORPUS_IDS.public_safe,
          dbPath: resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'public_safe', env),
          family: 'file',
          open: ({ readOnly, tierLedger }) => createLocalFilesTierConnectorStore('public_safe', env, { readOnly, tierLedger }),
        },
        internal: {
          corpusId: LOCAL_FILES_TIER_CORPUS_IDS.internal,
          dbPath: resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'internal', env),
          family: 'file',
          open: ({ readOnly, tierLedger }) => createLocalFilesTierConnectorStore('internal', env, { readOnly, tierLedger }),
        },
        secure_local: {
          corpusId: LOCAL_FILES_TIER_CORPUS_IDS.secure_local,
          dbPath: resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'secure_local', env),
          family: 'file',
          legacy: true,
          open: ({ readOnly }) => createLocalFilesConnectorStore(env, { readOnly }),
        },
      },
    },
    {
      sourceId: TELEGRAM_MESSAGES_SOURCE_ID,
      setId: TELEGRAM_MESSAGES_SOURCE_ID,
      splitLayers: false,
      legs: {
        internal: { corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, dbPath: resolvedStorePath('telegram.messages', 'internal', env), family: 'chat', legacy: true },
        secure_local: { corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, dbPath: resolvedStorePath('telegram.messages', 'secure_local', env), family: 'chat', legacy: true },
      },
    },
    {
      sourceId: 'readwise.library',
      setId: READWISE_TIER_SET_ID,
      legs: {
        internal: {
          corpusId: READWISE_LIBRARY_CORPUS_ID,
          dbPath: resolvedStorePath('readwise.library', 'internal', env),
          family: 'readwise',
          legacy: true,
          ...(READWISE_STORE_PLACEMENT.trustTier ? { restingTier: READWISE_STORE_PLACEMENT.trustTier } : {}),
        },
        secure_local: { corpusId: READWISE_SECURE_LIBRARY_CORPUS_ID, dbPath: resolvedStorePath('readwise.library', 'secure_local', env), family: 'readwise' },
      },
    },
    {
      sourceId: 'x.bookmarks',
      setId: X_BOOKMARKS_TIER_SET_ID,
      legs: {
        internal: {
          corpusId: X_BOOKMARKS_CORPUS_ID,
          dbPath: resolvedStorePath('x.bookmarks', 'internal', env),
          family: 'x',
          legacy: true,
          ...(X_BOOKMARKS_STORE_PLACEMENT.trustTier ? { restingTier: X_BOOKMARKS_STORE_PLACEMENT.trustTier } : {}),
        },
        secure_local: { corpusId: X_BOOKMARKS_SECURE_CORPUS_ID, dbPath: resolvedStorePath('x.bookmarks', 'secure_local', env), family: 'x' },
      },
    },
    {
      sourceId: WHATSAPP_PERSONAL_SOURCE_ID,
      setId: WHATSAPP_PERSONAL_SOURCE_ID,
      splitLayers: false,
      legs: {
        internal: { corpusId: WHATSAPP_INTERNAL_CORPUS_ID, dbPath: resolvedStorePath('whatsapp.personal.messages', 'internal', env), family: 'chat' },
        secure_local: { corpusId: WHATSAPP_LIVE_CORPUS_ID, dbPath: resolvedStorePath('whatsapp.personal.messages', 'secure_local', env), family: 'chat', legacy: true },
      },
    },
    ...archiveTierMigrationLaneSpecs(env),
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
      const account = { sourceId: spec.sourceId };
      const ledger = openTierLedger(account, { dbPath: tieredStoreSetLedgerPath(secure.dbPath) });
      opened.push(ledger);
      const secretLocations = readOnly ? undefined : openSecretLocations(account, { dbPath: secretLocationsPathForStore(secure.dbPath) });
      if (secretLocations) opened.push(secretLocations);
      const laneLegs: Partial<Record<SourceTrustDomain, TieredLaneLeg>> = {};
      for (const [domain, leg] of legs) {
        const store = onDemandTierStore({
          corpusId: leg.corpusId,
          dbPath: leg.dbPath,
          create: () => {
            const created = leg.open
              ? leg.open({ readOnly, tierLedger: ledger })
              : openConnectorStore(account, {
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
      const tierClassification = spec.tierClassification || options.tierClassification
        ? { ...options.tierClassification, ...spec.tierClassification }
        : undefined;
      const set = createTieredLaneSet({
        setId: spec.setId,
        ledger,
        legs: laneLegs as TieredLaneSetOptions['legs'],
        ...(spec.splitLayers === false ? { splitLayers: false } : {}),
        ...(spec.contentArrivesLater ? { contentArrivesLater: true } : {}),
        ...(spec.contentArrivesLaterFor ? { contentArrivesLaterFor: spec.contentArrivesLaterFor } : {}),
        ...(tierClassification ? { tierClassification } : {}),
        ...(secretLocations ? { secretLocations } : {}),
      });
      lanes.push({ sourceId: spec.sourceId, set });
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
