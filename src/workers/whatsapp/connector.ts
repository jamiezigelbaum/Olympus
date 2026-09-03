// Contract 1 (SourceConnector) adapter for WhatsApp chat exports — the
// device-local capture path. The owner exports chats from WhatsApp (Export Chat)
// into a directory; this connector parses those .txt files (and .zip archives
// wrapping them). Live capture from the encrypted message database is
// explicitly out of scope.
//
// Documented parsing choices:
// - Both standard export header formats are handled:
//     '[DD/MM/YYYY, HH:MM:SS] Sender: message'   (bracketed, iOS-style)
//     'DD/MM/YY, HH:MM - Sender: message'        (dashed, Android-style)
//   with 2- or 4-digit years, optional seconds, and an optional AM/PM marker.
//   Day/month remains the default for ambiguous dates; month/day is accepted
//   when day/month is impossible, which covers US exports such as 5/14/26.
//   Unicode direction marks are stripped and narrow no-break spaces normalized
//   before matching, because real exports contain both.
// - Lines that do not start a new message header are continuations and append
//   to the previous message. Continuation text before the first header in a
//   file has no message to attach to and is dropped.
// - System messages (header lines whose remainder has no 'Sender: ' part —
//   e2e-encryption notices, group events) are SURFACED as metadata-only
//   RawItems, not skipped: skipping them would hide group membership and
//   encryption-state events from downstream coverage. Their text is preserved
//   in metadata.systemText.
// - Exports carry device-local wall-clock times with no timezone, so sentAt is
//   a zone-less ISO timestamp ('YYYY-MM-DDTHH:MM:SS').
// - The chat name comes from the export file name ('WhatsApp Chat with X.txt'
//   -> 'X'); zip entries that do not match that pattern (e.g. the '_chat.txt'
//   WhatsApp puts inside archives) inherit the chat name of their archive.
// - Listing is deterministic: files sort by name, messages keep file order,
//   and the cursor is a global integer offset into that ordering.
// - Zip support covers stored and deflated entries (what WhatsApp produces).
//   Corrupt or exotic archives fail loudly instead of being skipped silently;
//   plain .txt files that simply contain no parseable messages yield nothing.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';

const CONNECTOR_ID = 'whatsapp';
const TEXT_MIME_TYPE = 'text/plain';
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2_000;

const BRACKETED_HEADER = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]\s?(.*)$/;
const DASHED_HEADER = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s-\s(.*)$/;
const EXPORT_FILENAME_PATTERN = /^WhatsApp Chat (?:with|-)\s*(.+)$/i;

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

export interface WhatsAppSourceConnectorOptions {
  exportDir: string;
  account: string;
}

export interface WhatsAppExportMessage {
  chat: string;
  sender?: string;
  sentAt: string;
  text: string;
  index: number;
  providerItemId: string;
}

