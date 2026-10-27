// Product-owned control plane for the WhatsApp capture spool. Provider/session
// work stays in the thin whatsmeow bridge; this module only hands captured
// records to the shared SourceConnector -> LocalConnectorStore spine.

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorStorePlacementRule } from '../connector-store/tier-placement.ts';
import {
  legacyWhatsAppLiveSyncPaths,
  WHATSAPP_SOURCE_ID,
} from '../../core/olympus-layout.ts';
import { placedAccount, resolvedRawPath, resolvedStorePath, whatsappMovedPathMapper } from '../../core/source-placement.ts';
import type {
  LocalConnectorStore,
  ConnectorStoreSyncSummary,
} from '../connector-store/index.ts';
import { openConnectorStore } from '../../core/source-storage.ts';
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
  addCaptureSpoolRedactions,
  createSpoolSecretJudge,
  sweepCaptureSpoolWhenSecretsChange,
  type CaptureSpoolRedactionResult,
  type SpoolSecretJudge,
} from '../connector-store/capture-spool-secrets.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import {
  captureFreshnessCounts,
  captureLiveness,
  captureStaleThresholdSeconds,
  type CaptureLiveness,
} from '../connector-store/capture-freshness.ts';
import {
  WHATSAPP_LIVE_CONNECTOR_ID,
  createWhatsAppLiveSourceConnector,
  emptyWhatsAppSpoolPassFindings,
  isWhatsAppSpoolCursor,
  readWhatsAppLiveCaptureState,
  redactWhatsAppLiveSpoolSecrets,
  whatsAppSpoolLineCursor,
  type WhatsAppSpoolPassFindings,
} from './live-connector.ts';
import { offsetAfterLines, terminatedLinesEnd } from './spool-reader.ts';
import { spoolBoundaryDigest, spoolBoundaryHolds, spoolFileIdentity } from '../connector-store/spool-file-identity.ts';
import { WhatsAppSpoolIndex } from './spool-index.ts';

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
export const WHATSAPP_SPOOL_REDACTION_FAILED_WARNING = 'whatsapp_spool_secret_redaction_failed';
/** A spool record over the per-record bound was skipped unread. */
export const WHATSAPP_OVERSIZED_SPOOL_WARNING = 'whatsapp_oversized_spool_records';
/** The resume point's file was replaced or has gone; see the counts. */
export const WHATSAPP_SPOOL_CURSOR_RECOVERED_WARNING = 'whatsapp_spool_cursor_recovered';
/** The bridge says it is disconnected: capture has stopped until it links again. */
export const WHATSAPP_CAPTURE_DISCONNECTED_WARNING = 'whatsapp_capture_disconnected';
/** The bridge dropped messages from a full queue within the stale threshold. */
export const WHATSAPP_CAPTURE_DROPPED_WARNING = 'whatsapp_capture_dropped_messages';
// Where the full-spool Secrets pass stands, kept in the set's tier ledger.
export const WHATSAPP_SPOOL_REDACTION_STATE_KEY = 'capture_spool_secret_redaction:whatsapp';

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
    /** Lines this pull skipped as unreadable. */
    malformed_spool_lines: number;
    /** Records this pull skipped unread for being over the per-record bound. */
    oversized_spool_records: number;
    /** Reacted-to messages this pull could not attach reactions to. */
    unresolved_reaction_targets: number;
    /** 1 when the resume point's file had been replaced and was read again from its start. */
    spool_cursor_recovered: number;
    /** 1 when the resume point's file had gone; what it held past the cursor could not be read. */
    spool_cursor_file_missing: number;
    /** 1 when this pull stopped at its byte budget; the next pull goes on. */
    spool_pass_budget_reached: number;
    /** Messages the bridge dropped from a full queue, over the life of its state folder. */
    capture_dropped_messages: number;
    capture_fresh: number;
    capture_stale: number;
    capture_unavailable: number;
    capture_stale_threshold_seconds: number;
    capture_age_seconds?: number;
    /** 1 when the bridge reports capture running and no message arrived within the threshold. */
    capture_quiet: 0 | 1;
    /** 1 when the bridge says it is disconnected (past a short grace): capture has stopped. */
    capture_stopped: 0 | 1;
    /**
     * Spool lines whose message was judged Secrets and that this pull
     * rewrote without their text (blanked ones included).
     */
    spool_records_redacted: number;
  } & TieredLaneReceiptCounts;
  capture: CaptureLiveness;
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

