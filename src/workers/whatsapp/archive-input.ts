// A WhatsApp chat export as an input of the WhatsApp connector
// (docs/design/archive-live-one-dataset.md, sections 1, 4, 5 and 7).
//
// The export is read by the export reader (archive-import/whatsapp), with its
// streaming, its bounds, its resume points and its findings. This input turns
// each message it reads into the bridge's own record shape, so the WhatsApp
// connector builds it exactly as it builds a live message
// (live-connector.ts, createWhatsAppRecordBuilder), into the account's stores.
//
// - Matching (match-keys.ts), on this side only and strictly: a message's key
//   is its chat, its time slot (after the zone is applied), its sender and
//   its text or caption without media markers. An export message is a live
//   message already stored only when its time slot is certain (read whole,
//   past a page's end too, and holding at most SLOT_CAP messages), exactly
//   one export message in it has the key, and exactly one live message ever
//   had the key, in any version, as its current one (the spool index's
//   digests, caught up to the spool's end first: an index still catching up
//   proves nothing, so the import waits for it). Media without words is
//   never matched. Anything else is its own item, with an id from what it is
//   (exportMessageId: content and file names, never its place in the
//   export), so a second, fuller or shorter export gives it the same id. A
//   live message always keeps its own id: one delivered after an import
//   brought it is a second item, a visible duplicate (design section 4).
// - Time zone (export-zone.ts): chosen once, on the first pass, from the
//   export's messages in the window live capture covers (its first and last
//   message, a day either side): this computer's zone first, then any zone
//   whose offsets on the sample's days differ, keeping the one under which
//   most keys match. With no overlap or no match, this computer's zone, said
//   as assumed.
// - The owner: the export shows the owner by name. The name under which the
//   sample's messages match live capture's own messages most is taken as the
//   owner's; no match leaves every sender as written.
// - Chats: an export's chat joins the live chat of the same name when exactly
//   one has it (the status updates chat joins the status posts). Otherwise it
//   is a conversation of its own in the WhatsApp source. A decision, once
//   made, is kept in the resume point, so a chat never splits across passes.
// - Media the export carries become children of their message, read later by
//   their locator (archive-import/input-media.ts). A voice note live capture
//   saved already holds its content, so the export's copy is not added.
// - Notices from WhatsApp itself stay left out (the export reader skips them).
//
// The decisions above ride the resume point (`wa1~<state>~<reader's cursor>`),
// so every pass of one import reads the export the same way.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import {
  ARCHIVE_COMMON_FINDINGS,
  ArchiveImportStoppedError,
  type ArchiveConnectorInput,
  type ArchiveImportFinding,
} from '../../core/archive-formats.ts';
import type { RawItem, SourceConnectorInput, SourceRecordPage } from '../../core/contracts.ts';
import { archiveConnectorId } from '../archive-import/state.ts';
import { archiveInputMediaLocator, archiveInputZipMediaLocator } from '../archive-import/input-media.ts';
import { createWhatsAppArchiveConnector } from '../archive-import/whatsapp/connector.ts';
import { isWhatsAppMediaOmitted, whatsAppAttachedFileName } from '../archive-import/whatsapp/grammar.ts';
import { ZipArchive } from '../archive-import/zip-reader.ts';
import {
  OWNER_SENDER,
  exactKey,
  exportMessageId,
  looseKey,
  nameKey,
  textKey,
  timeSlot,
  unsentKey,
  type TimePrecision,
} from './match-keys.ts';
import { WhatsAppSpoolIndex } from './spool-index.ts';
import { catchUpWhatsAppSpoolIndex } from './live-connector.ts';
import { chooseExportTimeZone, isKnownTimeZone, wallTimeToUtcMs } from './export-zone.ts';
import type { WhatsAppChildRecord, WhatsAppRecord } from './live-connector.ts';

export const WHATSAPP_STATUS_JID = 'status@broadcast';
/** The server part of a chat an export brings that live capture does not hold. */
export const WHATSAPP_EXPORT_CHAT_SERVER = 'export.whatsapp';
const CURSOR_PREFIX = 'wa1~';
/** Messages the first pass reads to choose the time zone and learn the owner's name. */
const SAMPLE_MESSAGES = 50_000;
/** How much of the export the first pass may read looking for the overlap with live capture. */
const SAMPLE_BYTES = 1024 * 1024 * 1024;
/** How much of the live spool one pass may index before matching (the rest is matched the other way, later). */
const LIVE_INDEX_BYTES = 64 * 1024 * 1024;
/** The most messages a time slot may hold and still be certain: a fuller one is in doubt, and nothing in it is matched. */
const SLOT_CAP = 200;
/** How much of the export reading the rest of a slot past a page's end may take; a slot not read whole is in doubt. */
const SLOT_LOOKAHEAD_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 3_600_000;