export function createWhatsAppSourceConnector(options: WhatsAppSourceConnectorOptions): SourceConnector {
  const exportDir = requireNonEmpty(options.exportDir, 'WhatsApp source connector exportDir');
  const account = requireNonEmpty(options.account, 'WhatsApp source connector account');

  const loadAllMessages = (): WhatsAppExportMessage[] =>
    readExportSources(exportDir).flatMap((source) => parseWhatsAppChatExport(source.text, source.chat));

  return {
    id: CONNECTOR_ID,
    family: 'chat',

    async authenticate(): Promise<void> {
      const sources = readExportSources(exportDir);
      if (sources.length === 0) {
        throw new Error(
          `WhatsApp export directory ${exportDir} contains no .txt or .zip chat exports. `
          + 'Export chats from WhatsApp (Export Chat) into the directory first.',
        );
      }
      const parseable = sources.some((source) => parseWhatsAppChatExport(source.text, source.chat).length > 0);
      if (!parseable) {
        throw new Error(
          `WhatsApp export directory ${exportDir} has no parseable chat export. `
          + 'Expected the standard "[DD/MM/YYYY, HH:MM:SS] Sender: message" or "DD/MM/YY, HH:MM - Sender: message" line format.',
        );
      }
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePositiveInteger(listOptions?.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
      const initialOffset = offsetFromCursor(listOptions?.cursor);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const messages = loadAllMessages();
        let offset = initialOffset;
        if (offset >= messages.length) {
          yield { items: [], done: true };
          return;
        }
        while (offset < messages.length) {
          const slice = messages.slice(offset, offset + limit);
          offset += slice.length;
          const fetchedAt = nowIso();
          yield {
            items: slice.map((message) => rawItemFromMessage(message, account, fetchedAt)),
            nextCursor: String(offset),
            done: offset >= messages.length,
          };
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const providerItemId = providerItemIdFromLocalItemId(localItemId, account);
      const match = loadAllMessages().find((message) => message.providerItemId === providerItemId);
      if (!match) {
        throw new Error(`WhatsApp export message ${localItemId} was not found under ${exportDir}.`);
      }
      return rawItemFromMessage(match, account, nowIso());
    },

    classify(_item: RawItem): SourceSensitivity {
      // Private chat history is ALWAYS S4/secure_local: local-only storage,
      // never eligible for cloud embeddings. No content signal may downgrade.
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

// --- Export parsing ---------------------------------------------------------

export function parseWhatsAppChatExport(text: string, chat: string): WhatsAppExportMessage[] {
  const drafts: { sender?: string; sentAt: string; lines: string[] }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = normalizeExportLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    const header = matchMessageHeader(line);
    if (header === undefined) {
      const open = drafts[drafts.length - 1];
      if (open) open.lines.push(line);
      continue;
    }
    const { sender, text: body } = splitSenderFromRest(header.rest);
    drafts.push({
      ...(sender === undefined ? {} : { sender }),
      sentAt: header.sentAt,
      lines: [body],
    });
  }
  return drafts.map((draft, index) => ({
    chat,
    ...(draft.sender === undefined ? {} : { sender: draft.sender }),
    sentAt: draft.sentAt,
    text: draft.lines.join('\n').trimEnd(),
    index,
    providerItemId: whatsAppProviderItemId(chat, draft.sentAt, draft.sender, index),
  }));
}

export function whatsAppChatNameFromExportFilename(fileName: string): string {
  const stem = basename(fileName).replace(/\.(txt|zip)$/i, '');
  return chatNameIfWhatsAppPattern(stem) ?? stem.trim();
}

function chatNameIfWhatsAppPattern(fileName: string): string | undefined {
  const stem = basename(fileName).replace(/\.(txt|zip)$/i, '');
  const match = EXPORT_FILENAME_PATTERN.exec(stem);
  const chat = match?.[1]?.trim();
  return chat ? chat : undefined;
}

function matchMessageHeader(line: string): { sentAt: string; rest: string } | undefined {
  const match = BRACKETED_HEADER.exec(line) ?? DASHED_HEADER.exec(line);
  if (!match) return undefined;
  const [, day, month, year, hour, minute, second, meridiem, rest] = match;
  if (day === undefined || month === undefined || year === undefined || hour === undefined || minute === undefined) {
    return undefined;
  }
  const sentAt = isoTimestampFromExportParts(day, month, year, hour, minute, second, meridiem);
  if (sentAt === undefined) return undefined;
  return { sentAt, rest: rest ?? '' };
}

function isoTimestampFromExportParts(
  firstDatePart: string,
  secondDatePart: string,
  year: string,
  hour: string,
  minute: string,
  second: string | undefined,
  meridiem: string | undefined,
): string | undefined {
  return isoTimestampFromOrderedExportParts(firstDatePart, secondDatePart, year, hour, minute, second, meridiem)
    ?? isoTimestampFromOrderedExportParts(secondDatePart, firstDatePart, year, hour, minute, second, meridiem);
}

function isoTimestampFromOrderedExportParts(
  day: string,
  month: string,
  year: string,
  hour: string,
  minute: string,
  second: string | undefined,
  meridiem: string | undefined,
): string | undefined {
  const yearNumber = year.length <= 2 ? 2_000 + Number(year) : Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const minuteNumber = Number(minute);
  const secondNumber = second === undefined ? 0 : Number(second);
  let hourNumber = Number(hour);
  if (meridiem !== undefined) {
    const isPm = meridiem.toLowerCase() === 'pm';
    if (hourNumber === 12) hourNumber = isPm ? 12 : 0;
    else if (isPm) hourNumber += 12;
  }
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return undefined;
  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return undefined;
  return `${String(yearNumber).padStart(4, '0')}-${pad2(monthNumber)}-${pad2(dayNumber)}`
    + `T${pad2(hourNumber)}:${pad2(minuteNumber)}:${pad2(secondNumber)}`;
}

function splitSenderFromRest(rest: string): { sender?: string; text: string } {
  const separator = rest.indexOf(': ');
  if (separator <= 0) return { text: rest.trim() };
  const sender = rest.slice(0, separator).trim();
  if (!sender) return { text: rest.trim() };
  return { sender, text: rest.slice(separator + 2) };
}

function normalizeExportLine(line: string): string {
  // Strip bidi direction marks; normalize no-break spaces (real exports use
  // U+202F before AM/PM markers) so the header regexes stay matchable.
  return line.replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/[\u00a0\u202f]/g, ' ');
}

// --- RawItem mapping --------------------------------------------------------

function rawItemFromMessage(message: WhatsAppExportMessage, account: string, fetchedAt: string): RawItem {
  const identity: SourceItemIdentity = {
    family: 'chat',
    provider: CONNECTOR_ID,
    accountScope: account,
    providerItemId: message.providerItemId,
    providerConversationId: message.chat,
    localItemId: `${account}:${message.providerItemId}`,
  };
  if (message.sender === undefined) {
    return {
      identity,
      mimeType: TEXT_MIME_TYPE,
      content: { kind: 'metadata_only' },
      metadata: Object.freeze({
        chat: message.chat,
        sentAt: message.sentAt,
        system: true,
        systemText: message.text,
      }),
      fetchedAt,
    };
  }
  return {
    identity,
    mimeType: TEXT_MIME_TYPE,
    content: { kind: 'text', text: message.text },
    metadata: Object.freeze({
      chat: message.chat,
      sender: message.sender,
      senderLabel: message.sender,
      sentAt: message.sentAt,
    }),
    fetchedAt,
  };
}

function whatsAppProviderItemId(chat: string, sentAt: string, sender: string | undefined, index: number): string {
  return createHash('sha256')
    .update(`${chat} ${sentAt} ${sender ?? ''} ${index}`)
    .digest('hex')
    .slice(0, 32);
}

function providerItemIdFromLocalItemId(localItemId: string, account: string): string {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length <= prefix.length) {
    throw new Error(`WhatsApp source connector local item ids look like ${prefix}<provider item id>.`);
  }
  return localItemId.slice(prefix.length);
}

// --- Export directory reading -----------------------------------------------

interface WhatsAppExportSource {
  chat: string;
  text: string;
  sourceFile: string;
}

function readExportSources(exportDir: string): WhatsAppExportSource[] {
  let directory;
  try {
    directory = statSync(exportDir);
  } catch {
    throw new Error(`WhatsApp export directory ${exportDir} does not exist.`);
  }
  if (!directory.isDirectory()) {
    throw new Error(`WhatsApp export path ${exportDir} is not a directory.`);
  }
  const sources: WhatsAppExportSource[] = [];
  const entries = readdirSync(exportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  for (const fileName of entries) {
    const fullPath = join(exportDir, fileName);
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.txt')) {
      const chat = whatsAppChatNameFromExportFilename(fileName);
      if (!isWhatsAppStatusBroadcast(chat)) {
        sources.push({
          chat,
          text: readFileSync(fullPath, 'utf8'),
          sourceFile: fileName,
        });
      }
    } else if (lower.endsWith('.zip')) {
      const archiveChat = whatsAppChatNameFromExportFilename(fileName);
      for (const entry of readZipTextEntries(readFileSync(fullPath), `WhatsApp export archive ${fileName}`)) {
        const chat = chatNameIfWhatsAppPattern(entry.name) ?? archiveChat;
        if (isWhatsAppStatusBroadcast(chat)) continue;
        sources.push({
          chat,
          text: entry.text,
          sourceFile: `${fileName}:${entry.name}`,
        });
      }
    }
  }
  return sources;
}

// --- Minimal zip reading (stored + deflated entries, what WhatsApp emits) ----

function readZipTextEntries(bytes: Buffer, zipLabel: string): { name: string; text: string }[] {
  const eocdOffset = findEndOfCentralDirectoryOffset(bytes);
  if (eocdOffset === undefined) {
    throw new Error(`${zipLabel} is not a readable zip archive (no end-of-central-directory record).`);
  }
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  let cursor = bytes.readUInt32LE(eocdOffset + 16);
  const entries: { name: string; text: string }[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`${zipLabel} has a corrupt central directory entry.`);
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!isChatTextEntry(name)) continue;
    if (localHeaderOffset + 30 > bytes.length) {
      throw new Error(`${zipLabel} has a corrupt local header for entry ${name}.`);
    }
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.push({ name, text: data.toString('utf8') });
    } else if (method === 8) {
      entries.push({ name, text: inflateRawSync(data).toString('utf8') });
    } else {
      throw new Error(`${zipLabel} entry ${name} uses unsupported compression method ${method}.`);
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function findEndOfCentralDirectoryOffset(bytes: Buffer): number | undefined {
  const minimum = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  return undefined;
}

function isChatTextEntry(name: string): boolean {
  if (name.endsWith('/')) return false;
  if (name.startsWith('__MACOSX/')) return false;
  const base = name.split('/').pop() ?? name;
  if (base.startsWith('._')) return false;
  return base.toLowerCase().endsWith('.txt');
}

function isWhatsAppStatusBroadcast(chat: string): boolean {
  return chat.trim().toLowerCase() === 'status@broadcast';
}

// --- Small shared helpers ----------------------------------------------------

function offsetFromCursor(cursor: string | undefined): number {
  const text = cursor?.trim();
  if (text === undefined || text === '') return 0;
  if (!/^\d+$/.test(text)) {
    throw new Error('WhatsApp export cursors are non-negative integer offsets.');
  }
  return Number(text);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.max(1, Math.floor(value));
  return maximum === undefined ? floored : Math.min(floored, maximum);
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}