// The account's paths: the registry's layout (core/source-placement.ts), and for a
// `legacy` account what these resolvers always returned, overrides included
// (core/olympus-layout.ts).
export function defaultWhatsAppStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolvedRawPath(WHATSAPP_SOURCE_ID, 'whatsapp', env);
}

export function defaultWhatsAppSpoolDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolvedRawPath(WHATSAPP_SOURCE_ID, 'whatsapp-spool', env);
}

export function defaultWhatsAppMediaDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolvedRawPath(WHATSAPP_SOURCE_ID, 'whatsapp-media', env);
}

/** The folders a media extraction may read from: a folder account's whole media folder, else the audio folder. */
export function defaultWhatsAppMediaRoots(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [resolvedRawPath(WHATSAPP_SOURCE_ID, 'whatsapp-media-root', env)];
}

/**
 * Where scripts/whatsapp-live-sync.ts reads and writes: the account's own
 * folder when it lives in one, else the places that script always used, which
 * are not the worker's: it ignored XDG_DATA_HOME and every override but the
 * state folder's, so a cron job keeps its spool and database when an install
 * relocates the data folder or sets a spool or store override for the worker.
 */
export function whatsAppLiveSyncScriptPaths(
  env: Record<string, string | undefined> = process.env,
  homeDir: string | undefined = homedir(),
): { spoolDir: string; dbPath: string } {
  if (placedAccount(WHATSAPP_SOURCE_ID, env).layout === 'folder') {
    return { spoolDir: defaultWhatsAppSpoolDir(env), dbPath: resolvedStorePath(WHATSAPP_SOURCE_ID, 'secure_local', env) };
  }
  return legacyWhatsAppLiveSyncPaths(env, homeDir ?? homedir());
}

// The store may also contain archive-import runs. Only a cursor shaped like the
// live connector's spool position (`<file>:<lines>@<offset>`, or the older
// `<file>:<lines>`) can resume the live spool traversal, as can the listing's
// own resume point inside a page of one (core/source-inputs.ts).
export function sanitizeWhatsAppLiveCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  return isWhatsAppSpoolCursor(cursor) || isWhatsAppSpoolCursor(spoolPositionOf(cursor) ?? '') ? cursor : undefined;
}

/** The spool position a cursor stands at: itself, or the page start a resume point inside a page names. */
function spoolPositionOf(cursor: string): string | undefined {
  const inside = /^~in1~\d+~\d+~([\s\S]+)$/u.exec(cursor);
  return inside ? inside[1] : cursor;
}

/** The byte offset a committed cursor stands at, when it carries one (not inside an over-long record). */
function byteOffsetOf(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const found = /@(\d+)(?:~r[0-9a-f.]+)?$/u.exec(spoolPositionOf(cursor) ?? '');
  return found ? Number(found[1]) : undefined;
}

/** A committed cursor in the `<file>:<lines>` form the spool's Secrets clearing counts by. */
function lineCursorOf(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const position = spoolPositionOf(cursor);
  return position === undefined ? undefined : whatsAppSpoolLineCursor(position);
}

