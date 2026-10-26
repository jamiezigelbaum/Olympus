// Contract 1 (SourceConnector) adapter for the LIVE WhatsApp capture path.
// The Go daemon in tools/whatsapp-bridge (whatsmeow linked device, strictly
// read-only) appends one JSON line per message to a spool directory of
// YYYY-MM-DD.jsonl files; this connector reads that spool. It never talks to
// WhatsApp itself — the daemon is the only process that does.
//
// Spool line shape (field names are a contract with the daemon):
//   {"id","chat_jid","chat_name","sender_jid","sender_name","from_me",
//    "timestamp","text","mentions"?,"preview_title"?,
//    "preview_description"?,"preview_url"?,"media_type"?,
//    "reaction_target_id"?,"reaction_target_chat_jid"?,"reaction_key"?,
//    "reaction_removed"?}
//
// Documented reading choices:
// - Listing is by file name then line order. The daemon names files by
//   receive date (UTC), so only the lexicographically last file ever grows —
//   that append-only ordering is what makes the cursor resumable.
// - The cursor is "<fileName>:<lineCount>": the number of terminated lines
//   already consumed in that file. Resuming re-reads the directory, so lines
//   appended after a cursor was taken (the live file growing) and entirely
//   new files are both picked up.
// - Recovery: a cursor's file only ever grows, so a file holding fewer lines
//   than its cursor was replaced (the spool folder deleted and capture
//   started again the same day). It is read again from its start, since the
//   store collapses what it already holds, and counted as a recovered cursor
//   instead of silently skipping the new file's first lines. A cursor whose
//   file has vanished resumes at the next file by name, and is counted too:
//   whatever that file held past the cursor is gone.
// - Reads are streamed (spool-reader.ts): a file is read in chunks from the
//   resume point, never whole; a record over WHATSAPP_SPOOL_MAX_RECORD_BYTES
//   is skipped and counted, and one listing reads at most passByteBudget
//   bytes before it ends with a cursor for the next pass.
// - Only lines terminated by '\n' are consumed. A final unterminated
//   fragment is treated as a write in progress and left for a later page.
// - Malformed lines (broken JSON, missing/mistyped required fields) are
//   SKIPPED — they still advance the cursor so capture never wedges — and
//   counted in the listing's findings, which the pull reports as a gap.
//   They are not silently invisible.
// - A media line's text is its caption (bridges before captions wrote none).
// - WhatsApp Status posts (status@broadcast) are their own record kind: an
//   item with `recordKind: 'status'` in the "Status updates" conversation,
//   judged like any message (docs/design/archive-live-one-dataset.md, section
//   9). An export's status chat joins the same conversation.
// - The sender is labelled by the name saved in the phone's contacts when the
//   bridge read one (`sender_contact_name`), else by the push name; that is
//   what a chat export shows, so an export of the same chat matches.
// - Lines with a media_type note carry no text by daemon design; they map to
//   metadata_only RawItems with their real media MIME and local locator. The
//   shared extraction factory owns any derived text.
// - Reaction lines are the exception: they are a fact ABOUT another message,
//   not a message, so they yield no item of their own. Instead the target they
//   name is re-emitted with its full original text plus metadata.reactions,
//   the aggregate as of the whole spool. Re-emitting the text byte-identically
//   is deliberate: an empty-text emit would delete the stored chunks, and a
//   metadata_only emit would drive the store into fetchItem. A target that
//   cannot be resolved (no spool line, or a line from another chat) is skipped
//   and counted, never emitted content-less.
// - Duplicate ids can occur (the daemon re-spools offline re-deliveries).
//   Each occurrence lists normally; downstream upserts collapse them, and
//   fetchItem returns the LAST occurrence (the newest version).
// - A line whose message was judged Secrets is rewritten in place without its
//   text, preview, mentions, media path, re-download keys or saved audio, and carries
//   "secret_redacted": true (connector-store/capture-spool-secrets.ts). It
//   reads back as a metadata_only item with a Secrets floor, so a replay or a
//   reaction re-emit judges it Secrets again.

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { compactClassificationSignals, signalText, trustDomainPrior } from '../../core/classification-signals.ts';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorInput,
  SourceConnectorListOptions,
  SourceRecordPage,
} from '../../core/contracts.ts';
import { inputConnector, type SourceRecordBuilder } from '../../core/source-inputs.ts';
import type { SourceReaction } from '../../core/source-index/reactions.ts';
import {
  redactCaptureSpoolLines,
  type CaptureSpoolRedactionResult,
  type SpoolSecretJudge,
} from '../connector-store/capture-spool-secrets.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';
import {
  boundedReactionsForTarget,
  createWhatsAppReactionIndexBuilder,
  isWhatsAppReactionLine,
  normalizeWhatsAppJid,
  whatsAppReactionEntryOf,
  type WhatsAppReactionIndex,
} from './reaction-index.ts';
import { WhatsAppSpoolIndex, comparePlaces, type SpoolPlace } from './spool-index.ts';
import { WhatsAppSpoolObligations } from './spool-obligations.ts';
import { WhatsAppMatchLedger } from './match-ledger.ts';
import { OWNER_SENDER, liveMatchKeys, nameKey } from './match-keys.ts';
import {
  WHATSAPP_SPOOL_MAX_RECORD_BYTES,
  isRecordBoundary,
  newestSpoolRecord,
  offsetAfterLines,
  readWhatsAppCaptureStatus,
  spoolFileIdentity,
  spoolFileLines,
  spoolRecords,
  terminatedLinesEnd,
  type SpoolReadBudget,
  type WhatsAppCaptureStatusReceipt,
} from './spool-reader.ts';

export const WHATSAPP_LIVE_CONNECTOR_ID = 'whatsapp-live';
const CONNECTOR_ID = WHATSAPP_LIVE_CONNECTOR_ID;
const PROVIDER = 'whatsapp';
const TEXT_MIME_TYPE = 'text/plain';
const DEFAULT_ACCOUNT = 'personal';
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2_000;
export const WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND = 'whisper_transcription';
export const WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION = '2026-07-05-whatsapp-local-asr';
export const WHATSAPP_SECRET_REDACTED_FLOOR_BASIS = 'capture:secret_redacted';

export interface WhatsAppLiveSourceConnectorOptions {
  spoolDir: string;
  /** Account scope for identities; defaults to "personal". */
  account?: string;
  /** Where each listing counts what it skipped or recovered; the pull reports it. */
  findings?: WhatsAppSpoolPassFindings;
  /** Bytes one listing reads before it stops with a cursor (default 64 MiB). */
  passByteBudget?: number;
  /** A record longer than this is skipped and counted (default 1 MiB). */
  maxRecordBytes?: number;
  /** Who reads with the cursors this connector hands out (default its id): each reader owes its own replays. */
  consumer?: string;
}

/** What one or more listings skipped or recovered, as counts only. */
export interface WhatsAppSpoolPassFindings {
  /** Non-blank lines that could not be parsed, skipped. */
  malformedLines: number;
  /** Records over the per-record bound, skipped unread. */
  oversizedRecords: number;
  /** Reacted-to messages a page could not attach reactions to. */
  unresolvedReactionTargets: number;
  /** A cursor whose file was replaced since; the file was read again from its start. */
  cursorsRecovered: number;
  /** A cursor whose file has gone; listing went on at the next file. */
  cursorFilesMissing: number;
  /** A listing that stopped at its byte budget, to go on next pass. */
  passBudgetReached: number;
}

export function emptyWhatsAppSpoolPassFindings(): WhatsAppSpoolPassFindings {
  return {
    malformedLines: 0,
    oversizedRecords: 0,
    unresolvedReactionTargets: 0,
    cursorsRecovered: 0,
    cursorFilesMissing: 0,
    passBudgetReached: 0,
  };
}

const DEFAULT_PASS_BYTE_BUDGET = 64 * 1024 * 1024;
/** A reacted-to message is read from its one line in steps this size: most lines are far smaller. */
const TARGET_READ_CHUNK_BYTES = 4 * 1024;

