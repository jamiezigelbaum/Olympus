// Product-owned control plane for the WhatsApp capture spool. Provider/session
// work stays in the thin whatsmeow bridge; this module only hands captured
// records to the shared SourceConnector -> LocalConnectorStore spine.

import type { ConnectorStorePlacementRule } from '../connector-store/tier-placement.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LocalConnectorStore,
  type ConnectorStoreSyncSummary,
} from '../connector-store/index.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import {
  createExistingStoreTierLane,
  mergedTieredLaneRun,
  tieredLaneReceiptCounts,
  type ExistingStoreTierLane,
  type TieredLaneReceiptCounts,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  WHATSAPP_LIVE_CONNECTOR_ID,
  createWhatsAppLiveSourceConnector,
  readWhatsAppLiveSpoolStatus,
} from './live-connector.ts';

export const WHATSAPP_PERSONAL_SOURCE_ID = 'whatsapp.personal.messages';
export const WHATSAPP_LIVE_CORPUS_ID = 'secure_local.whatsapp.messages';
export const WHATSAPP_PERSONAL_ACCOUNT_SCOPE = 'personal';
/**
 * Messages of a chat the OWNER set to Personal (an owner chat rule), routed
 * here one by one. Created on first need; with no such rule it never exists.
 */
export const WHATSAPP_INTERNAL_CORPUS_ID = 'internal.whatsapp.messages';
export const WHATSAPP_PRODUCT_CONNECTOR_ID = 'whatsapp_product_spool';

/**
 * Chat history is stored S4/secure_local, declared rather than inherited from
 * the store, so wiring this lane to any other store is refused item by item
 * (fail closed) exactly as the retired connector classify() made it.
 */
export const WHATSAPP_STORE_PLACEMENT: ConnectorStorePlacementRule = Object.freeze({
  trustTier: 'S4',
  trustDomain: 'secure_local',
});
export const WHATSAPP_EXTRACTION_SCOPE_KEY = 'whatsapp.personal.messages';
export const WHATSAPP_MALFORMED_SPOOL_WARNING = 'whatsapp_malformed_spool_lines';
export const WHATSAPP_UNRESOLVED_REACTIONS_WARNING = 'whatsapp_unresolved_reaction_targets';
export const WHATSAPP_CAPTURE_STALE_WARNING = 'whatsapp_capture_spool_stale';
export const WHATSAPP_CAPTURE_UNAVAILABLE_WARNING = 'whatsapp_capture_freshness_unavailable';
const DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS = 64_800;

export interface WhatsAppConnectorStoreSyncReceipt {
  status: 'progress' | 'idle';
  counts: {
    items_seen: number;
    items_indexed: number;
    items_changed: number;
    items_tombstoned: number;
    items_rejected: number;
    items_metadata_only: number;
    chunks_indexed: number;
    malformed_spool_lines: number;
    unresolved_reaction_targets: number;
    capture_fresh: number;
    capture_stale: number;
    capture_unavailable: number;
    capture_stale_threshold_seconds: number;
    capture_age_seconds?: number;
  } & TieredLaneReceiptCounts;
  capture: {
    status: 'fresh' | 'stale' | 'unavailable';
    threshold_seconds: number;
    age_seconds?: number;
  };
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
    local_only: true;
  };
}

export interface WhatsAppConnectorStoreSyncHandler {
  pull(request?: { max_items?: number }): Promise<WhatsAppConnectorStoreSyncReceipt>;
  lastStoreRunCompletedAt(): string | undefined;
}

export function defaultWhatsAppStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const dataHome = env.XDG_DATA_HOME?.trim()
    || join(env.HOME?.trim() || homedir(), '.local', 'share');
  return env.OLYMPUS_WHATSAPP_STATE_DIR?.trim()
    || join(dataHome, 'olympus', 'whatsapp-live');
}

export function defaultWhatsAppSpoolDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR?.trim()
    || join(defaultWhatsAppStateDir(env), 'spool');
}

export function defaultWhatsAppMediaDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const transcribeStateDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR?.trim();
  return env.OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR?.trim()
    || join(transcribeStateDir || defaultWhatsAppStateDir(env), 'media', 'audio');
}

export function defaultWhatsAppConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH?.trim()
    || env.OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH?.trim()
    || env.OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH?.trim()
    || join(defaultWhatsAppStateDir(env), 'connector-store.db');
}

// The store may also contain archive-import runs. Only a cursor shaped like the
// live connector's file/line position can resume the live spool traversal.
export function sanitizeWhatsAppLiveCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const separator = cursor.lastIndexOf(':');
  const file = separator > 0 ? cursor.slice(0, separator) : '';
  const line = separator > 0 ? cursor.slice(separator + 1) : '';
  return file && /^\d+$/.test(line) ? cursor : undefined;
}

export function defaultWhatsAppInternalConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH?.trim()
    || join(defaultWhatsAppStateDir(env), 'connector-store-internal.db');
}

/**
 * The WhatsApp lane's per-tier stores (design
 * docs/design/per-item-four-tier-classification.md, sections 2.1 and 3.2).
 *
 * Fail closed. The lane's store stays `secure_local.whatsapp.messages`: every
 * message stored before per-item routing keeps its place there, and every new
 * message rests there too, at Private, by default. A chat is a chat-level
 * prior that a message is never lowered below. Only an explicit OWNER chat
 * rule that sets a chat to Personal (or a per-item owner override) lifts that
 * floor, and then only a message judged Personal from its own text goes to
 * `internal.whatsapp.messages`; any message the detectors raise, or whose
 * question is still open, stays Private. A message is kept whole (names and
 * text in one store), and one carrying a secret is stored nowhere.
 */
export function createWhatsAppTierLane(options: {
  store: LocalConnectorStore;
  env?: Record<string, string | undefined>;
  /** The cloud identity for the Personal store. */
  internalEmbeddingProvider?: SourceEmbeddingProvider;
  /** Owner chat rules arrive here (tier-rules loading is phase P2). */
  tierClassification?: ConnectorStoreTierClassification;
  secretLocations?: SecretLocationsIndex;
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): ExistingStoreTierLane {
  if (options.store.trustDomain !== 'secure_local') {
    throw new Error('The WhatsApp lane\'s own store is secure_local.');
  }
  const env = options.env ?? process.env;
  const internalDbPath = defaultWhatsAppInternalConnectorStoreDbPath(env);
  return createExistingStoreTierLane({
    setId: WHATSAPP_PERSONAL_SOURCE_ID,
    store: options.store,
    splitLayers: false,
    laneFloor: { trustDomain: 'secure_local', liftedByOwnerRule: ['chat'] },
    newLegs: {
      internal: {
        corpusId: WHATSAPP_INTERNAL_CORPUS_ID,
        dbPath: internalDbPath,
        create: (ledger) => new LocalConnectorStore({
          dbPath: internalDbPath,
          corpusId: WHATSAPP_INTERNAL_CORPUS_ID,
          family: 'chat',
          trustDomain: 'internal',
          tierLedger: ledger,
        }),
        ...(options.internalEmbeddingProvider ? { embeddingProvider: options.internalEmbeddingProvider } : {}),
      },
    },
    ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.onStoreOpened ? { onStoreOpened: options.onStoreOpened } : {}),
  });
}

export function createWhatsAppConnectorStore(
  env: Record<string, string | undefined> = process.env,
): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: defaultWhatsAppConnectorStoreDbPath(env),
    corpusId: WHATSAPP_LIVE_CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  });
}

export function createWhatsAppConnectorStoreSyncHandler(options: {
  store: LocalConnectorStore;
  spoolDir?: string;
  account?: string;
  maxItems?: number;
  spoolStaleThresholdSeconds?: number;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /**
   * The lane's per-tier stores (createWhatsAppTierLane), whose secure leg is
   * `store`. Absent: the single-store lane exactly as before.
   */
  tierSet?: TieredStoreSet;
}): WhatsAppConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const spoolDir = options.spoolDir?.trim() || defaultWhatsAppSpoolDir(env);
  const account = options.account?.trim() || WHATSAPP_PERSONAL_ACCOUNT_SCOPE;
  const connector = {
    ...createWhatsAppLiveSourceConnector({ spoolDir, account }),
    // The private drain retains WHATSAPP_LIVE_CONNECTOR_ID until it is retired
    // after observed qualification. A distinct product cursor prevents either
    // writer from advancing or regressing the other's traversal meanwhile.
    id: WHATSAPP_PRODUCT_CONNECTOR_ID,
  };
  const staleThresholdSeconds = whatsappCaptureStaleThresholdSeconds(
    options.spoolStaleThresholdSeconds,
    env,
  );
  const now = options.now ?? (() => new Date());
  const tierSet = options.tierSet;
  if (tierSet && tierSet.legSpec('secure_local')?.store !== options.store) {
    throw new Error('The WhatsApp tier set\'s secure leg must be the lane\'s own store.');
  }

  return {
    async pull(request = {}): Promise<WhatsAppConnectorStoreSyncReceipt> {
      // The tier set's committed resume point comes first: it is written only
      // after every tier store committed.
      const cursor = sanitizeWhatsAppLiveCursor(
        tierSet?.committedCursor(WHATSAPP_PRODUCT_CONNECTOR_ID)?.cursor
          ?? options.store.lastCompletedSyncRun(WHATSAPP_PRODUCT_CONNECTOR_ID)?.cursor
          ?? undefined,
      );
      const maxItems = request.max_items ?? options.maxItems;
      const sync = {
        placement: WHATSAPP_STORE_PLACEMENT,
        ...(cursor ? { cursor } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        fetchContent: true,
        // Text messages carry their body in the spool listing. Media bodies
        // are owned by the shared extraction factory, so a later metadata
        // observation must preserve the transcript that factory wrote.
        deferMetadataOnlyContent: true,
      };
      let run: ConnectorStoreSyncSummary;
      let tiered: TieredLaneReceiptCounts = {};
      if (tierSet) {
        const setRun = await tierSet.sync(connector, sync);
        run = mergedTieredLaneRun(setRun, 'secure_local').sync;
        tiered = tieredLaneReceiptCounts({ routing: setRun.routing });
      } else {
        run = await options.store.syncFromConnector(connector, sync);
      }
      return whatsappSyncReceipt(
        run,
        readWhatsAppLiveSpoolStatus(spoolDir),
        now().getTime(),
        staleThresholdSeconds,
        tiered,
      );
    },

    lastStoreRunCompletedAt(): string | undefined {
      return options.store.lastCompletedSyncRun(WHATSAPP_PRODUCT_CONNECTOR_ID)?.completedAt;
    },
  };
}