/**
 * The WhatsApp lane's per-tier stores (design
 * docs/design/per-item-four-tier-classification.md, sections 2.1 and 3.2).
 *
 * Fail closed. The lane's store stays `secure_local.whatsapp.messages`: every
 * message stored before per-item routing keeps its place there, and every new
 * message rests there too, at Private, by default. A chat is a chat-level
 * prior that a message is never lowered below. Only an explicit OWNER chat
 * rule that sets a chat to Personal lifts that floor, and then only a message
 * judged Personal from its own text goes to `internal.whatsapp.messages`; any
 * message the detectors raise, or whose question is still open, stays
 * Private. A per-item owner override also lifts it, and is final by design:
 * it sets that one message's tier whatever its text says. A message is kept whole (names and
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
  const internalDbPath = resolvedStorePath(WHATSAPP_SOURCE_ID, 'internal', env);
  return createExistingStoreTierLane({
    setId: WHATSAPP_PERSONAL_SOURCE_ID,
    store: options.store,
    splitLayers: false,
    laneFloor: { trustDomain: 'secure_local', liftedByOwnerRule: ['chat'] },
    newLegs: {
      internal: {
        corpusId: WHATSAPP_INTERNAL_CORPUS_ID,
        dbPath: internalDbPath,
        create: (ledger) => openConnectorStore({ sourceId: WHATSAPP_PERSONAL_SOURCE_ID }, {
          dbPath: internalDbPath,
          corpusId: WHATSAPP_INTERNAL_CORPUS_ID,
          family: 'chat',
          trustDomain: 'internal',
          tierLedger: ledger,
        }, env),
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
  return openConnectorStore({ sourceId: WHATSAPP_PERSONAL_SOURCE_ID }, {
    dbPath: resolvedStorePath(WHATSAPP_SOURCE_ID, 'secure_local', env),
    corpusId: WHATSAPP_LIVE_CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  }, env);
}

export function createWhatsAppConnectorStoreSyncHandler(options: {
  store: LocalConnectorStore;
  spoolDir?: string;
  account?: string;
  maxItems?: number;
  spoolStaleThresholdSeconds?: number;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Where the bridge saves audio, deleted for a Secret message. */
  mediaDir?: string;
  /**
   * The lane's per-tier stores (createWhatsAppTierLane), whose secure leg is
   * `store`. Absent: the single-store lane exactly as before.
   */
  tierSet?: TieredStoreSet;
}): WhatsAppConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const spoolDir = options.spoolDir?.trim() || defaultWhatsAppSpoolDir(env);
  const account = options.account?.trim() || WHATSAPP_PERSONAL_ACCOUNT_SCOPE;
  const mediaDir = options.mediaDir?.trim() || defaultWhatsAppMediaDir(env);
  // One connector per pull, so each receipt counts what that pull read.
  const connectorFor = (findings: WhatsAppSpoolPassFindings) => ({
    ...createWhatsAppLiveSourceConnector({ spoolDir, account, findings }),
    // The private drain retains WHATSAPP_LIVE_CONNECTOR_ID until it is retired
    // after observed qualification. A distinct product cursor prevents either
    // writer from advancing or regressing the other's traversal meanwhile.
    id: WHATSAPP_PRODUCT_CONNECTOR_ID,
  });
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
      const findings = emptyWhatsAppSpoolPassFindings();
      const connector = connectorFor(findings);
      let run: ConnectorStoreSyncSummary;
      let tiered: TieredLaneReceiptCounts = {};
      let redacted: CaptureSpoolRedactionResult | undefined;
      let redactionFailed = false;
      if (tierSet) {
        const setRun = await tierSet.sync(connector, sync);
        run = mergedTieredLaneRun(setRun, 'secure_local').sync;
        tiered = tieredLaneReceiptCounts({ routing: setRun.routing });
        // Every line the set has now committed past was judged. Any whose
        // message is Secrets loses its text and audio here, and a whole-spool
        // pass runs when the set of Secrets changed. The stores already hold
        // none of it; a failure is reported and retried on the next pull.
        try {
          const committed = sanitizeWhatsAppLiveCursor(
            tierSet.committedCursor(WHATSAPP_PRODUCT_CONNECTOR_ID)?.cursor ?? undefined,
          );
          redacted = clearWhatsAppSpoolSecrets({
            spoolDir,
            account,
            mediaDir,
            relocateMediaPath: whatsappMovedPathMapper(env),
            ledger: tierSet.ledger,
            through: lineCursorOf(committed),
            ...(byteOffsetOf(committed) !== undefined ? { throughOffset: byteOffsetOf(committed)! } : {}),
          });
        } catch (error) {
          redactionFailed = true;
          console.error(
            `[olympus:whatsapp] spool_secret_redaction_failed reason=${error instanceof Error ? error.name : 'unknown'}`,
          );
        }
      } else {
        run = await options.store.syncFromConnector(connector, sync);
      }
      return whatsappSyncReceipt(
        run,
        findings,
        readWhatsAppLiveCaptureState(spoolDir),
        now().getTime(),
        staleThresholdSeconds,
        tiered,
        redacted,
        redactionFailed,
      );
    },

    lastStoreRunCompletedAt(): string | undefined {
      return options.store.lastCompletedSyncRun(WHATSAPP_PRODUCT_CONNECTOR_ID)?.completedAt;
    },
  };
}