export interface WhatsAppLiveSpoolStatus {
  files: number;
  /** Terminated lines across all spool files (blank and malformed included). */
  lines: number;
  /** Lines that parsed into valid spool messages. */
  messages: number;
  /** Gap count: non-blank lines that could not be parsed and were skipped. */
  malformedLines: number;
  /**
   * Reaction lines seen. These produce no items of their own; each one instead
   * re-emits the message it reacted to. Lines spooled before the daemon
   * captured reaction targets are counted here but name no target.
   */
  reactionLines: number;
  /**
   * Gap count: distinct reacted-to messages whose reactions could not be
   * attached, because no spool line carries that id or the only ones that do
   * belong to a different chat. Counts only — never the ids themselves.
   */
  unresolvedReactionTargets: number;
  /** Timestamp carried by the last valid terminated message in spool order. */
  newestMessageTimestamp?: string;
}

interface SpoolMessage {
  id: string;
  chatJid: string;
  chatName: string;
  senderJid: string;
  senderName: string;
  /** The name saved in the phone's contacts, when the bridge read one. */
  senderContactName?: string;
  fromMe: boolean;
  timestamp: string;
  text: string;
  mentions?: Record<string, string>;
  previewTitle?: string;
  previewDescription?: string;
  previewUrl?: string;
  mediaType?: string;
  mediaPath?: string;
  mediaMime?: string;
  mediaDurationSeconds?: number;
  mediaSizeBytes?: number;
  downloadStatus?: string;
  mediaKey?: string;
  mediaDirectPath?: string;
  mediaFileSha256?: string;
  mediaFileEncSha256?: string;
  mediaKeyTimestamp?: number;
  reactionTargetId?: string;
  reactionTargetChatJid?: string;
  reactionKey?: string;
  reactionRemoved?: boolean;
  secretRedacted?: boolean;
}

interface SpoolPosition {
  file: string;
  /** Terminated lines of `file` consumed. */
  line: number;
  /** The byte offset of that place in `file`; absent only on a cursor written before offsets. */
  offset?: number;
  /** The place is inside an over-long record whose rest is still to be skipped (it was counted). */
  skipping?: true;
  /** The index generation and the replay epoch this cursor was handed out at (spool-obligations.ts). */
  generation?: string;
  epoch?: number;
}

/**
 * A WhatsApp record: the bridge's spool line, the one shape every input of the
 * WhatsApp connector emits, with the reactions a listing attached to it.
 */
export interface WhatsAppRecord extends SpoolMessage {
  /** Present: the record restates the message's reactions (an empty list clears them). Absent: it says nothing of them. */
  reactions?: readonly SourceReaction[];
  /** Archive input only: the media the export carries for this message, each a child item. */
  children?: readonly WhatsAppChildRecord[];
}

/**
 * A piece of media an export carries for a message: a child item keyed by its
 * file's name in the export (docs/design/child-items.md), read later through
 * its locator (archive-import/input-media.ts).
 */
export interface WhatsAppChildRecord {
  key: string;
  name: string;
  mimeType: string;
  /** Absent with `available: false`: the export left the media out. */
  locator?: string;
  available: boolean;
  sizeBytes?: number;
}

