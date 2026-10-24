/**
 * The WhatsApp chat-export archive connector: one RawItem per message of an
 * exported chat, shaped like a live WhatsApp message (chat, sender, time) so
 * answers treat imported and live chats alike. The imported items carry their
 * own provider, so live capture and an import never share a row.
 *
 * - Reading: the archive's files in manifest order. A plain text file is read
 *   through the scope-safe range reader; a zip is opened where it is and each
 *   chat member in it (`_chat.txt`, `WhatsApp Chat with <name>.txt`) is read
 *   as a stream, never inflated whole. Media in the zip or beside the text is
 *   not read. Lines become messages in `messages.ts`.
 * - Chat: the chat's name comes from the export's own file name (the member's,
 *   else the zip's). A chat is the thread; two exports of one chat share it.
 * - Identity: the source (file and member), the chat, the written time, the
 *   sender, the message's number among the file's headers and a hash of its
 *   text. Two exports of one chat (a .txt and a .zip) therefore never
 *   overwrite each other's messages, whatever their text.
 * - Time: the export writes wall time with no zone, and in the order the
 *   phone's locale uses. The order is read from the file's own headers (any
 *   day above 12 settles it) and, when nothing does, taken as day first and
 *   said so. The time is read in this computer's zone, and that is said once
 *   per archive.
 * - Left out, and counted: notices from WhatsApp itself, messages with no
 *   text, and the status updates chat. Media is named in the message's text
 *   and counted as not imported. A message longer than the bound is cut and
 *   counted.
 * - Changes: each page goes out only while its file is still the version
 *   opened, under the descriptor and at its name; a file changed, replaced or
 *   removed after the first page stops the import, whatever was buffered.
 * - Resume point: `wa1:<manifest>:<file>:<member>:<offset>:<ordinal>:<order>`
 *   (and the member's checksum so far for a stored member): where the next
 *   message's header line starts, how many headers came before it, and the
 *   date order already decided. Any other manifest, or an offset where no
 *   header starts, stops the import.
 */
import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../../core/contracts.ts';
import {
  ARCHIVE_COMMON_FINDINGS,
  ArchiveImportStoppedError,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
  type ArchiveFileEntry,
} from '../../../core/archive-formats.ts';
import type { ScopeFileReader } from '../../../core/scope-safe-fs.ts';
import {
  isWhatsAppChatMemberName,
  isWhatsAppStatusChat,
  resolveWhatsAppHeader,
  whatsAppChatNameFromStem,
  whatsAppMediaMarkerCount,
  whatsAppStem,
  type WhatsAppDateOrder,
  type WhatsAppHeader,
} from '../../../core/whatsapp-export-grammar.ts';
import { fileByteSource, type ArchiveByteSource } from '../byte-source.ts';
import { archiveContinuations } from '../continuation-cache.ts';
import { archiveStopFromReaderError } from '../stop-errors.ts';
import {
  ZipArchive,
  ZipFormatError,
  ZipMemberError,
  ZipMemberReader,
  stoppableZipSource,
  zipFindingOffset,
  type ZipEntry,
} from '../zip-reader.ts';
import {
  WhatsAppFormatError,
  WhatsAppMessageReader,
  scanWhatsAppDateOrder,
  type WhatsAppDateOrderScan,
  type WhatsAppRawMessage,
} from './messages.ts';

export const WHATSAPP_ARCHIVE_FORMAT_ID = 'whatsapp_chat';
export const WHATSAPP_CURSOR_PREFIX = 'wa1:';
export const WHATSAPP_DEFAULT_PAGE_SIZE = 100;
export const WHATSAPP_DEFAULT_MAX_BYTES_PER_LISTING = 256 * 1024 * 1024;
const MAX_CHAT_NAME_CHARS = 200;
const GENERIC_CHAT_NAME = 'WhatsApp chat';

export const WHATSAPP_FINDINGS = {
  /** Skipped: a notice from WhatsApp itself (joins, subject changes, encryption). */
  systemMessage: 'system_message',
  /** Skipped: a message with no text. */
  messageEmpty: 'message_empty',
  /** Skipped: the status updates chat is not a conversation. */
  statusUpdates: 'status_updates',
} as const;