/**
 * Clear the Secrets out of the spool lines the set has committed past
 * (connector-store/capture-spool-secrets.ts), and the audio they saved.
 *
 * What was cleared is kept per file, by the file's identity and size (in the
 * set's ledger), never by a line number alone: a file is owed again, from its
 * start, whenever its identity changed (a replacement, a cursor reset) or it
 * is shorter than when it was cleared, and an appended file is owed from the
 * line clearing reached. A pull clears every file it owes, however little it
 * read, and records a file only once its clearing succeeded, so a failure is
 * owed until a pull clears it. A pull that owes nothing reads no spool file.
 * A whole-spool pass still runs when the set of Secrets changed.
 *
 * Clearing the Secrets already known never waits on the listing: a file past
 * the cursor that was never cleared, or that no longer holds what clearing
 * recorded of it (rewritten, replaced, or a reset sent the cursor back past
 * it), is cleared of them from its start on every pull until it is recorded,
 * whatever the cursor or the pull's item limit. That clearing is bounded by
 * bytes per pull (at least one whole file), and certifies none of its lines
 * for a later judgment: those lines are cleared again as the cursor reaches
 * them.
 */
export function clearWhatsAppSpoolSecrets(options: {
  spoolDir: string;
  account: string;
  mediaDir?: string;
  ledger: TierLedger;
  /** Where the set has committed to, `<file>:<lines>`: nothing past it is cleared yet. */
  through: string | undefined;
  /** The byte offset of `through` in its file, when the cursor carries it. */
  throughOffset?: number;
  /** Maps a media path a spool line names at the account's old place to the account folder (`whatsappMovedPathMapper`). */
  relocateMediaPath?: (path: string) => string;
  /** The bytes a pull may read clearing known Secrets ahead of the cursor (default 32 MiB; at least one whole file). */
  aheadBudgetBytes?: number;
}): CaptureSpoolRedactionResult {
  const redact = (window: { from?: string; through: string }, judge: SpoolSecretJudge) => redactWhatsAppLiveSpoolSecrets({
    spoolDir: options.spoolDir,
    account: options.account,
    ...(options.mediaDir ? { mediaDir: options.mediaDir } : {}),
    ...(options.relocateMediaPath ? { relocateMediaPath: options.relocateMediaPath } : {}),
    ...window,
    judge,
  });
  const through = options.through === undefined ? undefined : /^(.+):(\d+)$/u.exec(options.through);
  if (!through) return addCaptureSpoolRedactions();
  const throughFile = through[1]!;
  const throughLine = Number(through[2]);
  const recorded = readClearedFiles(options.ledger);
  const next: Record<string, ClearedFile> = {};
  let result = addCaptureSpoolRedactions();
  let failure: unknown;
  const judge = createSpoolSecretJudge({ ledger: options.ledger, floor: true });
  const files = spoolFileNames(options.spoolDir);
  // Clearing rewrites lines in place; the index's record of each file it rewrote is taken again in the same step.
  const rewritten = new Set<string>();
  for (const file of files) {
    if (file > throughFile) break;
    const path = join(options.spoolDir, file);
    const before = spoolFileIdentity(path);
    if (!before) continue;
    const known = recorded[file];
    const same = holds(path, before, known);
    // How far the record is certified for a later judgment (a file cleared ahead of the cursor: none of it).
    const certified = known?.judgedLines ?? 0;
    // A file before the cursor's is cleared whole; the cursor's own, up to the cursor. A file that broke the
    // spool contract (or was never cleared) keeps none of its old boundaries: it is cleared whole, from its start.
    const end = same && file === throughFile ? throughLine : ALL_LINES;
    if (same && (end === ALL_LINES ? before.size === known.size && certified >= known.lines : certified >= end)) {
      next[file] = known!;
      continue;
    }
    const start = same ? Math.min(certified, known.lines) : 0;
    // Where this scan stops is fixed before it starts: the lines the file holds now (a whole file) or the cursor's.
    // A line appended while it runs is past that boundary, so it is owed to the next pull, never certified unread.
    const scanned = end === ALL_LINES
      ? terminatedLinesEnd(path)
      : { lines: end, offset: options.throughOffset ?? offsetAfterLines(path, end) };
    if (scanned === undefined || scanned.offset === undefined) continue;
    try {
      const cleared = redact({ from: `${file}:${start}`, through: `${file}:${scanned.lines}` }, judge);
      if (cleared.recordsRedacted + cleared.recordsBlanked > 0) rewritten.add(file);
      result = addCaptureSpoolRedactions(result, cleared);
    } catch (error) {
      failure = error;
      break;
    }
    // Recorded at the boundary scanned, as the file is after its own rewrite (its first line may have changed): the
    // size is the one before the scan, so anything written since is owed.
    // Certified up to what was judged: all of it, but for the cursor's own file cleared whole, only up to the cursor
    // (what lies past it is not judged yet).
    const judged = file === throughFile ? Math.min(scanned.lines, throughLine) : scanned.lines;
    const entry = clearedFileNow(path, scanned.lines, scanned.offset, before.size, judged);
    if (entry) next[file] = entry;
    else delete next[file];
  }
  // Files not reached keep what was recorded of them (a failure stops the pass); files that are gone are forgotten.
  const present = new Set(files);
  for (const [file, known] of Object.entries(recorded)) {
    if (next[file] === undefined && present.has(file) && file >= (failure === undefined ? throughFile : '')) next[file] = known;
  }
  // Ahead of the cursor: every file never cleared, or no longer as clearing recorded it, is cleared of the Secrets
  // already known, from its start, within the byte budget (one whole file at least). Its lines stay uncertified.
  if (failure === undefined) {
    let budget = options.aheadBudgetBytes ?? WHATSAPP_SPOOL_AHEAD_CLEAR_BYTES;
    for (const file of files) {
      if (file <= throughFile) continue;
      const path = join(options.spoolDir, file);
      const before = spoolFileIdentity(path);
      if (!before) continue;
      if (holds(path, before, next[file])) continue;
      if (budget <= 0) break;
      const scanned = terminatedLinesEnd(path);
      if (scanned === undefined) continue;
      try {
        const cleared = redact({ from: `${file}:0`, through: `${file}:${scanned.lines}` }, judge);
        if (cleared.recordsRedacted + cleared.recordsBlanked > 0) rewritten.add(file);
        result = addCaptureSpoolRedactions(result, cleared);
      } catch (error) {
        failure = error;
        break;
      }
      budget -= scanned.offset;
      const entry = clearedFileNow(path, scanned.lines, scanned.offset, before.size, 0);
      if (entry) next[file] = entry;
      else delete next[file];
    }
  }
  options.ledger.writeMeta(CLEARED_FILES_KEY, JSON.stringify(next));
  refreshIndex(options.spoolDir, rewritten);
  if (failure !== undefined) throw failure;
  const sweep = sweepCaptureSpoolWhenSecretsChange({
    ledger: options.ledger,
    stateKey: WHATSAPP_SPOOL_REDACTION_STATE_KEY,
    sweep: (sweepJudge) => redact({ through: options.through! }, sweepJudge),
  });
  if (sweep && sweep.recordsRedacted + sweep.recordsBlanked > 0) {
    // A whole-spool pass may have rewritten any file: every record of a file is taken again, at the boundary it had.
    for (const [file, known] of Object.entries(next)) {
      // Taken again at the boundary it had, never past it: the sweep cleared only what the window had.
      // What it certified is kept as it was: the sweep certifies nothing new.
      const entry = clearedFileNow(join(options.spoolDir, file), known.lines, known.offset, known.size, known.judgedLines);
      if (entry) next[file] = entry;
      else delete next[file];
    }
    options.ledger.writeMeta(CLEARED_FILES_KEY, JSON.stringify(next));
    refreshIndex(options.spoolDir, new Set(files));
  }
  return addCaptureSpoolRedactions(result, sweep);
}

