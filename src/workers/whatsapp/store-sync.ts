// Product-owned control plane for the WhatsApp capture spool. Provider/session
// work stays in the thin whatsmeow bridge; this module only hands captured
// records to the shared SourceConnector -> LocalConnectorStore spine.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LocalConnectorStore,
  type ConnectorStoreSyncSummary,
} from '../connector-store/index.ts';
import {
  WHATSAPP_LIVE_CONNECTOR_ID,
  createWhatsAppLiveSourceConnector,
  readWhatsAppLiveSpoolStatus,
} from './live-connector.ts';

export const WHATSAPP_PERSONAL_SOURCE_ID = 'whatsapp.personal.messages';
export const WHATSAPP_LIVE_CORPUS_ID = 'secure_local.whatsapp.messages';
export const WHATSAPP_PERSONAL_ACCOUNT_SCOPE = 'personal';
export const WHATSAPP_PRODUCT_CONNECTOR_ID = 'whatsapp_product_spool';
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
  };
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

  return {
    async pull(request = {}): Promise<WhatsAppConnectorStoreSyncReceipt> {
      const cursor = sanitizeWhatsAppLiveCursor(
        options.store.lastCompletedSyncRun(WHATSAPP_PRODUCT_CONNECTOR_ID)?.cursor,
      );
      const maxItems = request.max_items ?? options.maxItems;
      const run = await options.store.syncFromConnector(connector, {
        ...(cursor ? { cursor } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        fetchContent: true,
        // Text messages carry their body in the spool listing. Media bodies
        // are owned by the shared extraction factory, so a later metadata
        // observation must preserve the transcript that factory wrote.
        deferMetadataOnlyContent: true,
      });
      return whatsappSyncReceipt(
        run,
        readWhatsAppLiveSpoolStatus(spoolDir),
        now().getTime(),
        staleThresholdSeconds,
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
