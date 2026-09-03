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
//   new files are both picked up. If the cursor's file has vanished, listing
//   resumes at the next file by name.
// - Only lines terminated by '\n' are consumed. A final unterminated
//   fragment is treated as a write in progress and left for a later page.
// - Malformed lines (broken JSON, missing/mistyped required fields) are
//   SKIPPED — they still advance the cursor so capture never wedges — and
//   surfaced as a count through readWhatsAppLiveSpoolStatus(), which ingest
//   wiring can log as a gap. They are not silently invisible.
// - WhatsApp Status broadcasts (status@broadcast) are SKIPPED: they are not
//   conversations and should not enter secure chat evidence.
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import type { SourceReaction } from '../../core/source-index/reactions.ts';
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
  type WhatsAppReactionIndex,
} from './reaction-index.ts';

export const WHATSAPP_LIVE_CONNECTOR_ID = 'whatsapp-live';
const CONNECTOR_ID = WHATSAPP_LIVE_CONNECTOR_ID;
const PROVIDER = 'whatsapp';
const TEXT_MIME_TYPE = 'text/plain';
const DEFAULT_ACCOUNT = 'personal';
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2_000;
export const WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND = 'whisper_transcription';
export const WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION = '2026-07-05-whatsapp-local-asr';

export interface WhatsAppLiveSourceConnectorOptions {
  spoolDir: string;
  /** Account scope for identities; defaults to "personal". */
  account?: string;
}

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
}

interface SpoolPosition {
  file: string;
  line: number;
}