/**
 * What was cleared of one spool file: its identity then, how many of its
 * lines, the byte offset just past them and the digest of the 4 KiB that end
 * there (connector-store/spool-file-identity.ts), and the file's size then
 * (a fragment being written past the last line included).
 */
interface ClearedFile {
  identity: string;
  lines: number;
  offset: number;
  boundary: string;
  size: number;
  /**
   * The lines of it certified for a later judgment: all `lines` once the
   * cursor has passed them, none for a file cleared ahead of the cursor. A
   * record without it (older, or unreadable) certifies none, so it is cleared
   * again in full once.
   */
  judgedLines: number;
}

const ALL_LINES = -1;
/** What a pull may read clearing known Secrets ahead of the cursor (at least one whole file). */
export const WHATSAPP_SPOOL_AHEAD_CLEAR_BYTES = 32 * 1024 * 1024;

/** The same file holding the same bytes up to where clearing reached: anything after it was appended. */
function holds(path: string, now: { identity: string; size: number }, known: ClearedFile | undefined): known is ClearedFile {
  return known !== undefined && known.identity === now.identity && now.size >= known.offset
    && spoolBoundaryHolds(path, known.offset, known.boundary);
}
const CLEARED_FILES_KEY = `${WHATSAPP_SPOOL_REDACTION_STATE_KEY}:cleared_files`;