export function createWhatsAppLiveSourceConnector(
  options: WhatsAppLiveSourceConnectorOptions,
): SourceConnector {
  const spoolDir = requireNonEmpty(options.spoolDir, 'WhatsApp live connector spoolDir');
  const account = options.account === undefined ? DEFAULT_ACCOUNT : requireNonEmpty(options.account, 'WhatsApp live connector account');
  const findings = options.findings ?? emptyWhatsAppSpoolPassFindings();
  const passByteBudget = normalizePositiveInteger(options.passByteBudget, DEFAULT_PASS_BYTE_BUDGET, Number.MAX_SAFE_INTEGER);
  const maxRecordBytes = normalizePositiveInteger(options.maxRecordBytes, WHATSAPP_SPOOL_MAX_RECORD_BYTES, Number.MAX_SAFE_INTEGER);

  const authenticate = async (): Promise<void> => {
    if (!existsSync(spoolDir) || !statSync(spoolDir).isDirectory()) {
      throw new Error(
        `WhatsApp live spool directory ${spoolDir} does not exist. `
        + 'Start the olympus-whatsapp-bridge daemon (tools/whatsapp-bridge) first.',
      );
    }
  };

  const fetchItem = async (localItemId: string): Promise<RawItem> => {
    const asked = localItemIdParts(localItemId, account);
    // An imported id a live message took (match-ledger.ts): read as that live message, under the imported id.
    const ledger = asked.providerItemId.startsWith('wx') ? WhatsAppMatchLedger.open(spoolDir) : undefined;
    const live = ledger?.liveOf(asked.providerItemId);
    ledger?.close();
    if (live) {
      const item = await fetchItem(`${account}:${normalizeWhatsAppJid(live.chatJid)}:${live.liveId}`);
      return { ...item, identity: { ...item.identity, providerItemId: asked.providerItemId, localItemId } };
    }
    const { chatJid, providerItemId } = asked;
    // A re-fetch is a full restatement of the item, so it carries the
    // reactions too: the store overwrites everything an emit repeats. Both
    // come from the spool index (the message's newest line and its
    // reactions); a spool the index does not hold yet is scanned.
    const index = WhatsAppSpoolIndex.open(spoolDir);
    try {
      const located = index?.newestMessage(providerItemId, chatJid);
      const indexed = located ? readMessageAt(spoolDir, located.file, located.offset) : undefined;
      if (index && indexed && indexed.id === providerItemId && (chatJid === undefined || sameWhatsAppChat(indexed.chatJid, chatJid))) {
        return rawItemFromSpoolMessage(indexed, account, nowIso(), boundedReactionsForTarget(index.reactionsFor(providerItemId), indexed.chatJid));
      }
    } finally {
      index?.close();
    }
    let match: SpoolMessage | undefined;
    const reactionIndex = createWhatsAppReactionIndexBuilder();
    for (const file of listSpoolFiles(spoolDir)) {
      for (const line of spoolFileLines(join(spoolDir, file))) {
        const message = parseSpoolLine(line);
        if (message === undefined) continue;
        if (message.reactionTargetId === providerItemId) reactionIndex.add(message);
        if (isWhatsAppReactionLine(message)) continue;
        // Last occurrence wins: re-deliveries append the newest version —
        // within the named chat, since an id is unique only there.
        if (
          message.id === providerItemId
          && (chatJid === undefined || sameWhatsAppChat(message.chatJid, chatJid))
        ) match = message;
      }
    }
    if (!match) {
      throw new Error(`WhatsApp live spool message ${localItemId} was not found under ${spoolDir}.`);
    }
    const reactions = boundedReactionsForTarget(
      reactionIndex.build().entriesFor(providerItemId),
      match.chatJid,
    );
    return rawItemFromSpoolMessage(match, account, nowIso(), reactions);
  };

  const builder = createRecordBuilder(account, fetchItem, authenticate);
  // The spool is the connector's live input: its records, turned into items
  // by the connector's one builder under the intake rule (core/source-inputs.ts),
  // so a record read again (a recovered cursor, a redelivery) never replaces
  // a newer version the stores hold.
  const input: SourceConnectorInput<WhatsAppRecord> = {
    inputId: CONNECTOR_ID,
    kind: 'live',
    records: (listOptions = {}) => liveRecords(spoolDir, {
      limit: normalizePositiveInteger(listOptions.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
      ...(listOptions.cursor !== undefined ? { cursor: listOptions.cursor } : {}),
      passByteBudget,
      maxRecordBytes,
      findings,
      consumer: options.consumer ?? CONNECTOR_ID,
    }),
  };
  const connector = inputConnector(builder, input);
  return {
    id: CONNECTOR_ID,
    family: 'chat',
    authenticate,
    listItems: (listOptions?: SourceConnectorListOptions) => connector.listItems(listOptions),
    fetchItem,
    classificationSignals: whatsAppClassificationSignals,
  };
}

/**
 * The classification signals of a WhatsApp item, whichever input built it.
 * Chat history has always rested at Private here; published as a prior so the
 * recorded decision is never less private than today's placement until an
 * owner chat rule replaces it.
 */
export function whatsAppClassificationSignals(item: RawItem): SourceClassificationSignals {
  return compactClassificationSignals({
    prior: trustDomainPrior('secure_local', 'source_default'),
    ...(item.metadata['secretRedacted'] === true
      ? { floor: { tier: 'secrets' as const, basis: WHATSAPP_SECRET_REDACTED_FLOOR_BASIS } }
      : {}),
    title: signalText(item.metadata, 'chat'),
    sender: signalText(item.metadata, 'sender'),
    folderKeys: item.identity.providerConversationId ? [item.identity.providerConversationId] : [],
  });
}

/**
 * The WhatsApp order of two versions of one message: the message's time. A
 * record read again carries the same time, so it is never newer than what it
 * stored.
 */
export function compareWhatsAppVersions(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return Math.sign(left - right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The one way from a WhatsApp record to its item, whichever input it came from. */
function createRecordBuilder(
  account: string,
  fetchItem: (localItemId: string) => Promise<RawItem>,
  authenticate: () => Promise<void>,
  readChild?: (locator: string, options: { maxBytes?: number }) => Uint8Array,
): SourceRecordBuilder<WhatsAppRecord> {
  return {
    family: 'chat',
    entriesOf: (record) => {
      const own = recordIdentity(record, account);
      return [
        {
          identity: own,
          // A restatement of the reactions is something to apply, as live's word at the same version.
          bringsContent: recordBringsContent(record) || record.reactions !== undefined,
          authoredAt: record.timestamp,
        },
        // A child whose bytes can be read brings content: a later record that has them fills one that had not.
        ...(record.children ?? []).map((child) => ({ identity: childIdentity(own, child), bringsContent: child.available && child.locator !== undefined })),
      ];
    },
    compareVersions: compareWhatsAppVersions,
    build: (record, wanted) => {
      const fetchedAt = nowIso();
      const items: RawItem[] = [];
      const own = rawItemFromSpoolMessage(record, account, fetchedAt, record.reactions);
      if (wanted.has(own.identity.localItemId)) items.push(own);
      for (const child of record.children ?? []) {
        const item = rawItemFromChild(record, child, account, fetchedAt);
        if (wanted.has(item.identity.localItemId)) items.push(item);
      }
      return items;
    },
    async fetchItem(localItemId, fetchOptions) {
      const locator = fetchOptions?.deferredBytes?.locator;
      if (locator === undefined || !localItemId.includes('#child:')) return fetchItem(localItemId);
      // A child an export brought is read by its locator.
      if (!readChild) throw new Error('This WhatsApp account cannot read imported media yet.');
      const bytes = readChild(locator, {});
      return {
        identity: childIdentityFromLocalId(localItemId, account),
        mimeType: 'application/octet-stream',
        content: { kind: 'bytes', mimeType: 'application/octet-stream', bytes },
        metadata: Object.freeze({}),
        fetchedAt: nowIso(),
      };
    },
    classificationSignals: whatsAppClassificationSignals,
    authenticate,
  };
}

/** What the WhatsApp record builder needs that only the account has. */
export interface WhatsAppRecordBuilderOptions {
  spoolDir: string;
  account?: string;
  /** Reads a child's bytes by its locator (archive-import/input-media.ts); absent: children cannot be read yet. */
  readChild?: (locator: string, options: { maxBytes?: number }) => Uint8Array;
}

/**
 * The WhatsApp connector's one record builder, for an input other than the
 * spool (an imported export): the same code the spool's own listing builds
 * with. A record's own item is its message; the media an export carries are
 * its children.
 */
export function createWhatsAppRecordBuilder(options: WhatsAppRecordBuilderOptions): SourceRecordBuilder<WhatsAppRecord> {
  const account = options.account === undefined ? DEFAULT_ACCOUNT : requireNonEmpty(options.account, 'WhatsApp account');
  const live = createWhatsAppLiveSourceConnector({ spoolDir: options.spoolDir, account });
  return createRecordBuilder(account, (localItemId) => live.fetchItem(localItemId), () => live.authenticate(), options.readChild);
}

/** A child's identity: `<parent providerItemId>#child:<key>`, in the parent's conversation and version (2.1.0). */
function childIdentity(parent: SourceItemIdentity, child: WhatsAppChildRecord): SourceItemIdentity {
  return {
    ...parent,
    providerItemId: `${parent.providerItemId}#child:${child.key}`,
    localItemId: `${parent.localItemId}#child:${child.key}`,
    parent: { providerItemId: parent.providerItemId, localItemId: parent.localItemId },
  };
}

function childIdentityFromLocalId(localItemId: string, account: string): SourceItemIdentity {
  const { chatJid, providerItemId } = localItemIdParts(localItemId, account);
  const parentId = providerItemId.slice(0, providerItemId.indexOf('#child:'));
  const parentLocal = localItemId.slice(0, localItemId.indexOf('#child:'));
  return {
    family: 'chat',
    provider: PROVIDER,
    accountScope: account,
    providerItemId,
    ...(chatJid ? { providerConversationId: chatJid } : {}),
    localItemId,
    parent: { providerItemId: parentId, localItemId: parentLocal },
  };
}

/** A spool line as a record, for an input that reads the live spool (the archive input's matching). */
export function parseWhatsAppSpoolRecord(line: string): WhatsAppRecord | undefined {
  return parseSpoolLine(line);
}

export { isWhatsAppReactionLine as isWhatsAppReactionRecord };

/** The conversation label of the status updates chat, as the status posts are found under it. */
export const WHATSAPP_STATUS_CHAT_LABEL = 'Status updates';

/** The message line at a place in the spool, or undefined when there is none there now. */
function readMessageAt(spoolDir: string, file: string, offset: number, budget?: SpoolReadBudget): SpoolMessage | undefined {
  // One line is wanted: read in small steps, and never past one record's bound (an over-long line pauses
  // the read, unread). What was read is spent from the pass's budget when there is one.
  const own: SpoolReadBudget = { bytesLeft: WHATSAPP_SPOOL_MAX_RECORD_BYTES + TARGET_READ_CHUNK_BYTES };
  const before = own.bytesLeft;
  try {
    for (const record of spoolRecords(join(spoolDir, file), offset, WHATSAPP_SPOOL_MAX_RECORD_BYTES, own, false, TARGET_READ_CHUNK_BYTES)) {
      return record.kind === 'line' ? parseSpoolLine(record.text) : undefined;
    }
    return undefined;
  } finally {
    if (budget) budget.bytesLeft -= before - own.bytesLeft;
  }
}

/**
 * Spool diagnostics for ingest wiring: how many lines were unreadable (and
 * skipped by listItems) so syncs can report an honest gap count instead of
 * silently dropping capture.
 */
export function readWhatsAppLiveSpoolStatus(spoolDir: string): WhatsAppLiveSpoolStatus {
  let lines = 0;
  let messages = 0;
  let malformedLines = 0;
  let newestMessageTimestamp: string | undefined;
  const files = listSpoolFiles(spoolDir);
  // The reaction index rides the scan the status already does; resolving the
  // targets costs a second pass, and only when reactions actually exist.
  const reactionIndex = createWhatsAppReactionIndexBuilder();
  for (const file of files) {
    for (const line of spoolFileLines(join(spoolDir, file))) {
      lines += 1;
      if (line.trim() === '') continue;
      const message = parseSpoolLine(line);
      if (message === undefined) {
        malformedLines += 1;
      } else {
        messages += 1;
        newestMessageTimestamp = message.timestamp;
        reactionIndex.add(message);
      }
    }
  }
  const index = reactionIndex.build();
  return {
    files: files.length,
    lines,
    messages,
    malformedLines,
    reactionLines: index.reactionLines,
    unresolvedReactionTargets: countUnresolvedReactionTargets(spoolDir, index),
    ...(newestMessageTimestamp === undefined ? {} : { newestMessageTimestamp }),
  };
}

/**
 * What the pull reads about capture on every run, bounded: the newest valid
 * message time, read back from the end of the spool (a few megabytes at
 * most, never the whole spool), and the bridge's capture status receipt.
 */
export function readWhatsAppLiveCaptureState(spoolDir: string): {
  newestMessageTimestamp?: string;
  status?: WhatsAppCaptureStatusReceipt;
} {
  const newestMessageTimestamp = newestSpoolRecord(
    spoolDir,
    listSpoolFiles(spoolDir),
    (line) => parseSpoolLine(line)?.timestamp,
  );
  const status = readWhatsAppCaptureStatus(spoolDir);
  return {
    ...(newestMessageTimestamp === undefined ? {} : { newestMessageTimestamp }),
    ...(status === undefined ? {} : { status }),
  };
}

function countUnresolvedReactionTargets(spoolDir: string, index: WhatsAppReactionIndex): number {
  if (index.targetIds.length === 0) return 0;
  const targets = resolveReactionTargets(spoolDir, new Set(index.targetIds));
  let unresolved = 0;
  for (const targetId of index.targetIds) {
    const target = targets.get(targetId);
    if (target === undefined) {
      unresolved += 1;
      continue;
    }
    if (boundedReactionsForTarget(index.entriesFor(targetId), target.chatJid) === undefined) unresolved += 1;
  }
  return unresolved;
}

// --- Spool paging -------------------------------------------------------------

interface SpoolPageReadResult {
  messages: SpoolMessage[];
  /** Reaction lines consumed by this page; they emit no items of their own. */
  reactions: SpoolMessage[];
  /** Position after the last consumed line; undefined when no spool files exist. */
  position: SpoolPosition | undefined;
  /** True when every terminated line currently on disk has been consumed. */
  exhausted: boolean;
  /** True when the page stopped because the listing's byte budget ran out. */
  budgetReached?: boolean;
  /** The reacted-to messages read for this page's reactions, by id (null: not found). */
  targets?: Map<string, SpoolMessage | null>;
}

interface SpoolPassState {
  budget: SpoolReadBudget;
  maxRecordBytes: number;
  findings: WhatsAppSpoolPassFindings;
  index: WhatsAppSpoolIndex | undefined;
  /** What the export inputs agreed with live capture: a live message an import holds already is stored as that item. */
  ledger?: WhatsAppMatchLedger | undefined;
  /** Who reads with this cursor: replays are owed to, and settled by, each reader on its own. */
  consumer: string;
  obligations: WhatsAppSpoolObligations | undefined;
  /** The index generation and replay epoch the cursors this listing hands out carry. */
  generation?: string;
  epoch?: number;
}

/**
 * The live input's records: pages of the spool from a cursor, each page its
 * messages and a restatement of every message reacted to in it, until the
 * spool or the pass's byte budget is spent.
 */
async function* liveRecords(
  spoolDir: string,
  options: { cursor?: string; limit: number; passByteBudget: number; maxRecordBytes: number; findings: WhatsAppSpoolPassFindings; consumer: string },
): AsyncGenerator<SourceRecordPage<WhatsAppRecord>> {
  let position = positionFromCursor(options.cursor);
  const index = WhatsAppSpoolIndex.open(spoolDir);
  const ledger = WhatsAppMatchLedger.open(spoolDir);
  const obligations = WhatsAppSpoolObligations.open(spoolDir);
  const pass: SpoolPassState = {
    budget: { bytesLeft: options.passByteBudget },
    maxRecordBytes: options.maxRecordBytes,
    findings: options.findings,
    index,
    consumer: options.consumer,
    obligations,
    ledger,
  };
  try {
    // The index is trusted only for the files that are there, as they are.
    // A file that broke the spool contract (replaced, cut and written again) is read again from its start, with
    // everything after it: every boundary in it (the index's, the cursor's) is dropped.
    // The reset is a durable obligation of each reader (spool-obligations.ts), written before the index forgets,
    // and settled only by that reader's own cursor coming back from after it.
    obligations?.register(options.consumer);
    const generation = index?.generation();
    if (index && generation !== undefined) {
      index.reconcile(spoolDir, (replaced) => { obligations?.oweEveryone(replaced[0]!, generation); });
      pass.generation = generation;
      if (position !== undefined && position.generation !== undefined && position.generation !== generation) {
        // Handed out by another build of the index: nothing it saw can be trusted, so its file is read again.
        pass.findings.cursorsRecovered += 1;
        position = { file: position.file, line: 0, offset: 0 };
      } else {
        const owed = obligations?.owed(options.consumer);
        if (owed !== undefined) {
          if (position !== undefined && position.generation === owed.generation && (position.epoch ?? -1) >= owed.epoch) {
            obligations!.settle(options.consumer, owed.generation, position.epoch!);
          } else if (position !== undefined && owed.file <= position.file) {
            pass.findings.cursorsRecovered += 1;
            position = { file: owed.file, line: 0, offset: 0 };
          }
        }
      }
      pass.epoch = obligations?.currentEpoch(generation) ?? 0;
    }
    position = resolveStart(spoolDir, position, pass);
    // The index catches up to where this listing starts before any page is aggregated from it.
    if (index && !catchUpIndex(spoolDir, index, position, pass)) {
      options.findings.passBudgetReached += 1;
      yield { records: [], ...(position ? { nextCursor: cursorFromPosition(position, pass.generation, pass.epoch) } : {}), done: false };
      return;
    }
    for (;;) {
      const page = readSpoolPage(spoolDir, position, options.limit, pass);
      position = page.position;
      yield {
        records: pageRecords(spoolDir, page, pass).map((record) => aliased(record, ledger)),
        ...(position === undefined ? {} : { nextCursor: cursorFromPosition(position, pass.generation, pass.epoch) }),
        done: page.exhausted,
      };
      if (page.exhausted) return;
      // The pass has read its share of the spool: it ends here, with a
      // cursor the next pass resumes from.
      if (page.budgetReached) {
        options.findings.passBudgetReached += 1;
        return;
      }
    }
  } finally {
    index?.close();
    ledger?.close();
    obligations?.close();
  }
}

/**
 * Where the cursor's place is in its file now. A cursor's file only grows, so
 * a file shorter than the cursor, or one where the cursor's offset is not the
 * start of a line, was replaced: it is read again from its start (the intake
 * rule keeps what the stores hold newer) and counted. A cursor whose file has
 * gone goes on at the next file, counted too. A cursor written before offsets
 * is resolved by counting its lines once.
 */
function resolveStart(spoolDir: string, start: SpoolPosition | undefined, pass: SpoolPassState): SpoolPosition | undefined {
  if (start === undefined) return undefined;
  const path = join(spoolDir, start.file);
  const identity = spoolFileIdentity(path);
  if (identity === undefined) {
    pass.findings.cursorFilesMissing += 1;
    return start;
  }
  const recovered = (): SpoolPosition => {
    pass.findings.cursorsRecovered += 1;
    // Owed durably to every reader before the index forgets, as reconcile owes it: a pass that fails before its
    // cursor commits reads the file again next time, even if by then the file has grown past the old cursor.
    if (pass.index && pass.generation !== undefined) {
      const epoch = pass.obligations?.oweEveryone(start.file, pass.generation);
      if (epoch !== undefined) pass.epoch = epoch;
    }
    pass.index?.forgetFile(start.file);
    return { file: start.file, line: 0, offset: 0 };
  };
  if (start.offset === undefined) {
    const offset = offsetAfterLines(path, start.line);
    return offset === undefined ? recovered() : { file: start.file, line: start.line, offset };
  }
  if (start.offset > identity.size) return recovered();
  if (start.skipping !== true && !isRecordBoundary(path, start.offset)) return recovered();
  return start;
}

/**
 * Indexes the spool from the index's high-water mark up to `until`, within
 * the pass's budget. True when the index reaches it.
 */
/**
 * Brings the spool index up to the end of the spool, within `budgetBytes`:
 * what an export input matches against (its match keys, digests only) without
 * reading the spool itself. True when the index reached the end. The listing
 * of the live input catches up the same way; whichever runs first indexes.
 */
export function catchUpWhatsAppSpoolIndex(spoolDir: string, budgetBytes: number): boolean {
  const index = WhatsAppSpoolIndex.open(spoolDir);
  if (!index) return false;
  const ledger = WhatsAppMatchLedger.open(spoolDir);
  const obligations = WhatsAppSpoolObligations.open(spoolDir);
  try {
    // A file that broke the spool contract is owed to every reader before the index forgets it, as a listing owes it.
    const generation = index.generation();
    index.reconcile(spoolDir, (replaced) => { obligations?.oweEveryone(replaced[0]!, generation); });
    const files = listSpoolFiles(spoolDir);
    const last = files.at(-1);
    if (last === undefined) return true;
    const end = spoolFileIdentity(join(spoolDir, last));
    if (!end) return false;
    const pass: SpoolPassState = {
      budget: { bytesLeft: budgetBytes },
      maxRecordBytes: WHATSAPP_SPOOL_MAX_RECORD_BYTES,
      findings: emptyWhatsAppSpoolPassFindings(),
      index,
      ledger,
      consumer: CONNECTOR_ID,
      obligations,
      generation,
    };
    // Up to the file's end as it is now (a stat, no read): a fragment being written is not a record, so indexing
    // stops at the last whole line and the high-water mark says where; the next catch-up goes on from there.
    return catchUpIndex(spoolDir, index, { file: last, line: 0, offset: end.size }, pass);
  } finally {
    index.close();
    ledger?.close();
    obligations?.close();
  }
}

function catchUpIndex(spoolDir: string, index: WhatsAppSpoolIndex, until: SpoolPosition | undefined, pass: SpoolPassState): boolean {
  if (until === undefined) return true;
  const mark = index.highWater() ?? { file: '', offset: 0 };
  const target = { file: until.file, offset: until.offset ?? 0 };
  if (comparePlaces(mark, target) >= 0) return true;
  for (const file of listSpoolFiles(spoolDir)) {
    if (file < mark.file || file > target.file) continue;
    let offset = file === mark.file ? mark.offset : 0;
    const end = file === target.file ? target.offset : Number.POSITIVE_INFINITY;
    let paused = false;
    if (!spoolFileIdentity(join(spoolDir, file))) continue;
    index.transaction(() => {
      for (const record of spoolRecords(join(spoolDir, file), offset, pass.maxRecordBytes, pass.budget)) {
        if (record.kind === 'paused') {
          // Inside an over-long record the rest of it reads as one unparsable line next time: nothing is indexed from it.
          offset = record.offset;
          paused = true;
          break;
        }
        if (offset >= end) break;
        if (record.kind === 'line') noteLine(index, record.text, { file, offset }, pass.ledger);
        offset = record.endOffset;
        if (offset >= end) break;
      }
      index.advance({ file, offset: Math.min(offset, end) });
      index.noteFile(spoolDir, file, Math.min(offset, end));
    });
    if (paused || pass.budget.bytesLeft <= 0) return comparePlaces(index.highWater() ?? mark, target) >= 0;
  }
  index.advance(target);
  return true;
}

/** Records one consumed line in the index: a message's newest line, or an actor's reaction. */
function noteLine(index: WhatsAppSpoolIndex, line: string, place: SpoolPlace, ledger?: WhatsAppMatchLedger): void {
  if (line.trim() === '') return;
  const message = parseSpoolLine(line);
  if (message === undefined) return;
  if (isWhatsAppReactionLine(message)) {
    const reaction = whatsAppReactionEntryOf(message);
    if (reaction) index.noteReaction(reaction.targetId, reaction.entry, place);
    return;
  }
  index.noteMessage(message.chatJid, message.id, place);
  // A Secret's line has no text left to match by.
  if (message.secretRedacted === true) return;
  const keys = liveMatchKeys({
    chatJid: message.chatJid,
    timestamp: message.timestamp,
    sender: message.fromMe ? OWNER_SENDER : nameKey(message.senderContactName || message.senderName || ''),
    text: message.text,
  });
  if (!keys) return;
  const firstSeen = index.noteMatchKeys({
    chatJid: message.chatJid,
    id: message.id,
    fromMe: message.fromMe,
    ...(message.mediaType !== undefined ? { mediaType: message.mediaType } : {}),
    mediaSaved: message.mediaPath !== undefined,
    keys,
    ...(isWhatsAppStatusBroadcast(message.chatJid)
      ? { chatNameKey: 'status@broadcast' }
      : message.chatName ? { chatNameKey: nameKey(message.chatName) } : {}),
  }, place);
  // The other direction: an import that ran first gave this message an id of its own, and this is the message's
  // first line (it was never stored under its own id: a stored item's id never changes, and a later line is
  // another version, which never claims anything). The live message takes that item's id only when the match
  // is certain: one live message and one imported one hold the key, and the message is not a picture or file
  // with no words (whose key says nothing of which picture it is). When in doubt, no merge.
  if (!ledger || !firstSeen || ledger.aliasOf(message.chatJid, message.id) !== undefined) return;
  if (message.mediaType !== undefined && textKeyIsEmpty(message.text)) return;
  for (const [precision, key] of [['minute', keys.exactMinute], ['second', keys.exactSecond]] as const) {
    if (index.countWithKey(precision, key) !== 1 || ledger.exportCount(precision, key) !== 1) continue;
    const imported = ledger.exportAt(precision, key, 0);
    if (imported !== undefined && !ledger.claimed(imported)) {
      ledger.alias(message.chatJid, message.id, imported);
      return;
    }
  }
}

function textKeyIsEmpty(text: string): boolean {
  return text.trim() === '';
}

/** A record of a live message an import holds already, under that item's id. */
function aliased(record: WhatsAppRecord, ledger: WhatsAppMatchLedger | undefined): WhatsAppRecord {
  const imported = ledger?.aliasOf(record.chatJid, record.id);
  return imported === undefined ? record : { ...record, id: imported };
}

function readSpoolPage(
  spoolDir: string,
  start: SpoolPosition | undefined,
  limit: number,
  pass: SpoolPassState,
): SpoolPageReadResult {
  const files = listSpoolFiles(spoolDir);
  if (files.length === 0) {
    return { messages: [], reactions: [], position: start, exhausted: true };
  }
  const messages: SpoolMessage[] = [];
  const reactions: SpoolMessage[] = [];
  const targets = new Map<string, SpoolMessage | null>();
  // A reaction re-emits its target, so the page's item count is its messages
  // plus the targets not already among them. Budgeting against that total is
  // what keeps a page from overshooting the caller's limit. Both sets are
  // keyed by chat as well as id, because a page message only cancels a
  // re-emit when it is the message from the chat the reaction happened in;
  // over-projecting only makes a page shorter.
  const reEmitTargets = new Set<string>();
  const pageMessages = new Set<string>();
  const projectedItems = (): number => messages.length + reEmitTargets.size;
  let position = start;
  const index = pass.index;
  // Where this page's reading reached in each file it read: recorded with the digest that ends there.
  const reached = new Map<string, number>();
  const finish = (result: SpoolPageReadResult): SpoolPageReadResult => {
    if (index && result.position?.offset !== undefined) {
      index.advance({ file: result.position.file, offset: result.position.offset });
      if (result.position.skipping !== true) reached.set(result.position.file, result.position.offset);
      for (const [file, offset] of reached) index.noteFile(spoolDir, file, offset);
    }
    return result;
  };
  const run = (): SpoolPageReadResult => {
    for (const file of files) {
      if (start !== undefined && file < start.file) continue;
      const fromStart = start !== undefined && file === start.file;
      let lineIndex = fromStart ? start.line : 0;
      let offset = fromStart ? start.offset ?? 0 : 0;
      const skipping = fromStart && start.skipping === true;
      position = { file, line: lineIndex, offset, ...(skipping ? { skipping: true as const } : {}) };
      for (const record of spoolRecords(join(spoolDir, file), offset, pass.maxRecordBytes, pass.budget, skipping)) {
        if (record.kind === 'paused') {
          if (record.firstSeen) pass.findings.oversizedRecords += 1;
          position = { file, line: lineIndex, offset: record.offset, ...(record.skipping ? { skipping: true as const } : {}) };
          return { messages, reactions, position, exhausted: false, budgetReached: true, targets };
        }
        if (projectedItems() >= limit) {
          return { messages, reactions, position, exhausted: false, targets };
        }
        const place = { file, offset };
        offset = record.endOffset;
        lineIndex += 1;
        position = { file, line: lineIndex, offset };
        reached.set(file, offset);
        if (record.kind === 'oversized') {
          if (!record.continued) pass.findings.oversizedRecords += 1;
          continue;
        }
        const line = record.text;
        if (line.trim() === '') continue;
        const message = parseSpoolLine(line);
        // Malformed line: skipped, cursor still advances (documented gap,
        // counted in the listing's findings).
        if (message === undefined) {
          pass.findings.malformedLines += 1;
          continue;
        }
        if (index && !index.covers(place)) noteLine(index, line, place, pass.ledger);
        if (isWhatsAppReactionLine(message)) {
          reactions.push(message);
          const targetId = message.reactionTargetId;
          if (targetId !== undefined) {
            const target = chatScopedKey(message.chatJid, targetId);
            if (!pageMessages.has(target)) reEmitTargets.add(target);
            // The reacted-to message is read now, from its one line, out of the same budget; a pass that spends
            // the budget here ends after this reaction, with nothing left to resolve.
            if (index && !pageMessages.has(target) && !targets.has(targetId)) {
              const located = index.newestMessage(targetId);
              const read = located ? readMessageAt(spoolDir, located.file, located.offset, pass.budget) : undefined;
              targets.set(targetId, read && read.id === targetId ? read : null);
              if (pass.budget.bytesLeft <= 0) return { messages, reactions, position, exhausted: false, budgetReached: true, targets };
            }
          }
          continue;
        }
        messages.push(message);
        pageMessages.add(chatScopedKey(message.chatJid, message.id));
        reEmitTargets.delete(chatScopedKey(message.chatJid, message.id));
      }
    }
    return { messages, reactions, position, exhausted: true, targets };
  };
  // The page's rows, the files' records and the high-water mark commit together, or none of them do.
  return index ? index.transaction(() => finish(run())) : run();
}

/**
 * The records one page yields: its own messages, plus a restatement of every
 * message reacted to in this page that is not already among them, each with
 * its reactions as the spool index holds them (bounded per target, read from
 * a few rows). Attaching the aggregate to a message the page already carries
 * keeps one record per message per page.
 */
function pageRecords(spoolDir: string, page: SpoolPageReadResult, pass: SpoolPassState): WhatsAppRecord[] {
  const targetIds = distinctReactionTargetIds(page.reactions);
  if (targetIds.length === 0 || !pass.index) return page.messages;
  const index = pass.index;
  const aggregates = new Map<string, { message: SpoolMessage; reactions: readonly SourceReaction[] }>();
  for (const targetId of targetIds) {
    // The newest line of the reacted-to message: this page's own, else the index's.
    const inPage = [...page.messages].reverse().find((message) => message.id === targetId);
    // Read while the page was read, out of its budget.
    const target = inPage ?? page.targets?.get(targetId) ?? undefined;
    const reactions = target && target.id === targetId
      ? boundedReactionsForTarget(index.reactionsFor(targetId), target.chatJid)
      : undefined;
    // Unresolvable target: no message with that id is in the spool, or the
    // only one that is belongs to another chat. Skipped and counted as a gap
    // in the listing's findings — never emitted content-less.
    if (!target || reactions === undefined) {
      pass.findings.unresolvedReactionTargets += 1;
      continue;
    }
    aggregates.set(targetId, { message: target, reactions });
  }
  const records: WhatsAppRecord[] = page.messages.map((message) => {
    const aggregate = aggregates.get(message.id);
    if (aggregate === undefined || !sameWhatsAppChat(aggregate.message.chatJid, message.chatJid)) return message;
    aggregates.delete(message.id);
    return { ...message, reactions: aggregate.reactions };
  });
  for (const aggregate of aggregates.values()) records.push({ ...aggregate.message, reactions: aggregate.reactions });
  return records;
}

function distinctReactionTargetIds(reactions: readonly SpoolMessage[]): string[] {
  const targetIds = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.reactionTargetId !== undefined) targetIds.add(reaction.reactionTargetId);
  }
  return [...targetIds];
}

/**
 * The last spool occurrence of each requested message id, which is the same
 * "newest version wins" rule fetchItem uses. Reaction lines are never targets
 * of their own. The diagnostic status reads it; a listing uses the index.
 */
function resolveReactionTargets(spoolDir: string, targetIds: ReadonlySet<string>): Map<string, SpoolMessage> {
  const targets = new Map<string, SpoolMessage>();
  if (targetIds.size === 0) return targets;
  for (const file of listSpoolFiles(spoolDir)) {
    for (const line of spoolFileLines(join(spoolDir, file))) {
      const message = parseSpoolLine(line);
      if (message === undefined) continue;
      if (!targetIds.has(message.id)) continue;
      if (isWhatsAppReactionLine(message)) continue;
      targets.set(message.id, message);
    }
  }
  return targets;
}

function sameWhatsAppChat(left: string, right: string): boolean {
  return normalizeWhatsAppJid(left) === normalizeWhatsAppJid(right);
}

/** A message id scoped to its chat, which is the only scope it is unique in. */
function chatScopedKey(chatJid: string, id: string): string {
  return `${normalizeWhatsAppJid(chatJid)} ${id}`;
}

function listSpoolFiles(spoolDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(spoolDir, { withFileTypes: true });
  } catch {
    throw new Error(`WhatsApp live spool directory ${spoolDir} is not readable.`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
}

function parseSpoolLine(line: string): SpoolMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const id = nonEmptyString(record['id']);
  const chatJid = nonEmptyString(record['chat_jid']);
  const timestamp = nonEmptyString(record['timestamp']);
  const fromMe = record['from_me'];
  const text = record['text'];
  if (id === undefined || chatJid === undefined || timestamp === undefined) return undefined;
  if (typeof fromMe !== 'boolean' || typeof text !== 'string') return undefined;
  const mediaType = nonEmptyString(record['media_type']);
  const mediaPath = nonEmptyString(record['media_path']);
  const mediaMime = nonEmptyString(record['media_mime']);
  const downloadStatus = nonEmptyString(record['download_status']);
  const mediaKey = nonEmptyString(record['media_key']);
  const mediaDirectPath = nonEmptyString(record['media_direct_path']);
  const mediaFileSha256 = nonEmptyString(record['media_file_sha256']);
  const mediaFileEncSha256 = nonEmptyString(record['media_file_enc_sha256']);
  const mediaDurationSeconds = optionalNumber(record['media_duration_seconds']);
  const mediaSizeBytes = optionalNumber(record['media_size_bytes']);
  const mediaKeyTimestamp = optionalNumber(record['media_key_timestamp']);
  const mentions = optionalStringRecord(record['mentions']);
  const previewTitle = nonEmptyString(record['preview_title']);
  const previewDescription = nonEmptyString(record['preview_description']);
  const previewUrl = nonEmptyString(record['preview_url']);
  // Reaction fields, all optional: lines spooled by an older daemon carry
  // media_type "reaction" and nothing else, and stay readable.
  // reaction_sender_timestamp_ms is deliberately not read — aggregation is
  // resolved by spool order, so a provider clock must not be able to reorder
  // what the spool already recorded.
  const reactionTargetId = nonEmptyString(record['reaction_target_id']);
  const reactionTargetChatJid = nonEmptyString(record['reaction_target_chat_jid']);
  const reactionKey = nonEmptyString(record['reaction_key']);
  const reactionRemoved = record['reaction_removed'];
  const secretRedacted = record['secret_redacted'] === true;
  return {
    id,
    chatJid,
    chatName: optionalString(record['chat_name']),
    senderJid: optionalString(record['sender_jid']),
    senderName: optionalString(record['sender_name']),
    ...(nonEmptyString(record['sender_contact_name']) === undefined
      ? {}
      : { senderContactName: nonEmptyString(record['sender_contact_name'])! }),
    fromMe,
    timestamp,
    text,
    ...(mentions === undefined ? {} : { mentions }),
    ...(previewTitle === undefined ? {} : { previewTitle }),
    ...(previewDescription === undefined ? {} : { previewDescription }),
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(mediaPath === undefined ? {} : { mediaPath }),
    ...(mediaMime === undefined ? {} : { mediaMime }),
    ...(mediaDurationSeconds === undefined ? {} : { mediaDurationSeconds }),
    ...(mediaSizeBytes === undefined ? {} : { mediaSizeBytes }),
    ...(downloadStatus === undefined ? {} : { downloadStatus }),
    ...(mediaKey === undefined ? {} : { mediaKey }),
    ...(mediaDirectPath === undefined ? {} : { mediaDirectPath }),
    ...(mediaFileSha256 === undefined ? {} : { mediaFileSha256 }),
    ...(mediaFileEncSha256 === undefined ? {} : { mediaFileEncSha256 }),
    ...(mediaKeyTimestamp === undefined ? {} : { mediaKeyTimestamp }),
    ...(reactionTargetId === undefined ? {} : { reactionTargetId }),
    ...(reactionTargetChatJid === undefined ? {} : { reactionTargetChatJid }),
    ...(reactionKey === undefined ? {} : { reactionKey }),
    ...(typeof reactionRemoved !== 'boolean' ? {} : { reactionRemoved }),
    ...(secretRedacted ? { secretRedacted } : {}),
  };
}

// --- Cursors -------------------------------------------------------------------

/**
 * A spool cursor: `<file>:<lines>@<offset>`, with `s` after the offset when
 * the place is inside an over-long record being skipped. The byte offset is
 * where reading resumes; the line count is what the spool's other readers
 * (clearing Secrets) count by. `<file>:<lines>` alone is a cursor written
 * before offsets, still read.
 */
const CURSOR = /^(.+):(\d+)@(\d+)(s?)(?:~r([0-9a-f]+)\.(\d+))?$/u;
const LEGACY_CURSOR = /^(.+):(\d+)$/u;

function cursorFromPosition(position: SpoolPosition, generation = position.generation, epoch = position.epoch): string {
  if (position.offset === undefined) return `${position.file}:${position.line}`;
  const replay = generation !== undefined && epoch !== undefined ? `~r${generation}.${epoch}` : '';
  return `${position.file}:${position.line}@${position.offset}${position.skipping ? 's' : ''}${replay}`;
}

function positionFromCursor(cursor: string | undefined): SpoolPosition | undefined {
  const text = cursor?.trim();
  if (text === undefined || text === '') return undefined;
  const found = CURSOR.exec(text);
  if (found) {
    return {
      file: found[1]!,
      line: Number(found[2]),
      offset: Number(found[3]),
      ...(found[4] === 's' ? { skipping: true as const } : {}),
      ...(found[5] !== undefined && found[6] !== undefined ? { generation: found[5], epoch: Number(found[6]) } : {}),
    };
  }
  const legacy = LEGACY_CURSOR.exec(text);
  if (legacy) return { file: legacy[1]!, line: Number(legacy[2]) };
  throw new Error('WhatsApp live spool cursors look like <fileName>:<lineCount>.');
}

/** Whether a cursor is one this spool's listing hands out (either form). */
export function isWhatsAppSpoolCursor(cursor: string): boolean {
  return CURSOR.test(cursor) || LEGACY_CURSOR.test(cursor);
}

/** The cursor as `<file>:<lines>`, the form the spool's Secrets clearing counts by. */
export function whatsAppSpoolLineCursor(cursor: string): string | undefined {
  const found = CURSOR.exec(cursor) ?? LEGACY_CURSOR.exec(cursor);
  return found ? `${found[1]}:${found[2]}` : undefined;
}

// --- RawItem mapping ------------------------------------------------------------

/** The item a record is, before anything is read or built: what the intake rule is asked about. */
function recordIdentity(message: SpoolMessage, account: string): SourceItemIdentity {
  return {
    family: 'chat',
    provider: PROVIDER,
    accountScope: account,
    providerItemId: message.id,
    providerConversationId: message.chatJid,
    localItemId: `${account}:${normalizeWhatsAppJid(message.chatJid)}:${message.id}`,
    sourceVersion: message.timestamp,
  };
}

/** Whether a record carries its item's content, not only its names. */
function recordBringsContent(message: SpoolMessage): boolean {
  if (message.secretRedacted === true) return false;
  return !(message.mediaType !== undefined && message.text === '');
}

function rawItemFromSpoolMessage(
  message: SpoolMessage,
  account: string,
  fetchedAt: string,
  reactions?: readonly SourceReaction[],
): RawItem {
  const identity = recordIdentity(message, account);
  // A captioned photo, video or document is read by its caption: that is
  // what was said. The media itself stays described by its metadata.
  const isMedia = message.mediaType !== undefined && message.text === '';
  const redacted = message.secretRedacted === true;
  const text = spoolMessageText(message);
  const hasPreviewEnrichment = text !== resolveMentionText(message.text, message.mentions);
  const status = isWhatsAppStatusBroadcast(message.chatJid);
  const senderName = message.senderContactName || message.senderName;
  return {
    identity,
    mimeType: isMedia ? (message.mediaMime ?? 'application/octet-stream') : TEXT_MIME_TYPE,
    content: isMedia || redacted ? { kind: 'metadata_only' } : { kind: 'text', text },
    metadata: Object.freeze({
      chat: status ? WHATSAPP_STATUS_CHAT_LABEL : message.chatName || message.chatJid,
      sender: senderName || message.senderJid,
      senderId: message.senderJid || undefined,
      senderLabel: senderName || message.senderJid || undefined,
      senderIsOwner: message.fromMe,
      fromMe: message.fromMe,
      sentAt: message.timestamp,
      ...(status ? { recordKind: 'status' } : {}),
      // Absent means "this emit says nothing about reactions" and preserves
      // what is stored; an empty array is how a message whose reactions were
      // all taken back clears them.
      ...(reactions === undefined ? {} : { reactions }),
      ...(hasPreviewEnrichment && !redacted ? { searchText: text } : {}),
      ...(redacted ? { secretRedacted: true } : {}),
      ...(message.mentions === undefined ? {} : { mentions: message.mentions }),
      ...(message.mediaType === undefined ? {} : { mediaType: message.mediaType }),
      ...mediaMetadata(message),
    }),
    fetchedAt,
  };
}

function rawItemFromChild(message: SpoolMessage, child: WhatsAppChildRecord, account: string, fetchedAt: string): RawItem {
  const parent = recordIdentity(message, account);
  const status = isWhatsAppStatusBroadcast(message.chatJid);
  const senderName = message.senderContactName || message.senderName;
  return {
    identity: childIdentity(parent, child),
    mimeType: child.mimeType,
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      name: child.name,
      title: child.name,
      chat: status ? WHATSAPP_STATUS_CHAT_LABEL : message.chatName || message.chatJid,
      sender: senderName || message.senderJid,
      senderLabel: senderName || message.senderJid || undefined,
      senderIsOwner: message.fromMe,
      fromMe: message.fromMe,
      sentAt: message.timestamp,
      ...(message.mediaType === undefined ? {} : { mediaType: message.mediaType }),
    }),
    fetchedAt,
    deferredBytes: {
      locator: child.locator ?? '',
      available: child.available && child.locator !== undefined,
      ...(child.sizeBytes !== undefined ? { sizeBytes: child.sizeBytes } : {}),
    },
  };
}