/** `d`, `m`, `y`: the order the file's headers show; `a`: day first, assumed; `?`: not read yet. */
type OrderMark = 'd' | 'm' | 'y' | 'a' | '?';

const ORDER_MARKS: readonly string[] = ['d', 'm', 'y', 'a', '?'];

interface Place {
  fileIndex: number;
  /** The member's place in the zip's directory; 0 for a plain file. */
  memberIndex: number;
  /** Where the next message's header line starts in the member. */
  offset: number;
  /** How many header lines lie before it. */
  ordinal: number;
  order: OrderMark;
  /** The stored member's CRC-32 before `offset`, when known. */
  crc?: number;
}

type ParsedCursor = { done: true } | { done: false; place: Place };

function manifestTag(input: ArchiveConnectorInput): string {
  return input.manifestSha256.slice(0, 16);
}

function cursorOf(input: ArchiveConnectorInput, place: Place): string {
  const crc = place.crc !== undefined ? `:${place.crc >>> 0}` : '';
  return `${WHATSAPP_CURSOR_PREFIX}${manifestTag(input)}:${place.fileIndex}:${place.memberIndex}:${place.offset}:${place.ordinal}:${place.order}${crc}`;
}

function doneCursor(input: ArchiveConnectorInput): string {
  return `${WHATSAPP_CURSOR_PREFIX}${manifestTag(input)}:done`;
}

const WHOLE_NUMBER = /^\d{1,16}$/;