/**
 * A file's cleared record at the boundary that was scanned (`lines` lines,
 * ending at `offset`), with its identity and the digest there as the file is
 * now, and the lines of it certified for a later judgment. Never recounted: a
 * boundary is what a scan reached, not what the file holds by the time it is
 * recorded. Every record is made here, so none loses what it certified.
 */
function clearedFileNow(path: string, lines: number, offset: number, size: number, judgedLines: number): ClearedFile | undefined {
  const identity = spoolFileIdentity(path);
  if (!identity) return undefined;
  const boundary = spoolBoundaryDigest(path, offset);
  if (boundary === undefined) return undefined;
  return { identity: identity.identity, lines, offset, boundary, size, judgedLines: Math.min(judgedLines, lines) };
}

function refreshIndex(spoolDir: string, files: ReadonlySet<string>): void {
  if (files.size === 0) return;
  const index = WhatsAppSpoolIndex.open(spoolDir);
  if (!index) return;
  try {
    for (const file of files) index.refreshFile(spoolDir, file);
  } finally {
    index.close();
  }
}

function readClearedFiles(ledger: TierLedger): Record<string, ClearedFile> {
  const raw = ledger.readMeta(CLEARED_FILES_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ClearedFile>;
    const valid: Record<string, ClearedFile> = {};
    for (const [file, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.identity === 'string' && typeof entry.boundary === 'string'
        && Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.lines) && entry.lines >= 0
        && Number.isSafeInteger(entry.size)) {
        // Fails closed: a missing or unreadable certification certifies nothing.
        const judgedLines = Number.isSafeInteger(entry.judgedLines) && entry.judgedLines >= 0 ? Math.min(entry.judgedLines, entry.lines) : 0;
        valid[file] = { ...entry, judgedLines };
      }
    }
    return valid;
  } catch {
    return {};
  }
}