/**
 * A message's readable text: its body with mentions resolved, plus its link
 * preview. What a text item is indexed by, and what a spool line is judged by.
 */
function spoolMessageText(message: SpoolMessage): string {
  return enrichWithLinkPreview(resolveMentionText(message.text, message.mentions), message);
}

/**
 * Rewrite, in place, every message line in `[from, through)` whose item the
 * judge says is Secrets: its text, link preview, mentions, media path and
 * media re-download keys go (and the chat and sender names when the names
 * themselves were judged Secrets, also from a line whose text went earlier),
 * and the audio it saved under `mediaDir` is deleted. Its id, chat, time and
 * media type stay, and it is flagged so a replay judges it Secrets again.
 * Reaction lines name another message and are left alone. Cursors are this
 * spool's `<file>:<lines>`.
 */
export function redactWhatsAppLiveSpoolSecrets(options: {
  spoolDir: string;
  account?: string;
  from?: string;
  through?: string;
  judge: SpoolSecretJudge;
  /** Where the bridge saves audio; a media path outside it is never deleted. */
  mediaDir?: string;
  /**
   * Maps a media path a line names at the account's old state folder to the
   * same file in its account folder, for an account the boot migration moved
   * (core/source-placement.ts, `whatsappMovedPathMapper`). The line keeps its path.
   */
  relocateMediaPath?: (path: string) => string;
}): CaptureSpoolRedactionResult {
  const account = options.account === undefined ? DEFAULT_ACCOUNT : requireNonEmpty(options.account, 'WhatsApp account');
  const from = positionFromCursor(options.from);
  const through = positionFromCursor(options.through);
  const mediaRoot = options.mediaDir ? existingRealPath(options.mediaDir) : undefined;
  const relocate = options.relocateMediaPath ?? ((path: string): string => path);
  let owners: Map<string, Set<string>> | undefined;
  // Saved audio is deleted only when this message is the only one that names
  // it: the bridge names a file by message id alone, and an id is unique only
  // within its chat.
  const deleteOwnedMedia = (message: SpoolMessage): void => {
    if (!message.mediaPath || !mediaRoot) return;
    owners ??= mediaPathOwners(options.spoolDir, relocate);
    // Keyed by the file itself, so a symlink and its target are one file.
    const real = existingRealPath(relocate(message.mediaPath));
    if (!real) return;
    const self = chatScopedKey(message.chatJid, message.id);
    if ([...(owners.get(real) ?? [])].some((owner) => owner !== self)) return;
    deleteSavedMedia(real, mediaRoot);
  };
  // A line that gives up its path no longer holds the file, so the last
  // Secret line to name a shared file is the one that deletes it.
  const releaseMedia = (message: SpoolMessage): void => {
    if (!message.mediaPath || !owners) return;
    const real = existingRealPath(relocate(message.mediaPath));
    if (real) owners.get(real)?.delete(chatScopedKey(message.chatJid, message.id));
  };
  // A live message an import holds already is judged under that item's id.
  const ledger = WhatsAppMatchLedger.open(options.spoolDir);
  try {
  return redactCaptureSpoolLines({
    dir: options.spoolDir,
    files: listSpoolFiles(options.spoolDir),
    ...(from ? { from } : {}),
    ...(through ? { through } : {}),
    redact: (line) => {
      const message = parseSpoolLine(line);
      if (message === undefined) return undefined;
      if (isWhatsAppReactionLine(message)) return undefined;
      const identity = {
        provider: PROVIDER,
        accountScope: account,
        providerItemId: ledger?.aliasOf(message.chatJid, message.id) ?? message.id,
        providerConversationId: message.chatJid,
      };
      const alreadyRedacted = message.secretRedacted === true;
      const text = alreadyRedacted || (message.mediaType !== undefined && message.text === '')
        ? undefined
        : spoolMessageText(message);
      const redaction = options.judge(identity, text);
      if (!redaction) return undefined;
      // Deleted before the line loses its path; a failure here fails the
      // window, which the next pull clears again.
      deleteOwnedMedia(message);
      const namesLeft = message.chatName !== '' || message.senderName !== '' || (message.senderContactName ?? '') !== '';
      if (alreadyRedacted && (redaction !== 'names' || !namesLeft)) return undefined;
      const record = JSON.parse(line) as Record<string, unknown>;
      // Mentions are display names copied into the text, so they go with it.
      // The media hashes and key time only serve a re-download, which a
      // Secret message must never get. The media path goes too: the audio was
      // deleted above, or is kept only for the other messages that name it,
      // and a replay of this line must never read it again. Together they
      // make room for the flag on a voice note whose audio was its only
      // content.
      const removable = [
        'preview_title', 'preview_description', 'preview_url', 'mentions', 'media_path',
        'media_key', 'media_direct_path', 'media_file_sha256', 'media_file_enc_sha256', 'media_key_timestamp',
      ].filter((key) => key in record);
      // A line with nothing at all to remove is not rewritten: the flag alone
      // would not fit, and blanking it would lose the record for nothing.
      if (message.text === '' && removable.length === 0 && (redaction !== 'names' || !namesLeft)) return undefined;
      record['text'] = '';
      for (const key of removable) delete record[key];
      if (redaction === 'names') {
        record['chat_name'] = '';
        record['sender_name'] = '';
        if ('sender_contact_name' in record) record['sender_contact_name'] = '';
      }
      record['secret_redacted'] = true;
      releaseMedia(message);
      return JSON.stringify(record);
    },
  });
  } finally {
    ledger?.close();
  }
}