export function createWhatsAppLiveSourceConnector(
  options: WhatsAppLiveSourceConnectorOptions,
): SourceConnector {
  const spoolDir = requireNonEmpty(options.spoolDir, 'WhatsApp live connector spoolDir');
  const account = options.account === undefined ? DEFAULT_ACCOUNT : requireNonEmpty(options.account, 'WhatsApp live connector account');

  return {
    id: CONNECTOR_ID,
    family: 'chat',

    async authenticate(): Promise<void> {
      if (!existsSync(spoolDir) || !statSync(spoolDir).isDirectory()) {
        throw new Error(
          `WhatsApp live spool directory ${spoolDir} does not exist. `
          + 'Start the olympus-whatsapp-bridge daemon (tools/whatsapp-bridge) first.',
        );
      }
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePositiveInteger(listOptions?.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
      const initialCursor = listOptions?.cursor;
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        let position = positionFromCursor(initialCursor);
        const reactionSnapshot = createReactionSnapshotReader(spoolDir);
        for (;;) {
          const page = readSpoolPage(spoolDir, position, limit);
          position = page.position;
          const fetchedAt = nowIso();
          yield {
            items: pageItems(page, account, fetchedAt, reactionSnapshot),
            ...(position === undefined ? {} : { nextCursor: cursorFromPosition(position) }),
            done: page.exhausted,
          };
          if (page.exhausted) return;
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const { chatJid, providerItemId } = localItemIdParts(localItemId, account);
      let match: SpoolMessage | undefined;
      // A re-fetch is a full restatement of the item, so it must carry the
      // reactions too: the store overwrites everything an emit repeats, and a
      // fetch that stayed silent about reactions would strand a reacted media
      // message on whatever aggregate happened to be stored. Both halves ride
      // the one scan this already does — the store calls fetchItem once per
      // media message, so a second pass here would cost a spool scan each.
      const reactionIndex = createWhatsAppReactionIndexBuilder();
      for (const file of listSpoolFiles(spoolDir)) {
        for (const line of terminatedLines(join(spoolDir, file))) {
          const message = parseSpoolLine(line);
          if (message === undefined || isWhatsAppStatusBroadcast(message.chatJid)) continue;
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
    },

    classify(_item: RawItem): SourceSensitivity {
      // Private chat history is ALWAYS S4/secure_local: local-only storage,
      // never eligible for cloud embeddings. No content signal may downgrade.
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
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
    for (const line of terminatedLines(join(spoolDir, file))) {
      lines += 1;
      if (line.trim() === '') continue;
      const message = parseSpoolLine(line);
      if (message === undefined) {
        malformedLines += 1;
      } else {
        messages += 1;
        newestMessageTimestamp = message.timestamp;
        if (!isWhatsAppStatusBroadcast(message.chatJid)) reactionIndex.add(message);
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
}

function readSpoolPage(
  spoolDir: string,
  start: SpoolPosition | undefined,
  limit: number,
): SpoolPageReadResult {
  const files = listSpoolFiles(spoolDir);
  if (files.length === 0) {
    return { messages: [], reactions: [], position: start, exhausted: true };
  }

  const messages: SpoolMessage[] = [];
  const reactions: SpoolMessage[] = [];
  // A reaction re-emits its target, so the page's item count is its messages
  // plus the targets not already among them. Budgeting against that total is
  // what keeps a page from overshooting the caller's limit — a page longer
  // than maxItems is abandoned mid-page by the store, which would leave the
  // cursor pinned and replay the same page forever. Both sets are keyed by
  // chat as well as id, because a page message only cancels a re-emit when it
  // is the message from the chat the reaction happened in; over-projecting
  // only makes a page shorter, under-projecting is what overshoots.
  const reEmitTargets = new Set<string>();
  const pageMessages = new Set<string>();
  const projectedItems = (): number => messages.length + reEmitTargets.size;
  let position = start;
  for (const file of files) {
    if (start !== undefined && file < start.file) continue;
    const lines = terminatedLines(join(spoolDir, file));
    // A cursor pointing past the current end of its file means everything
    // present is consumed; later appends to that file resume from here.
    let lineIndex = start !== undefined && file === start.file ? Math.min(start.line, lines.length) : 0;
    while (lineIndex < lines.length) {
      if (projectedItems() >= limit) {
        return { messages, reactions, position, exhausted: false };
      }
      const line = lines[lineIndex];
      lineIndex += 1;
      position = { file, line: lineIndex };
      if (line === undefined || line.trim() === '') continue;
      const message = parseSpoolLine(line);
      // Malformed line: skipped, cursor still advances (documented gap; see
      // readWhatsAppLiveSpoolStatus for the surfaced count).
      if (message === undefined) continue;
      if (isWhatsAppStatusBroadcast(message.chatJid)) continue;
      if (isWhatsAppReactionLine(message)) {
        reactions.push(message);
        const targetId = message.reactionTargetId;
        if (targetId !== undefined) {
          const target = chatScopedKey(message.chatJid, targetId);
          if (!pageMessages.has(target)) reEmitTargets.add(target);
        }
        continue;
      }
      messages.push(message);
      pageMessages.add(chatScopedKey(message.chatJid, message.id));
      reEmitTargets.delete(chatScopedKey(message.chatJid, message.id));
    }
    // Fully scanned this file; record the resume point even if it had no
    // consumable lines.
    position = { file, line: lines.length };
  }
  return { messages, reactions, position, exhausted: true };
}

/**
 * The items one page emits: its own messages, plus a re-emit of every message
 * reacted to in this page that is not already among them.
 *
 * Reaction aggregates are computed over the WHOLE spool, not over this page,
 * which is what makes the result identical under any rescan. Attaching the
 * aggregate to a message the page already carries (rather than appending a
 * second copy of it) keeps one item per message per page, so an id never
 * appears twice in one batch.
 */
function pageItems(
  page: SpoolPageReadResult,
  account: string,
  fetchedAt: string,
  readSnapshot: () => WhatsAppReactionSnapshot,
): RawItem[] {
  const targetIds = distinctReactionTargetIds(page.reactions);
  if (targetIds.length === 0) {
    return page.messages.map((message) => rawItemFromSpoolMessage(message, account, fetchedAt));
  }

  const snapshot = readSnapshot();
  const aggregates = new Map<string, { message: SpoolMessage; reactions: readonly SourceReaction[] }>();
  for (const targetId of targetIds) {
    const target = snapshot.targets.get(targetId);
    // Unresolvable target: no message with that id is in the spool, or the
    // only one that is belongs to another chat. Skipped and counted as a gap
    // (readWhatsAppLiveSpoolStatus) — never emitted content-less.
    if (target === undefined) continue;
    const reactions = boundedReactionsForTarget(snapshot.index.entriesFor(targetId), target.chatJid);
    if (reactions === undefined) continue;
    aggregates.set(targetId, { message: target, reactions });
  }

  const items = page.messages.map((message) => {
    const aggregate = aggregates.get(message.id);
    if (aggregate === undefined || !sameWhatsAppChat(aggregate.message.chatJid, message.chatJid)) {
      return rawItemFromSpoolMessage(message, account, fetchedAt);
    }
    aggregates.delete(message.id);
    return rawItemFromSpoolMessage(message, account, fetchedAt, aggregate.reactions);
  });
  for (const aggregate of aggregates.values()) {
    items.push(rawItemFromSpoolMessage(aggregate.message, account, fetchedAt, aggregate.reactions));
  }
  return items;
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
 * of their own.
 */
function resolveReactionTargets(spoolDir: string, targetIds: ReadonlySet<string>): Map<string, SpoolMessage> {
  const targets = new Map<string, SpoolMessage>();
  if (targetIds.size === 0) return targets;
  for (const file of listSpoolFiles(spoolDir)) {
    for (const line of terminatedLines(join(spoolDir, file))) {
      const message = parseSpoolLine(line);
      if (message === undefined) continue;
      if (!targetIds.has(message.id)) continue;
      if (isWhatsAppReactionLine(message)) continue;
      if (isWhatsAppStatusBroadcast(message.chatJid)) continue;
      targets.set(message.id, message);
    }
  }
  return targets;
}

/** Every reaction in the spool, and the message each one was aimed at. */
interface WhatsAppReactionSnapshot {
  index: WhatsAppReactionIndex;
  targets: ReadonlyMap<string, SpoolMessage>;
}

/**
 * Reads the reaction snapshot at most once per unchanged spool. A listing
 * whose pages carry no reaction never builds it at all, and a full rescan
 * (the foreign-cursor path) builds it once for the whole run instead of once
 * per page — which is the difference between a linear pass over the spool and
 * a quadratic one.
 */
function createReactionSnapshotReader(spoolDir: string): () => WhatsAppReactionSnapshot {
  let fingerprint: string | undefined;
  let snapshot: WhatsAppReactionSnapshot | undefined;
  return (): WhatsAppReactionSnapshot => {
    const current = spoolFingerprint(spoolDir);
    if (snapshot === undefined || current !== fingerprint) {
      snapshot = buildReactionSnapshot(spoolDir);
      fingerprint = current;
    }
    return snapshot;
  };
}

function buildReactionSnapshot(spoolDir: string): WhatsAppReactionSnapshot {
  const builder = createWhatsAppReactionIndexBuilder();
  for (const file of listSpoolFiles(spoolDir)) {
    for (const line of terminatedLines(join(spoolDir, file))) {
      const message = parseSpoolLine(line);
      if (message === undefined) continue;
      if (isWhatsAppStatusBroadcast(message.chatJid)) continue;
      builder.add(message);
    }
  }
  const index = builder.build();
  // Resolving targets needs the id set the first pass produced, so it is a
  // second pass — but only when the spool holds reactions at all, and only
  // for the handful of messages that were reacted to.
  return { index, targets: resolveReactionTargets(spoolDir, new Set(index.targetIds)) };
}

function spoolFingerprint(spoolDir: string): string {
  return listSpoolFiles(spoolDir)
    .map((file) => {
      try {
        const stats = statSync(join(spoolDir, file));
        return `${file}:${stats.size}:${stats.mtimeMs}`;
      } catch {
        return `${file}:gone`;
      }
    })
    .join('|');
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

/**
 * Lines terminated by '\n'. A trailing fragment without a newline is a write
 * in progress (the daemon appends line+'\n' atomically, but reads can race)
 * and is left for a later page.
 */
function terminatedLines(filePath: string): string[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    // The file vanished between readdir and read (rotation/cleanup): treat as
    // empty; the cursor logic resumes at the next file.
    return [];
  }
  const parts = text.split('\n');
  parts.pop(); // either '' (trailing newline) or an unterminated fragment
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
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
  return {
    id,
    chatJid,
    chatName: optionalString(record['chat_name']),
    senderJid: optionalString(record['sender_jid']),
    senderName: optionalString(record['sender_name']),
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
  };
}

// --- Cursors -------------------------------------------------------------------

function cursorFromPosition(position: SpoolPosition): string {
  return `${position.file}:${position.line}`;
}

function positionFromCursor(cursor: string | undefined): SpoolPosition | undefined {
  const text = cursor?.trim();
  if (text === undefined || text === '') return undefined;
  const separator = text.lastIndexOf(':');
  const file = separator > 0 ? text.slice(0, separator) : '';
  const line = separator > 0 ? text.slice(separator + 1) : '';
  if (!file || !/^\d+$/.test(line)) {
    throw new Error('WhatsApp live spool cursors look like <fileName>:<lineCount>.');
  }
  return { file, line: Number(line) };
}

// --- RawItem mapping ------------------------------------------------------------

function rawItemFromSpoolMessage(
  message: SpoolMessage,
  account: string,
  fetchedAt: string,
  reactions?: readonly SourceReaction[],
): RawItem {
  const identity: SourceItemIdentity = {
    family: 'chat',
    provider: PROVIDER,
    accountScope: account,
    providerItemId: message.id,
    providerConversationId: message.chatJid,
    localItemId: `${account}:${normalizeWhatsAppJid(message.chatJid)}:${message.id}`,
    sourceVersion: message.timestamp,
  };
  const isMedia = message.mediaType !== undefined;
  const text = resolveMentionText(message.text, message.mentions);
  const enrichedText = enrichWithLinkPreview(text, message);
  const hasPreviewEnrichment = enrichedText !== text;
  return {
    identity,
    mimeType: isMedia ? (message.mediaMime ?? 'application/octet-stream') : TEXT_MIME_TYPE,
    content: isMedia ? { kind: 'metadata_only' } : { kind: 'text', text: enrichedText },
    metadata: Object.freeze({
      chat: message.chatName || message.chatJid,
      sender: message.senderName || message.senderJid,
      senderId: message.senderJid || undefined,
      senderLabel: message.senderName || message.senderJid || undefined,
      senderIsOwner: message.fromMe,
      fromMe: message.fromMe,
      sentAt: message.timestamp,
      // Absent means "this emit says nothing about reactions" and preserves
      // what is stored; an empty array is how a message whose reactions were
      // all taken back clears them.
      ...(reactions === undefined ? {} : { reactions }),
      ...(hasPreviewEnrichment ? { searchText: enrichedText } : {}),
      ...(message.mentions === undefined ? {} : { mentions: message.mentions }),
      ...(message.mediaType === undefined ? {} : { mediaType: message.mediaType }),
      ...mediaMetadata(message),
    }),
    fetchedAt,
  };
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