function parseCursor(input: ArchiveConnectorInput, cursor: string | undefined): ParsedCursor | undefined {
  if (!cursor) return undefined;
  const invalid = (message: string): ArchiveImportStoppedError =>
    new ArchiveImportStoppedError('resume_point_invalid', message);
  const prefix = `${WHATSAPP_CURSOR_PREFIX}${manifestTag(input)}:`;
  if (!cursor.startsWith(prefix)) {
    throw invalid('The resume point belongs to other files than this archive\'s.');
  }
  const rest = cursor.slice(prefix.length);
  if (rest === 'done') return { done: true };
  const parts = rest.split(':');
  if (parts.length !== 5 && parts.length !== 6) throw invalid('The resume point is not a position in this archive.');
  const [fileText, memberText, offsetText, ordinalText, order, crcText] = parts;
  if (!WHOLE_NUMBER.test(fileText!) || !WHOLE_NUMBER.test(memberText!) || !WHOLE_NUMBER.test(offsetText!)
    || !WHOLE_NUMBER.test(ordinalText!) || !ORDER_MARKS.includes(order!)) {
    throw invalid('The resume point is not a position in this archive.');
  }
  const fileIndex = Number(fileText);
  const memberIndex = Number(memberText);
  const offset = Number(offsetText);
  const ordinal = Number(ordinalText);
  const file = input.files[fileIndex];
  if (!file || (order === '?' && (offset !== 0 || ordinal !== 0 || crcText !== undefined))
    || (!file.members && (memberIndex !== 0 || offset > file.version.size))) {
    throw invalid('The resume point is not a position in this archive.');
  }
  let crc: number | undefined;
  if (crcText !== undefined) {
    if (!WHOLE_NUMBER.test(crcText) || Number(crcText) > 0xffffffff || !file.members) {
      throw invalid('The resume point is not a position in this archive.');
    }
    crc = Number(crcText);
  }
  return {
    done: false,
    place: { fileIndex, memberIndex, offset, ordinal, order: order as OrderMark, ...(crc !== undefined ? { crc } : {}) },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stoppedFrom(error: unknown, relPath: string): unknown {
  if (error instanceof WhatsAppFormatError) {
    return new ArchiveImportStoppedError('resume_point_invalid', 'No message starts where this import was to resume.', relPath);
  }
  return archiveStopFromReaderError(error, relPath);
}

/** The time the phone wrote, read in this computer's zone. */
function localTimeIso(header: WhatsAppHeader): string | undefined {
  const time = new Date(header.year, header.month - 1, header.day, header.hour, header.minute, header.second).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function dateOrderOf(mark: OrderMark): WhatsAppDateOrder {
  return mark === 'm' ? 'mdy' : mark === 'y' ? 'ymd' : 'dmy';
}

function orderMarkOf(order: WhatsAppDateOrder, assumed: boolean): OrderMark {
  if (assumed) return 'a';
  return order === 'mdy' ? 'm' : order === 'ymd' ? 'y' : 'd';
}

function parentFolderName(relPath: string): string | undefined {
  const parts = relPath.split('/').filter((part) => part !== '');
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

function chatNameOf(file: ArchiveFileEntry, entry: ZipEntry | undefined): string {
  const fileStem = whatsAppStem(file.relPath);
  let chat: string | undefined;
  if (entry) {
    const memberStem = whatsAppStem(entry.name);
    chat = whatsAppChatNameFromStem(memberStem)
      ?? whatsAppChatNameFromStem(fileStem)
      ?? (memberStem.toLowerCase() === '_chat' ? fileStem : memberStem);
  } else {
    const parent = parentFolderName(file.relPath);
    chat = whatsAppChatNameFromStem(fileStem)
      ?? (fileStem.toLowerCase() === '_chat'
        ? (parent ? whatsAppChatNameFromStem(parent) : undefined) ?? GENERIC_CHAT_NAME
        : fileStem);
  }
  const trimmed = chat.trim().slice(0, MAX_CHAT_NAME_CHARS).trim();
  return trimmed || GENERIC_CHAT_NAME;
}

/** One chat's text: a plain file, or one chat member of a zip. */
interface Unit {
  fileIndex: number;
  file: ArchiveFileEntry;
  /** The member's place in the zip's directory; 0 for a plain file. */
  memberIndex: number;
  entry?: ZipEntry;
  chat: string;
  conversationId: string;
  /** Names the file and member in message identities. */
  sourceKey: string;
  statusUpdates: boolean;
  /** Uncompressed bytes of the chat text before this unit, in the zip's chat members. */
  base: number;
}

interface FileContext {
  fileIndex: number;
  file: ArchiveFileEntry;
  reader: ScopeFileReader;
  zip?: ZipArchive;
  units: Unit[];
  /** Uncompressed bytes of all the zip's chat members. */
  total: number;
  current(): void;
}

interface Run {
  page: RawItem[];
  /** Something was read since the last page went out: findings, or messages. */
  pending: boolean;
  emitted: number;
  bytesRead: number;
  limit: number;
  /** The listing stops after the page last given out (a budget, or the archive is being removed). */
  stopped: boolean;
  /** The last page of the listing was given out. */
  finished: boolean;
}

interface OpenedSource {
  source: ArchiveByteSource;
  zip?: ZipMemberReader;
  close(): void;
}

function unitSize(unit: Unit): number {
  return unit.entry ? unit.entry.uncompressedSize : unit.file.version.size;
}

function isStored(unit: Unit): boolean {
  return unit.entry !== undefined && unit.entry.method === 0;
}

export function createWhatsAppArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  const pageSizeDefault = Math.max(1, input.pageSize ?? WHATSAPP_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, input.maxBytesPerListing ?? WHATSAPP_DEFAULT_MAX_BYTES_PER_LISTING);
  const tag = manifestTag(input);

  const unitFor = (file: ArchiveFileEntry, fileIndex: number, entry: ZipEntry | undefined, base: number): Unit => {
    const chat = chatNameOf(file, entry);
    return {
      fileIndex,
      file,
      memberIndex: entry ? entry.index : 0,
      ...(entry ? { entry } : {}),
      chat,
      conversationId: `chat:${sha256(chat).slice(0, 24)}`,
      sourceKey: sha256(`${file.relPath}\0${entry ? entry.name : ''}`).slice(0, 16),
      statusUpdates: isWhatsAppStatusChat(chat),
      base,
    };
  };

  /** The zip opened, checked against the table recorded at approval, and its chat members. */
  const openZip = (reader: ScopeFileReader, file: ArchiveFileEntry, fileIndex: number): { zip: ZipArchive; units: Unit[]; total: number } => {
    let zip: ZipArchive;
    const chatEntries: ZipEntry[] = [];
    try {
      zip = ZipArchive.open(stoppableZipSource(reader, file.relPath));
      const table = zip.memberTable();
      if (file.members && (table.count !== file.members.count || table.sha256 !== file.members.sha256)) {
        throw new ArchiveImportStoppedError('file_changed', 'A file of this archive changed since the import started.', file.relPath);
      }
      for (const entry of zip.entries()) {
        if (!entry.isDirectory && isWhatsAppChatMemberName(entry.name)) chatEntries.push(entry);
      }
    } catch (error) {
      if (error instanceof ZipFormatError) {
        throw new ArchiveImportStoppedError('file_unreadable', 'A file of this archive could not be read.', file.relPath);
      }
      throw stoppedFrom(error, file.relPath);
    }
    let base = 0;
    const units = chatEntries.map((entry) => {
      const unit = unitFor(file, fileIndex, entry, base);
      base += entry.uncompressedSize;
      return unit;
    });
    return { zip, units, total: base };
  };

  const openSource = (
    context: FileContext,
    unit: Unit,
    options: { start: number; crc?: number; useParked: boolean },
  ): OpenedSource => {
    if (!context.zip || !unit.entry) {
      return { source: fileByteSource(context.reader, { start: options.start }), close: () => undefined };
    }
    const continuation = options.useParked && options.start > 0 && unit.entry.method === 8
      ? archiveContinuations.take(
        { archiveId: input.archiveId, manifestTag: tag, fileIndex: unit.fileIndex, memberIndex: unit.memberIndex },
        options.start,
      )
      : undefined;
    const reader = ZipMemberReader.open(context.zip, unit.entry, {
      start: options.start,
      ...(options.crc !== undefined ? { startCrc: options.crc } : {}),
      ...(continuation ? { continuation } : {}),
    });
    return { source: reader, zip: reader, close: () => reader.close() };
  };

  const findingOffsetOf = (context: FileContext, unit: Unit, offset: number): number =>
    context.zip ? zipFindingOffset(unit.memberIndex, offset) : offset;

  /** Where a position in a unit stands in the file, for the percent shown. */
  const progressOffset = (context: FileContext, unit: Unit, offset: number): number => {
    if (!context.zip) return Math.min(offset, context.file.version.size);
    const done = Math.min(unit.base + Math.min(offset, unitSize(unit)), context.total);
    return Math.floor((context.file.version.size * done) / Math.max(1, context.total));
  };

  const itemOf = (unit: Unit, raw: WhatsAppRawMessage, header: WhatsAppHeader): RawItem => {
    const sender = raw.sender!;
    const text = raw.text;
    const textHash = sha256(text);
    const providerItemId = sha256([unit.sourceKey, unit.chat, header.sentAt, sender, String(raw.ordinal), textHash].join('\0')).slice(0, 32);
    const authoredAt = localTimeIso(header);
    return {
      identity: {
        family: input.format.family,
        provider: input.format.provider,
        accountScope: input.accountScope,
        providerItemId,
        providerThreadId: unit.conversationId,
        providerConversationId: unit.conversationId,
        localItemId: `${input.accountScope}:${providerItemId}`,
        sourceVersion: textHash.slice(0, 32),
      },
      mimeType: 'text/plain',
      content: { kind: 'text', text },
      metadata: Object.freeze({
        chat: unit.chat,
        sender,
        senderLabel: sender,
        ...(authoredAt ? { authoredAt } : {}),
        contentHash: textHash,
      }),
      fetchedAt: new Date().toISOString(),
    };
  };

  return {
    id: input.connectorId,
    family: input.format.family,
    async authenticate(): Promise<void> {
      // No account: the approved files are the whole grant.
    },
    listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const parsed = parseCursor(input, options?.cursor);
        if (parsed?.done) {
          yield { items: [], nextCursor: doneCursor(input), done: true };
          return;
        }
        const start = parsed?.place;
        const run: Run = {
          page: [],
          pending: false,
          emitted: 0,
          bytesRead: 0,
          limit: options?.limit !== undefined && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY,
          stopped: false,
          finished: false,
        };
        // Said once per archive, before anything else it reports.
        if (!start) input.report({ kind: ARCHIVE_COMMON_FINDINGS.assumption, class: 'gap', fileIndex: 0, offset: 0 });

        // What was left out, by kind, and where the first of each was: told in
        // one finding per kind at each page, so a file of notices stays small.
        const skips = new Map<string, { offset: number; count: number }>();
        const noteSkip = (kind: string, offset: number): void => {
          const seen = skips.get(kind);
          if (seen) seen.count += 1;
          else skips.set(kind, { offset, count: 1 });
        };

        async function* readUnit(context: FileContext, index: number, place: Place): AsyncGenerator<SourceConnectorListPage> {
          const unit = context.units[index]!;
          const report = (kind: string, findingClass: 'gap' | 'skipped', offset: number, count?: number): void => {
            input.report({
              kind,
              class: findingClass,
              fileIndex: unit.fileIndex,
              offset: findingOffsetOf(context, unit, offset),
              ...(count !== undefined ? { count } : {}),
            });
          };
          const flushSkips = (): void => {
            for (const [kind, seen] of skips) report(kind, 'skipped', seen.offset, seen.count);
            skips.clear();
          };
          const isLastFile = unit.fileIndex === input.files.length - 1;
          const isLastUnit = index === context.units.length - 1;
          const afterUnit: Place = index + 1 < context.units.length
            ? { fileIndex: unit.fileIndex, memberIndex: context.units[index + 1]!.memberIndex, offset: 0, ordinal: 0, order: '?' }
            : { fileIndex: unit.fileIndex + 1, memberIndex: 0, offset: 0, ordinal: 0, order: '?' };
          const progressAfterUnit = index + 1 < context.units.length
            ? progressOffset(context, context.units[index + 1]!, 0)
            : context.file.version.size;
          const damaged = (error: ZipMemberError, offset: number): void => {
            report(error.code === 'damaged' ? ARCHIVE_COMMON_FINDINGS.fileDamaged : ARCHIVE_COMMON_FINDINGS.sectionNotImported, 'gap', offset);
          };

          // The date order: read from the headers where the unit begins, carried in the resume point after.
          let unreadable = false;
          let order = place.order;
          if (order === '?') {
            let scanned: WhatsAppDateOrderScan | undefined;
            let scanSource: OpenedSource | undefined;
            try {
              scanSource = openSource(context, unit, { start: 0, useParked: false });
              scanned = scanWhatsAppDateOrder(scanSource.source, { shouldContinue: input.shouldContinue });
            } catch (error) {
              if (!(error instanceof ZipMemberError)) throw stoppedFrom(error, unit.file.relPath);
              damaged(error, 0);
              unreadable = true;
            } finally {
              scanSource?.close();
            }
            if (!unreadable) {
              if (!scanned) {
                // Asked to stop before anything of this unit was read.
                run.stopped = true;
                return;
              }
              order = orderMarkOf(scanned.order, scanned.assumed);
              if (scanned.assumed) report(ARCHIVE_COMMON_FINDINGS.assumption, 'gap', 0);
            }
          }

          let opened: OpenedSource | undefined;
          let messages: WhatsAppMessageReader | undefined;
          if (!unreadable) {
            try {
              opened = openSource(context, unit, {
                start: place.offset,
                ...(place.crc !== undefined ? { crc: place.crc } : {}),
                useParked: true,
              });
              messages = new WhatsAppMessageReader(opened.source, {
                startOrdinal: place.ordinal,
                requireHeaderFirst: place.offset > 0,
              });
            } catch (error) {
              opened?.close();
              opened = undefined;
              if (!(error instanceof ZipMemberError)) throw stoppedFrom(error, unit.file.relPath);
              damaged(error, place.offset);
            }
          }

          const dateOrder = dateOrderOf(order);
          let yieldedAt: number | undefined;
          let clean = true;
          let ended = messages === undefined;
          let mark = opened?.source.position ?? 0;
          const placeOf = (pending: { offset: number; ordinal: number }, crc: number | undefined): Place => ({
            fileIndex: unit.fileIndex,
            memberIndex: unit.memberIndex,
            offset: pending.offset,
            ordinal: pending.ordinal,
            order,
            ...(crc !== undefined ? { crc } : {}),
          });
          try {
            while (messages && opened && !ended) {
              if (!input.shouldContinue()) {
                run.stopped = true;
                const at = messages.pending;
                if (run.pending && at) {
                  flushSkips();
                  context.current();
                  input.reportPosition?.({ fileIndex: unit.fileIndex, offset: progressOffset(context, unit, at.offset) });
                  yieldedAt = at.offset;
                  yield {
                    items: run.page,
                    nextCursor: cursorOf(input, placeOf(at, isStored(unit) ? messages.pendingCrc() : undefined)),
                    done: false,
                  };
                  run.emitted += run.page.length;
                  run.page = [];
                  run.pending = false;
                }
                return;
              }
              let raw: WhatsAppRawMessage | undefined;
              try {
                raw = messages.next();
              } catch (error) {
                if (error instanceof ZipMemberError) {
                  // What was read stays; the rest of this member cannot be.
                  clean = false;
                  damaged(error, messages.pending?.offset ?? mark);
                  raw = undefined;
                  ended = true;
                  break;
                }
                clean = false;
                throw stoppedFrom(error, unit.file.relPath);
              }
              run.bytesRead += Math.max(0, opened.source.position - mark);
              mark = opened.source.position;
              if (!raw) {
                ended = true;
                break;
              }
              run.pending = true;

              // What this message is.
              if (unit.statusUpdates) {
                noteSkip(WHATSAPP_FINDINGS.statusUpdates, raw.offset);
              } else if (raw.sender === undefined) {
                noteSkip(WHATSAPP_FINDINGS.systemMessage, raw.offset);
              } else if (raw.text.trim() === '') {
                noteSkip(WHATSAPP_FINDINGS.messageEmpty, raw.offset);
              } else {
                const header = resolveWhatsAppHeader(raw.header, dateOrder);
                if (!header) {
                  noteSkip(WHATSAPP_FINDINGS.messageEmpty, raw.offset);
                } else {
                  run.page.push(itemOf(unit, raw, header));
                  const media = whatsAppMediaMarkerCount(raw.text);
                  if (media > 0) report(ARCHIVE_COMMON_FINDINGS.mediaNotImported, 'gap', raw.offset, media);
                  if (raw.cut) report(ARCHIVE_COMMON_FINDINGS.itemTruncated, 'gap', raw.offset);
                }
              }

              // A page goes out when it is full, or the budget is spent.
              const at = messages.pending;
              if (!at) continue;
              const room = run.limit - run.emitted;
              const full = run.page.length >= Math.min(pageSizeDefault, room);
              const spent = run.bytesRead >= byteBudget;
              if (!full && !spent) continue;
              // The listing ends with this page: its budget is spent or it holds all the items it may.
              const atLimit = run.page.length >= room;
              const last = spent || atLimit;
              // Ending here parks the member's inflater at the next message,
              // which needs that message to start in the chunk just read; if
              // it does not, read on to the one after (never past the item
              // limit: a page may not hold more than it was asked for).
              if (last && !atLimit && context.zip && !messages.canSettle()) continue;
              flushSkips();
              context.current();
              input.reportPosition?.({ fileIndex: unit.fileIndex, offset: progressOffset(context, unit, at.offset) });
              yieldedAt = at.offset;
              yield {
                items: run.page,
                nextCursor: cursorOf(input, placeOf(at, isStored(unit) ? messages.pendingCrc() : undefined)),
                done: false,
              };
              run.emitted += run.page.length;
              run.page = [];
              run.pending = false;
              if (last) {
                run.stopped = true;
                return;
              }
            }

            // The unit has been read to its end.
            if (messages && opened?.zip) {
              const end = opened.zip.end;
              if (end && (!end.sizeOk || end.crcOk === false)) {
                report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', unitSize(unit));
              }
            }
            flushSkips();
            context.current();
            if (isLastFile && isLastUnit) {
              yield { items: run.page, nextCursor: doneCursor(input), done: true };
              run.page = [];
              run.finished = true;
              return;
            }
            if (run.pending) {
              input.reportPosition?.({ fileIndex: unit.fileIndex, offset: progressAfterUnit });
              yield { items: run.page, nextCursor: cursorOf(input, afterUnit), done: false };
              run.emitted += run.page.length;
              run.page = [];
              run.pending = false;
              if (run.emitted >= run.limit || run.bytesRead >= byteBudget) run.stopped = true;
            }
          } finally {
            try {
              // The listing stopped at a page's resume point: keep the inflater exactly there.
              if (clean && !ended && messages && opened?.zip && yieldedAt !== undefined) {
                const pending = messages.pending;
                if (pending && pending.offset === yieldedAt && messages.settle()) {
                  const continuation = opened.zip.suspend();
                  if (continuation) {
                    archiveContinuations.put(
                      { archiveId: input.archiveId, manifestTag: tag, fileIndex: unit.fileIndex, memberIndex: unit.memberIndex },
                      continuation,
                    );
                  }
                }
              }
            } finally {
              opened?.close();
            }
          }
        }

        async function* readFile(fileIndex: number, at: Place | undefined): AsyncGenerator<SourceConnectorListPage> {
          const file = input.files[fileIndex]!;
          let reader: ScopeFileReader;
          try {
            reader = input.root.openFile(file.relPath, { expected: file.version });
          } catch (error) {
            throw stoppedFrom(error, file.relPath);
          }
          try {
            const context: FileContext = {
              fileIndex,
              file,
              reader,
              units: [],
              total: 0,
              current: () => {
                try {
                  reader.assertCurrent();
                } catch (error) {
                  throw stoppedFrom(error, file.relPath);
                }
              },
            };
            if (file.members) {
              const opened = openZip(reader, file, fileIndex);
              context.zip = opened.zip;
              context.units = opened.units;
              context.total = opened.total;
            } else {
              context.units = [unitFor(file, fileIndex, undefined, 0)];
              context.total = file.version.size;
            }
            // Where in the file to begin: an exact member for a position inside one, else the first from there.
            let first = 0;
            if (at) {
              const exact = at.order !== '?';
              first = context.units.findIndex((unit) => (exact ? unit.memberIndex === at.memberIndex : unit.memberIndex >= at.memberIndex));
              if (first < 0) {
                if (exact) throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point is not a position in this archive.', file.relPath);
                first = context.units.length;
              }
              const unit = context.units[first];
              if (exact && unit && at.offset > unitSize(unit)) {
                throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point is not a position in this archive.', file.relPath);
              }
            }
            for (let index = first; index < context.units.length; index += 1) {
              const place: Place = at && index === first && at.order !== '?'
                ? at
                : { fileIndex, memberIndex: context.units[index]!.memberIndex, offset: 0, ordinal: 0, order: '?' };
              yield* readUnit(context, index, place);
              if (run.stopped || run.finished) return;
            }
            context.current();
          } finally {
            reader.close();
          }
        }

        for (let fileIndex = start?.fileIndex ?? 0; fileIndex < input.files.length; fileIndex += 1) {
          yield* readFile(fileIndex, start && start.fileIndex === fileIndex ? start : undefined);
          if (run.stopped || run.finished) return;
        }
        // The last files held no chat at all.
        yield { items: run.page, nextCursor: doneCursor(input), done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> {
      throw new Error('An imported message is read only while its archive is listed.');
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      const chat = typeof item.metadata.chat === 'string' && item.metadata.chat ? item.metadata.chat : undefined;
      const sender = typeof item.metadata.sender === 'string' && item.metadata.sender ? item.metadata.sender : undefined;
      return {
        ...(chat ? { title: chat } : {}),
        ...(sender ? { sender } : {}),
      };
    },
  };
}

/** Registers the WhatsApp export connector with the format registry. Idempotent. */
export function registerWhatsAppArchiveConnector(): void {
  registerArchiveFormatConnector(WHATSAPP_ARCHIVE_FORMAT_ID, createWhatsAppArchiveConnector);
}