/**
 * Every saved media file the spool names (by its real path), and the
 * messages (chat-scoped) that name it.
 */
function mediaPathOwners(spoolDir: string, relocate: (path: string) => string): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const file of listSpoolFiles(spoolDir)) {
    for (const line of spoolFileLines(join(spoolDir, file))) {
      const message = parseSpoolLine(line);
      if (message?.mediaPath === undefined) continue;
      const path = existingRealPath(relocate(message.mediaPath));
      if (path === undefined) continue;
      const named = owners.get(path) ?? new Set<string>();
      named.add(chatScopedKey(message.chatJid, message.id));
      owners.set(path, named);
    }
  }
  return owners;
}

function existingRealPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Delete a saved media file, only when it really lives under the bridge's
 * media directory: a spool line is data, and must never be able to name some
 * other file for deletion.
 */
function deleteSavedMedia(mediaPath: string | undefined, mediaRoot: string | undefined): void {
  if (!mediaPath || !mediaRoot) return;
  const real = existingRealPath(mediaPath);
  if (!real) return;
  const inside = relative(mediaRoot, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return;
  if (!statSync(real).isFile()) return;
  rmSync(real, { force: true });
}

function enrichWithLinkPreview(text: string, message: SpoolMessage): string {
  const lines: string[] = [];
  if (message.previewTitle !== undefined) {
    lines.push(`Link preview: ${message.previewTitle}`);
  }
  if (message.previewDescription !== undefined) {
    lines.push(`Description: ${message.previewDescription}`);
  }
  if (message.previewUrl !== undefined && !text.includes(message.previewUrl)) {
    lines.push(`Preview URL: ${message.previewUrl}`);
  }
  return lines.length === 0 ? text : `${text}\n${lines.join('\n')}`;
}

function resolveMentionText(text: string, mentions: Record<string, string> | undefined): string {
  if (mentions === undefined || text === '') return text;
  let resolved = text;
  for (const [rawToken, displayName] of Object.entries(mentions)) {
    resolved = resolved.replaceAll(`@${rawToken}`, `@${displayName}`);
  }
  return resolved;
}

function mediaMetadata(message: SpoolMessage): Record<string, unknown> {
  return {
    ...(message.mediaPath === undefined ? {} : { mediaPath: message.mediaPath }),
    ...(message.mediaPath === undefined ? {} : { locatorUri: message.mediaPath }),
    ...(message.mediaMime === undefined ? {} : { mediaMime: message.mediaMime }),
    ...(message.mediaDurationSeconds === undefined ? {} : { mediaDurationSeconds: message.mediaDurationSeconds }),
    ...(message.mediaSizeBytes === undefined ? {} : { mediaSizeBytes: message.mediaSizeBytes }),
    ...(message.downloadStatus === undefined ? {} : { downloadStatus: message.downloadStatus }),
    ...(message.mediaKey === undefined ? {} : { mediaKey: message.mediaKey }),
    ...(message.mediaDirectPath === undefined ? {} : { mediaDirectPath: message.mediaDirectPath }),
    ...(message.mediaFileSha256 === undefined ? {} : { mediaFileSha256: message.mediaFileSha256 }),
    ...(message.mediaFileEncSha256 === undefined ? {} : { mediaFileEncSha256: message.mediaFileEncSha256 }),
    ...(message.mediaKeyTimestamp === undefined ? {} : { mediaKeyTimestamp: message.mediaKeyTimestamp }),
  };
}

/**
 * Splits "<account>:<chat jid>:<provider item id>" into its parts. Ids written
 * before the chat was part of the identity have no chat segment and resolve
 * across chats, exactly as they did when they were stored.
 */
function localItemIdParts(
  localItemId: string,
  account: string,
): { chatJid?: string; providerItemId: string } {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length <= prefix.length) {
    throw new Error(`WhatsApp live connector local item ids look like ${prefix}<chat jid>:<provider item id>.`);
  }
  const rest = localItemId.slice(prefix.length);
  // Message ids may contain ':', so the chat is the FIRST segment and only
  // when it looks like a JID; a bare legacy id never does.
  const separator = rest.indexOf(':');
  const head = separator === -1 ? '' : rest.slice(0, separator);
  if (separator > 0 && head.includes('@') && rest.length > separator + 1) {
    return { chatJid: head, providerItemId: rest.slice(separator + 1) };
  }
  return { providerItemId: rest };
}

// --- Small shared helpers ---------------------------------------------------------

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isWhatsAppStatusBroadcast(chatJid: string): boolean {
  return chatJid.trim().toLowerCase() === 'status@broadcast';
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), maximum);
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, entryValue] of Object.entries(value)) {
    if (key.trim() === '' || typeof entryValue !== 'string' || entryValue.trim() === '') continue;
    entries.push([key, entryValue]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function nowIso(): string {
  return new Date().toISOString();
}