function spoolFileNames(spoolDir: string): string[] {
  try {
    return readdirSync(spoolDir).filter((name) => name.toLowerCase().endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

function whatsappSyncReceipt(
  run: ConnectorStoreSyncSummary,
  findings: WhatsAppSpoolPassFindings,
  state: ReturnType<typeof readWhatsAppLiveCaptureState>,
  nowMs: number,
  staleThresholdSeconds: number,
  tiered: TieredLaneReceiptCounts = {},
  redacted?: CaptureSpoolRedactionResult,
  redactionFailed = false,
): WhatsAppConnectorStoreSyncReceipt {
  // The bridge's heartbeat tells a quiet account from a stopped capture; a
  // bridge that writes none is judged by its newest message, as before.
  const capture = captureLiveness(
    state.newestMessageTimestamp,
    state.status?.connectedThrough,
    nowMs,
    staleThresholdSeconds,
    // The bridge says it is not connected: capture has stopped, however recent its last word.
    state.status !== undefined && !state.status.connected
      ? { ...(state.status.connectedThrough ?? state.status.updatedAt ? { stoppedAt: (state.status.connectedThrough ?? state.status.updatedAt)! } : {}) }
      : undefined,
  );
  const lastDroppedMs = Date.parse(state.status?.lastDroppedAt ?? '');
  const recentDrop = Number.isFinite(lastDroppedMs) && nowMs - lastDroppedMs <= staleThresholdSeconds * 1_000;
  const warnings = [
    ...(findings.malformedLines > 0 ? [WHATSAPP_MALFORMED_SPOOL_WARNING] : []),
    ...(findings.oversizedRecords > 0 ? [WHATSAPP_OVERSIZED_SPOOL_WARNING] : []),
    ...(findings.unresolvedReactionTargets > 0 ? [WHATSAPP_UNRESOLVED_REACTIONS_WARNING] : []),
    ...(findings.cursorsRecovered > 0 || findings.cursorFilesMissing > 0 ? [WHATSAPP_SPOOL_CURSOR_RECOVERED_WARNING] : []),
    ...(recentDrop && (state.status?.droppedMessages ?? 0) > 0 ? [WHATSAPP_CAPTURE_DROPPED_WARNING] : []),
    ...(capture.status === 'stale' ? [WHATSAPP_CAPTURE_STALE_WARNING] : []),
    ...(capture.stopped ? [WHATSAPP_CAPTURE_DISCONNECTED_WARNING] : []),
    ...(capture.status === 'unavailable' ? [WHATSAPP_CAPTURE_UNAVAILABLE_WARNING] : []),
    ...(redactionFailed ? [WHATSAPP_SPOOL_REDACTION_FAILED_WARNING] : []),
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
      malformed_spool_lines: findings.malformedLines,
      oversized_spool_records: findings.oversizedRecords,
      unresolved_reaction_targets: findings.unresolvedReactionTargets,
      spool_cursor_recovered: findings.cursorsRecovered > 0 ? 1 : 0,
      spool_cursor_file_missing: findings.cursorFilesMissing > 0 ? 1 : 0,
      spool_pass_budget_reached: findings.passBudgetReached > 0 ? 1 : 0,
      capture_dropped_messages: state.status?.droppedMessages ?? 0,
      ...captureFreshnessCounts(capture),
      spool_records_redacted: (redacted?.recordsRedacted ?? 0) + (redacted?.recordsBlanked ?? 0),
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
  return captureStaleThresholdSeconds(
    configured,
    env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_STALE_THRESHOLD_SECONDS,
    'WhatsApp',
  );
}