function whatsappSyncReceipt(
  run: ConnectorStoreSyncSummary,
  spool: ReturnType<typeof readWhatsAppLiveSpoolStatus>,
  nowMs: number,
  staleThresholdSeconds: number,
  tiered: TieredLaneReceiptCounts = {},
): WhatsAppConnectorStoreSyncReceipt {
  const capture = whatsappCaptureFreshness(spool.newestMessageTimestamp, nowMs, staleThresholdSeconds);
  const warnings = [
    ...(spool.malformedLines > 0 ? [WHATSAPP_MALFORMED_SPOOL_WARNING] : []),
    ...(spool.unresolvedReactionTargets > 0 ? [WHATSAPP_UNRESOLVED_REACTIONS_WARNING] : []),
    ...(capture.status === 'stale' ? [WHATSAPP_CAPTURE_STALE_WARNING] : []),
    ...(capture.status === 'unavailable' ? [WHATSAPP_CAPTURE_UNAVAILABLE_WARNING] : []),
  ];
  const progressed = run.itemsChanged > 0 || run.itemsTombstoned > 0;
  return {
    status: progressed ? 'progress' : 'idle',
    counts: {
      items_seen: run.itemsSeen,
      items_indexed: run.itemsIndexed,
      items_changed: run.itemsChanged,
      items_tombstoned: run.itemsTombstoned,
      items_rejected: run.itemsRejected,
      items_metadata_only: run.itemsMetadataOnly,
      chunks_indexed: run.chunksIndexed,
      malformed_spool_lines: spool.malformedLines,
      unresolved_reaction_targets: spool.unresolvedReactionTargets,
      capture_fresh: capture.status === 'fresh' ? 1 : 0,
      capture_stale: capture.status === 'stale' ? 1 : 0,
      capture_unavailable: capture.status === 'unavailable' ? 1 : 0,
      capture_stale_threshold_seconds: capture.threshold_seconds,
      ...(capture.age_seconds !== undefined ? { capture_age_seconds: capture.age_seconds } : {}),
      ...tiered,
    },
    capture,
    ...(warnings.length > 0 ? { warnings } : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      provider_cursor_exposed: false,
      local_only: true,
    },
  };
}

function whatsappCaptureStaleThresholdSeconds(
  configured: number | undefined,
  env: Record<string, string | undefined>,
): number {
  const raw = configured ?? (
    env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_STALE_THRESHOLD_SECONDS?.trim()
      ? Number(env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_STALE_THRESHOLD_SECONDS)
      : DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS
  );
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error('WhatsApp capture stale threshold must be a positive integer.');
  }
  return raw;
}

function whatsappCaptureFreshness(
  newestTimestamp: string | undefined,
  nowMs: number,
  thresholdSeconds: number,
): WhatsAppConnectorStoreSyncReceipt['capture'] {
  const newestMs = newestTimestamp ? Date.parse(newestTimestamp) : Number.NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(newestMs)) {
    return { status: 'unavailable', threshold_seconds: thresholdSeconds };
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - newestMs) / 1_000));
  return {
    status: ageSeconds > thresholdSeconds ? 'stale' : 'fresh',
    threshold_seconds: thresholdSeconds,
    age_seconds: ageSeconds,
  };
}