export const WHATSAPP_INPUT_FINDINGS = {
  /** A message live capture may hold too, shown differently (a renamed contact, an edited caption): kept as its own. */
  nearMiss: 'match_near_miss',
} as const;

/** What one import decided, kept in its resume point. */
interface InputState {
  /** The time zone the export's wall times are read in. */
  z: string;
  /** The owner's name in the export, hashed; absent when no name matched. */
  m?: string;
  /** Each chat met so far, by its name's hash: the live chat it joined, or '' for one of its own. */
  j: Record<string, string>;
  /**
   * The time slot the export was in when the page ended: how many messages it
   * held so far, and how many of each key (at most SLOT_CAP keys; `d` once the
   * slot is in doubt, with no keys). Only this one slot is ever kept.
   */
  g?: { s: string; n: number; c?: Record<string, number>; d?: 1 };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function encodeCursor(state: InputState, inner: string | undefined): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(state)).toString('base64url')}~${inner ?? ''}`;
}

function decodeCursor(cursor: string | undefined): { state?: InputState; inner?: string } {
  if (cursor === undefined) return {};
  const invalid = new ArchiveImportStoppedError('resume_point_invalid', 'This import\'s resume point is not one this build reads.');
  if (!cursor.startsWith(CURSOR_PREFIX)) throw invalid;
  const rest = cursor.slice(CURSOR_PREFIX.length);
  const split = rest.indexOf('~');
  if (split < 0) throw invalid;
  let state: InputState;
  try {
    state = JSON.parse(Buffer.from(rest.slice(0, split), 'base64url').toString('utf8')) as InputState;
  } catch {
    throw invalid;
  }
  if (typeof state.z !== 'string' || !isKnownTimeZone(state.z) || typeof state.j !== 'object' || state.j === null) throw invalid;
  const inner = rest.slice(split + 1);
  return { state, ...(inner ? { inner } : {}) };
}

/** An export's message as the export reader gives it, before it is a record. */
interface ExportMessage {
  chat: string;
  sender: string;
  wall: string;
  precision: TimePrecision;
  occurrence: string;
  text: string;
  sourceFile: string;
  sourceFileIndex: number;
  sourceMember?: string;
}

function exportMessageOf(item: RawItem): ExportMessage | undefined {
  const md = item.metadata;
  const text = item.content.kind === 'text' ? item.content.text : undefined;
  const wall = md['writtenAt'];
  if (typeof text !== 'string' || typeof wall !== 'string' || typeof md['chat'] !== 'string' || typeof md['sender'] !== 'string') return undefined;
  return {
    chat: md['chat'],
    sender: md['sender'],
    wall,
    precision: md['timePrecision'] === 'second' ? 'second' : 'minute',
    occurrence: typeof md['occurrence'] === 'string' ? md['occurrence'] : '',
    text,
    sourceFile: typeof md['sourceFile'] === 'string' ? md['sourceFile'] : '',
    sourceFileIndex: typeof md['sourceFileIndex'] === 'number' ? md['sourceFileIndex'] : 0,
    ...(typeof md['sourceMember'] === 'string' ? { sourceMember: md['sourceMember'] } : {}),
  };
}

/** The caption (the text without its media markers), the files it names, and whether the export left media out. */
function splitMedia(text: string): { caption: string; files: string[]; omitted: boolean } {
  if (isWhatsAppMediaOmitted(text)) return { caption: '', files: [], omitted: true };
  const files: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const name = line.length <= 400 ? whatsAppAttachedFileName(line) : undefined;
    if (name !== undefined) files.push(name);
    else kept.push(line);
  }
  return { caption: kept.join('\n').trim(), files, omitted: false };
}

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain', vcf: 'text/vcard',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function whatsAppMediaMime(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_MIME[extension] ?? 'application/octet-stream';
}

/** The bridge's media type for a file the export names, by WhatsApp's own prefixes and then its kind. */
export function whatsAppMediaTypeOf(name: string): string {
  const upper = name.toUpperCase();
  if (/(^|-)STICKER|^STK-/u.test(upper)) return 'sticker';
  if (/^PTT-|(^|-)AUDIO/u.test(upper) || upper.startsWith('AUD-')) return 'audio';
  const mime = whatsAppMediaMime(name);
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export interface WhatsAppExportInputOptions {
  archive: ArchiveConnectorInput;
  /** The live spool of the account the export joins. */
  spoolDir: string;
  /** Zones to try (test seam); defaults to every zone the runtime knows, this computer's first. */
  zones?: readonly string[];
  /** How much of the live spool one pass may index before the import waits for the next (default 64 MiB; test seam). */
  liveIndexBudgetBytes?: number;
}

/**
 * The export as an input of the WhatsApp connector: its records in the
 * bridge's shape, under the archive's own connector id.
 */
export function createWhatsAppExportInput(options: WhatsAppExportInputOptions): SourceConnectorInput<WhatsAppRecord> {
  const { archive } = options;
  return {
    inputId: archiveConnectorId(archive.archiveId),
    kind: 'archive',
    records(listing = {}): AsyncIterable<SourceRecordPage<WhatsAppRecord>> {
      return (async function* (): AsyncGenerator<SourceRecordPage<WhatsAppRecord>> {
        const decoded = decodeCursor(listing.cursor);
        // Live capture's side, as the spool index holds it: caught up to the spool's end first. An index still
        // catching up proves nothing about uniqueness, so this pass decides nothing and gives no id: it waits, and
        // the next pass goes on (ids come from what a message is, so a decision put off is the same decision).
        if (existsSync(options.spoolDir) && !catchUpWhatsAppSpoolIndex(options.spoolDir, options.liveIndexBudgetBytes ?? LIVE_INDEX_BYTES)) {
          yield { records: [], ...(listing.cursor !== undefined ? { nextCursor: listing.cursor } : {}), done: false };
          return;
        }
        const index = WhatsAppSpoolIndex.open(options.spoolDir);
        const matching: Matching = { index };
        try {
          let decided: InputState;
          if (decoded.state) {
            decided = decoded.state;
          } else {
            const window = index?.liveWindow();
            const sample = window ? await sampleExport(archive, window) : [];
            const { assumed, ...chosen } = decide(sample, matching, options.zones);
            if (assumed) archive.report({ kind: ARCHIVE_COMMON_FINDINGS.timeZoneAssumed, class: 'gap', fileIndex: 0, offset: 0 });
            decided = chosen;
          }
          const media = createMediaLocator(archive);
          let positions: ReadonlyArray<{ fileIndex: number; offset: number }> = [];
          const reader = createWhatsAppArchiveConnector({
            ...archive,
            // The input says these itself: the zone it chose, and the media it made children of.
            report: (finding: ArchiveImportFinding) => {
              if (finding.kind === ARCHIVE_COMMON_FINDINGS.timeZoneAssumed || finding.kind === ARCHIVE_COMMON_FINDINGS.mediaNotImported) return;
              archive.report(finding);
            },
            reportItemPositions: (told) => {
              positions = told;
              archive.reportItemPositions?.(told);
            },
          });
          for await (const page of reader.listItems({
            ...(decoded.inner !== undefined ? { cursor: decoded.inner } : {}),
            ...(listing.limit !== undefined ? { limit: listing.limit } : {}),
          })) {
            const records: WhatsAppRecord[] = [];
            const keyed = page.items.flatMap((item, at) => {
              const message = exportMessageOf(item);
              return message ? [{ message, at, keyed: keyOf(message, decided, matching) }] : [];
            });
            // Each slot's count and each key's count in all: the slot open when the previous page ended (carried),
            // this page, and the rest of the slot this page ends in, read ahead. A slot is certain only when it was
            // read whole and holds at most SLOT_CAP messages.
            const carried = decided.g;
            const slotCount = new Map<string, number>();
            const keyCount = new Map<string, number>();
            const doubt = new Set<string>();
            if (carried) {
              slotCount.set(carried.s, carried.n);
              if (carried.d) doubt.add(carried.s);
              for (const [key, count] of Object.entries(carried.c ?? {})) keyCount.set(key, count);
            }
            for (const { keyed: { key, slot } } of keyed) {
              slotCount.set(slot, (slotCount.get(slot) ?? 0) + 1);
              keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
            }
            const last = keyed.at(-1);
            if (last && !page.done && page.nextCursor !== undefined) {
              const ahead = await countSlotAhead(archive, page.nextCursor, last.keyed.slot, decided, matching);
              if (!ahead.whole) doubt.add(last.keyed.slot);
              slotCount.set(last.keyed.slot, (slotCount.get(last.keyed.slot) ?? 0) + ahead.count);
              for (const [key, count] of ahead.keys) keyCount.set(key, (keyCount.get(key) ?? 0) + count);
            }
            for (const [slot, count] of slotCount) if (count > SLOT_CAP) doubt.add(slot);
            // What carries to the next page: the slot this page ends in, as it stands (never what was read ahead).
            if (last) {
              const slot = last.keyed.slot;
              const seen = (carried?.s === slot ? carried.n : 0) + keyed.filter((entry) => entry.keyed.slot === slot).length;
              const inDoubt = seen > SLOT_CAP || (carried?.s === slot && carried.d === 1);
              const counts: Record<string, number> = {};
              if (!inDoubt) {
                if (carried?.s === slot) Object.assign(counts, carried.c ?? {});
                for (const entry of keyed) if (entry.keyed.slot === slot) counts[entry.keyed.key] = (counts[entry.keyed.key] ?? 0) + 1;
              }
              decided.g = inDoubt ? { s: slot, n: seen, d: 1 } : { s: slot, n: seen, c: counts };
            }
            for (const { message, at, keyed: k } of keyed) {
              const place = positions[at] ?? { fileIndex: message.sourceFileIndex, offset: 0 };
              const certain = !doubt.has(k.slot) && keyCount.get(k.key) === 1;
              records.push(recordOf(message, k, certain, decided, matching, media,
                (finding) => archive.report({ ...finding, fileIndex: place.fileIndex, offset: place.offset })));
            }
            positions = [];
            const nextCursor = page.nextCursor !== undefined ? encodeCursor(decided, page.nextCursor) : undefined;
            yield page.truncated === true
              ? { records, ...(nextCursor ? { nextCursor } : {}), done: false, truncated: true }
              : { records, ...(nextCursor ? { nextCursor } : {}), done: page.done };
          }
        } finally {
          index?.close();
        }
      })();
    },
  };
}

/** Live capture's side of the matching. */
interface Matching {
  index: WhatsAppSpoolIndex | undefined;
}

/**
 * The export's messages in the window live capture covers (a day either
 * side, for any zone), read without telling the import anything, within a
 * byte budget: what the zone and the owner's name are learned from.
 */
async function sampleExport(archive: ArchiveConnectorInput, window: { fromMs: number; toMs: number }): Promise<ExportMessage[]> {
  const quiet = createWhatsAppArchiveConnector({
    ...archive,
    report: () => undefined,
    reportPosition: () => undefined,
    reportItemPositions: () => undefined,
    maxBytesPerListing: SAMPLE_BYTES,
    pageSize: 500,
  });
  const sample: ExportMessage[] = [];
  for await (const page of quiet.listItems()) {
    for (const item of page.items) {
      const message = exportMessageOf(item);
      if (!message) continue;
      const wallMs = Date.parse(`${message.wall}Z`);
      if (Number.isFinite(wallMs) && wallMs >= window.fromMs - DAY_MS && wallMs <= window.toMs + DAY_MS) sample.push(message);
      if (sample.length >= SAMPLE_MESSAGES) return sample;
    }
  }
  return sample;
}

function chatOf(state: InputState, matching: Matching, chat: string): string {
  const key = hash(nameKey(chat));
  const known = state.j[key];
  if (known !== undefined) return known === '' ? `${key}@${WHATSAPP_EXPORT_CHAT_SERVER}` : known;
  let joined = '';
  if (nameKey(chat) === WHATSAPP_STATUS_JID) joined = WHATSAPP_STATUS_JID;
  else {
    const named = matching.index?.chatsNamed(nameKey(chat)) ?? [];
    if (named.length === 1) joined = named[0]!;
  }
  state.j[key] = joined;
  return joined === '' ? `${key}@${WHATSAPP_EXPORT_CHAT_SERVER}` : joined;
}

/** The time zone, the owner's name and the joins of the sampled chats. */
function decide(sample: readonly ExportMessage[], matching: Matching, zones?: readonly string[]): InputState & { assumed: boolean } {
  const state: InputState = { z: '', j: {} };
  const index = matching.index;
  const days = [...new Set(sample.map((message) => message.wall.slice(0, 10)))].slice(0, 64);
  const keyed = sample.map((message) => ({ message, caption: textKey(splitMedia(message.text).caption) }));
  // Across chats, and with the sender as written or as the owner (whose name is not known yet).
  const chosen = chooseExportTimeZone(days.length > 0 ? days : ['2020-01-01'], (zone) => {
    if (!index) return 0;
    let matches = 0;
    for (const { message, caption } of keyed) {
      const ms = wallTimeToUtcMs(message.wall, zone);
      if (ms === undefined) continue;
      if (index.hasLooseKey(message.precision, looseKey(ms, message.precision, nameKey(message.sender), caption))
        || index.hasLooseKey(message.precision, looseKey(ms, message.precision, OWNER_SENDER, caption))) matches += 1;
    }
    return matches;
  }, zones);
  state.z = chosen.zone;
  // The owner: the export name whose messages match live capture's own most, in joined chats.
  const votes = new Map<string, number>();
  for (const { message, caption } of keyed) {
    const ms = wallTimeToUtcMs(message.wall, state.z);
    if (ms === undefined || !index) continue;
    const chat = chatOf(state, matching, message.chat);
    if (index.ownerSentUnsent(message.precision, unsentKey(chat, ms, message.precision, caption))) {
      const name = hash(nameKey(message.sender));
      votes.set(name, (votes.get(name) ?? 0) + 1);
    }
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (ranked[0] && (ranked[1] === undefined || ranked[0][1] > ranked[1][1])) state.m = ranked[0][0];
  return { ...state, assumed: chosen.assumed };
}

interface MediaLocator {
  child(message: ExportMessage, name: string): Omit<WhatsAppChildRecord, 'key' | 'mimeType'>;
}

/** Where a file the export names is: a member of its zip, or a file beside its text in the chosen folder. */
function createMediaLocator(archive: ArchiveConnectorInput): MediaLocator {
  const zipMembers = new Map<number, Map<string, { index: number; size: number }>>();
  const membersOf = (fileIndex: number): Map<string, { index: number; size: number }> => {
    let members = zipMembers.get(fileIndex);
    if (members) return members;
    members = new Map();
    const file = archive.files[fileIndex];
    if (file) {
      let reader;
      try {
        reader = archive.root.openFile(file.relPath, { expected: file.version });
        const zip = ZipArchive.open(reader);
        for (const entry of zip.entries()) {
          if (!entry.isDirectory) members.set(entry.name, { index: entry.index, size: entry.uncompressedSize });
        }
      } catch {
        // A zip that cannot be listed again names no member: its media are told as unavailable.
      } finally {
        reader?.close();
      }
    }
    zipMembers.set(fileIndex, members);
    return members;
  };
  return {
    child(message, name) {
      if (message.sourceMember !== undefined) {
        const members = membersOf(message.sourceFileIndex);
        const folder = posix.dirname(message.sourceMember);
        const member = members.get(folder === '.' ? name : `${folder}/${name}`) ?? members.get(name);
        if (!member) return { name, available: false };
        return {
          name,
          available: true,
          locator: archiveInputZipMediaLocator({ archiveId: archive.archiveId, fileIndex: message.sourceFileIndex, memberIndex: member.index }),
          sizeBytes: member.size,
        };
      }
      if (!archive.media) return { name, available: false };
      const folder = posix.dirname(message.sourceFile);
      const bound = archive.media.bind(folder === '.' ? name : `${folder}/${name}`);
      if (!bound.ok) return { name, available: false };
      return {
        name,
        available: true,
        locator: archiveInputMediaLocator({ archiveId: archive.archiveId, bindingId: bound.bindingId }),
        sizeBytes: bound.sizeBytes,
      };
    },
  };
}

/** An export message's key, and what it is made of. */
interface KeyedMessage {
  ms: number;
  chatJid: string;
  owner: boolean;
  caption: string;
  files: string[];
  omitted: boolean;
  key: string;
  /** The chat and time slot: the messages whose keys are counted together. */
  slot: string;
}

function keyOf(message: ExportMessage, state: InputState, matching: Matching): KeyedMessage {
  const ms = wallTimeToUtcMs(message.wall, state.z) ?? Date.parse(`${message.wall}Z`);
  const chatJid = chatOf(state, matching, message.chat);
  const owner = state.m !== undefined && hash(nameKey(message.sender)) === state.m;
  const sender = owner ? OWNER_SENDER : nameKey(message.sender);
  const { caption, files, omitted } = splitMedia(message.text);
  return {
    ms,
    chatJid,
    owner,
    caption,
    files,
    omitted,
    key: exactKey(chatJid, ms, message.precision, sender, textKey(caption)),
    slot: `${chatJid}\u0000${timeSlot(ms, message.precision)}`,
  };
}

/**
 * The rest of the slot a page ended in (an export is in time order, so the
 * slot's rest is next): how many messages and of which keys, read quietly.
 * `whole` only when the slot's end was seen (a message of another slot, or
 * the export's end) within the cap and the byte bound; otherwise the slot is
 * in doubt.
 */
async function countSlotAhead(
  archive: ArchiveConnectorInput,
  cursor: string,
  slot: string,
  state: InputState,
  matching: Matching,
): Promise<{ whole: boolean; count: number; keys: Map<string, number> }> {
  const quiet = createWhatsAppArchiveConnector({
    ...archive,
    report: () => undefined,
    reportPosition: () => undefined,
    reportItemPositions: () => undefined,
    maxBytesPerListing: SLOT_LOOKAHEAD_BYTES,
    pageSize: 100,
  });
  const keys = new Map<string, number>();
  let count = 0;
  for await (const page of quiet.listItems({ cursor })) {
    for (const item of page.items) {
      const message = exportMessageOf(item);
      if (!message) continue;
      // The join decision is the import's own; a peek never makes one.
      const keyed = keyOf(message, { ...state, j: { ...state.j } }, matching);
      if (keyed.slot !== slot) return { whole: true, count, keys };
      count += 1;
      keys.set(keyed.key, (keys.get(keyed.key) ?? 0) + 1);
      if (count > SLOT_CAP) return { whole: false, count, keys };
    }
    if (page.done) return { whole: true, count, keys };
    // Out of bytes (or cut short) before the slot ended: in doubt.
    if (page.truncated === true) return { whole: false, count, keys };
  }
  // The listing ended without saying it was done (its byte bound): the slot was not read whole.
  return { whole: false, count, keys };
}

/**
 * One export message as the bridge's record: the live message already stored
 * when the match is certain (one export message and one live message hold the
 * key, see the header), else its own, with an id from its key and occurrence.
 */
function recordOf(
  message: ExportMessage,
  keyed: KeyedMessage,
  certain: boolean,
  state: InputState,
  matching: Matching,
  media: MediaLocator,
  report: (finding: Omit<ArchiveImportFinding, 'fileIndex' | 'offset'>) => void,
): WhatsAppRecord {
  const { ms, chatJid, owner, caption, files, omitted, key } = keyed;
  // A picture or file with no words is never matched: the key says nothing of which picture it is.
  const wordless = textKey(caption) === '' && (files.length > 0 || omitted);
  const matched = wordless || !certain ? undefined : matching.index?.uniqueLiveWithKey(message.precision, key);
  // Its own id from what it is: the whole text (the file names in it included) and its number among identical ones.
  const id = matched ? matched.id : exportMessageId(chatJid, ms, message.precision, owner ? OWNER_SENDER : nameKey(message.sender), textKey(message.text), message.occurrence);
  if (!matched && matching.index?.liveBetween(chatJid, ms - 60_000, ms + 60_000)) {
    report({ kind: WHATSAPP_INPUT_FINDINGS.nearMiss, class: 'skipped' });
  }

  const mediaType = matched?.mediaType ?? (files[0] !== undefined ? whatsAppMediaTypeOf(files[0]) : omitted ? 'media' : undefined);
  const children: WhatsAppChildRecord[] = [];
  // A voice note the bridge saved already holds its words; the export's copy would be the same item twice.
  const liveHoldsMedia = matched?.mediaSaved === true && mediaType === 'audio';
  if (!liveHoldsMedia) {
    // One child per piece of media, keyed as live capture keys its own (`media`), so a picture both inputs bring is one item.
    files.forEach((name, at) => {
      const located = media.child(message, name);
      if (!located.available) report({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap' });
      children.push({ key: at === 0 ? 'media' : `media-${at + 1}`, mimeType: whatsAppMediaMime(name), ...located });
    });
    if (omitted) {
      report({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap' });
      children.push({ key: 'media', name: 'Media left out of the export', mimeType: 'application/octet-stream', available: false });
    }
  }
  return {
    id,
    chatJid: matched?.chatJid ?? chatJid,
    chatName: message.chat,
    senderJid: '',
    senderName: owner ? '' : message.sender,
    ...(owner ? {} : { senderContactName: message.sender }),
    fromMe: matched?.fromMe ?? owner,
    timestamp: matched?.timestamp ?? new Date(ms).toISOString(),
    text: caption,
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}
