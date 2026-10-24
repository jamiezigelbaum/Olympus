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
 * - Identity: the chat, the written time, the sender, a hash of the text and
 *   the message's number among the identical ones sent at that time. Not the
 *   file it came from: a .txt and a .zip of one chat hold the same messages,
 *   and each is imported once (the import counts the repeats it meets). The
 *   file and member a message was last read from are in its metadata.
 * - Time: the export writes wall time with no zone, and in the order the
 *   phone's locale uses. The order is read from the file's own headers (the
 *   order most of them say; one pasted header does not decide) and, when
 *   nothing does, taken as day first and said so. The time is read in this
 *   computer's zone, and that is said once per archive. A header written in
 *   another style than the file's, or dated before the one above it, may be a
 *   header pasted into a message: it still starts a message (the format
 *   cannot say otherwise) and is counted as an assumption.
 * - Left out, and counted: notices from WhatsApp itself, messages with no
 *   text, and the status updates chat. Media is named in the message's text
 *   and counted as not imported. A message longer than the bound is cut and
 *   counted.
 * - Bounded reads: a pass reads at most its byte budget, plus at most one
 *   message (MAX_MESSAGE_BYTES) or one scan (ORDER_SCAN_MAX_BYTES). The date
 *   scan, entering a deflated member somewhere other than its start (the
 *   inflater catches up), and every byte read and dropped after a message
 *   was cut count toward the budget, and the last of these can stop at any
 *   chunk: the resume point then says where, inside the lines being dropped.
 * - Changes: each page goes out only while its file is still the version
 *   opened, under the descriptor and at its name; a file changed, replaced or
 *   removed after the first page stops the import, whatever was buffered.
 * - Resume point: see `place.ts`. Any other manifest, or a place where no
 *   header starts, stops the import. A stored member carries the checksum of
 *   everything before its place, so it is verified at its end however many
 *   passes read it; a member whose checksum could not be verified is told as
 *   damaged, never taken as good.
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
import { fileByteSource, type ArchiveByteSource } from '../byte-source.ts';
import { archiveContinuations } from '../continuation-cache.ts';
import { archiveStopFromScopeError } from '../stop-errors.ts';
import {
  ZipArchive,
  ZipFormatError,
  ZipMemberError,
  ZIP_REPLAY_STEP_BYTES,
  ZipMemberReader,
  readZipMemberHead,
  stoppableZipSource,
  zipFindingOffset,
  type ZipEntry,
} from '../zip-reader.ts';
import {
  WHATSAPP_HEAD_BYTES,
  hasWhatsAppExportName,
  isWhatsAppStatusChat,
  isWhatsAppZipNoise,
  looksLikeWhatsAppChat,
  resolveWhatsAppHeader,
  whatsAppChatNameFromStem,
  whatsAppMediaMarkerCount,
  whatsAppStem,
  type WhatsAppDateOrder,
  type WhatsAppHeader,
} from './grammar.ts';
import {
  WhatsAppFormatError,
  WhatsAppMessageReader,
  scanWhatsAppDateOrder,
  type WhatsAppEntry,
  type WhatsAppMessageStep,
  type WhatsAppRawMessage,
  type WhatsAppResumePoint,
} from './messages.ts';
import {
  IdentityWindow,
  WHATSAPP_CURSOR_PREFIX,
  cursorOf,
  doneCursor,
  manifestTag,
  parseCursor,
  type OrderMark,
  type Place,
  type PlaceMode,
} from './place.ts';

export { WHATSAPP_CURSOR_PREFIX };
export const WHATSAPP_ARCHIVE_FORMAT_ID = 'whatsapp_chat';
export const WHATSAPP_DEFAULT_PAGE_SIZE = 100;
export const WHATSAPP_DEFAULT_MAX_BYTES_PER_LISTING = 256 * 1024 * 1024;
const MAX_CHAT_NAME_CHARS = 200;
const GENERIC_CHAT_NAME = 'WhatsApp chat';
/** Text members of a chosen zip looked at for a chat when none is named like one. */
const MAX_UNNAMED_MEMBER_PROBES = 64;

export const WHATSAPP_FINDINGS = {
  /** Skipped: a notice from WhatsApp itself (joins, subject changes, encryption). */
  systemMessage: 'system_message',
  /** Skipped: a message with no text. */
  messageEmpty: 'message_empty',
  /** Skipped: the status updates chat is not a conversation. */
  statusUpdates: 'status_updates',
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stoppedFrom(error: unknown, relPath: string): unknown {
  if (error instanceof WhatsAppFormatError) {
    return new ArchiveImportStoppedError('resume_point_invalid', 'No message starts where this import was to resume.', relPath);
  }
  return archiveStopFromScopeError(error, relPath);
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

/**
 * The chat a file or member stands for. An iOS member is always `_chat.txt`,
 * so its chat comes from the folder it sits in when that folder names one, then
 * from the zip's own name; when the zip holds several `_chat.txt` in their own
 * folders (`severalChatFiles`), each folder is its chat, so two chats in one zip
 * are never read as one.
 */
function chatNameOf(file: ArchiveFileEntry, entry: ZipEntry | undefined, severalChatFiles = false): string {
  const fileStem = whatsAppStem(file.relPath);
  let chat: string | undefined;
  if (entry) {
    const memberStem = whatsAppStem(entry.name);
    const chatFile = memberStem.toLowerCase() === '_chat';
    const folder = chatFile ? parentFolderName(entry.name) : undefined;
    chat = whatsAppChatNameFromStem(memberStem)
      ?? (folder ? whatsAppChatNameFromStem(folder) : undefined)
      ?? (severalChatFiles ? folder : undefined)
      ?? whatsAppChatNameFromStem(fileStem)
      ?? (chatFile ? fileStem : memberStem);
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
  /** Names the file and member where a message is told apart by position. */
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
  /** Where each item of `page` is in the archive, for the import to count repeats by position. */
  positions: Array<{ fileIndex: number; offset: number }>;
  /** Something was read since the last page went out: findings, or messages. */
  pending: boolean;
  emitted: number;
  /** Everything read this pass: the date scan, an inflater catching up, messages, dropped bytes. */
  bytesRead: number;
  /** A read, or a message, was done this pass: the budget may stop the pass only after this, so each pass moves on. */
  progressed: boolean;
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

function isDeflated(unit: Unit): boolean {
  return unit.entry !== undefined && unit.entry.method === 8;
}

function entryFor(mode: PlaceMode): WhatsAppEntry {
  return mode === 'start' ? { kind: 'start' } : mode === 'message' ? { kind: 'message' } : { kind: 'skip', midLine: mode === 'mid' };
}

export function createWhatsAppArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  const pageSizeDefault = Math.max(1, input.pageSize ?? WHATSAPP_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, input.maxBytesPerListing ?? WHATSAPP_DEFAULT_MAX_BYTES_PER_LISTING);
  const tag = manifestTag(input);

  const unitFor = (file: ArchiveFileEntry, fileIndex: number, entry: ZipEntry | undefined, base: number, severalChatFiles = false): Unit => {
    const chat = chatNameOf(file, entry, severalChatFiles);
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

  /**
   * The chat members of a zip: those named the way WhatsApp names the text of
   * an export and starting like a chat. A zip with none (one the person chose,
   * whose text file has another name, or whose `_chat.txt` is not a chat)
   * takes its other text members that start like a chat, the same ones that
   * made it an export. With neither, the named members are read as they are.
   */
  const chatEntries = (zip: ZipArchive): ZipEntry[] => {
    const all = [...zip.entries()].filter((entry) => !entry.isDirectory);
    const startsLikeChat = (entry: ZipEntry) => looksLikeWhatsAppChat(readZipMemberHead(zip, entry, WHATSAPP_HEAD_BYTES));
    // Set aside only a named member read and found not to be a chat: one that cannot be read stays, to be told as a gap.
    const readAndNotChat = (entry: ZipEntry) => {
      const head = readZipMemberHead(zip, entry, WHATSAPP_HEAD_BYTES);
      return head !== undefined && !looksLikeWhatsAppChat(head);
    };
    const named = all.filter((entry) => hasWhatsAppExportName(entry.name));
    const namedChats = named.filter((entry) => !readAndNotChat(entry));
    if (namedChats.length > 0) return namedChats;
    const others = all
      .filter((entry) => !hasWhatsAppExportName(entry.name) && !isWhatsAppZipNoise(entry.name) && entry.name.toLowerCase().endsWith('.txt'))
      .slice(0, MAX_UNNAMED_MEMBER_PROBES)
      .filter(startsLikeChat);
    return others.length > 0 ? others : named;
  };

  /** The zip opened, checked against the table recorded at approval, and its chat members. */
  const openZip = (reader: ScopeFileReader, file: ArchiveFileEntry, fileIndex: number): { zip: ZipArchive; units: Unit[]; total: number } => {
    let zip: ZipArchive;
    let entries: ZipEntry[];
    try {
      zip = ZipArchive.open(stoppableZipSource(reader, file.relPath));
      const table = zip.memberTable();
      if (file.members && (table.count !== file.members.count || table.sha256 !== file.members.sha256)) {
        throw new ArchiveImportStoppedError('file_changed', 'A file of this archive changed since the import started.', file.relPath);
      }
      entries = chatEntries(zip);
    } catch (error) {
      if (error instanceof ZipFormatError) {
        throw new ArchiveImportStoppedError('file_unreadable', 'A file of this archive could not be read.', file.relPath);
      }
      throw stoppedFrom(error, file.relPath);
    }
    let base = 0;
    const severalChatFiles = entries.filter((entry) => whatsAppStem(entry.name).toLowerCase() === '_chat').length > 1;
    const units = entries.map((entry) => {
      const unit = unitFor(file, fileIndex, entry, base, severalChatFiles);
      base += entry.uncompressedSize;
      return unit;
    });
    return { zip, units, total: base };
  };

  /** Where a deflated member's inflater is parked between passes. */
  const parkingKey = (unit: Unit) =>
    ({ archiveId: input.archiveId, manifestTag: tag, fileIndex: unit.fileIndex, memberIndex: unit.memberIndex });

  const openSource = (
    context: FileContext,
    unit: Unit,
    options: { start: number; crc?: number; useParked: boolean },
  ): OpenedSource => {
    if (!context.zip || !unit.entry) {
      return { source: fileByteSource(context.reader, { start: options.start }), close: () => undefined };
    }
    const continuation = options.useParked && options.start > 0 && unit.entry.method === 8
      ? archiveContinuations.take(parkingKey(unit), options.start)
      : undefined;
    const reader = ZipMemberReader.open(context.zip, unit.entry, {
      start: options.start,
      // Getting an inflater to a place deep in a member is done in steps, each asked against the pass budget.
      replayStepBytes: Math.min(ZIP_REPLAY_STEP_BYTES, byteBudget),
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

  const itemOf = (unit: Unit, raw: WhatsAppRawMessage, header: WhatsAppHeader, textHash: string, sameAtTime: number | undefined): RawItem => {
    const sender = raw.sender!;
    // Alike messages are told apart by their number among the alike at that time; a time too crowded
    // for that is told apart by where the message is in its file (stable, but not shared by another file).
    const apart = sameAtTime !== undefined ? `#${sameAtTime}` : `@${unit.sourceKey}:${raw.offset}`;
    const providerItemId = sha256([unit.chat, header.sentAt, sender, textHash, apart].join('\0')).slice(0, 32);
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
      content: { kind: 'text', text: raw.text },
      metadata: Object.freeze({
        chat: unit.chat,
        sender,
        senderLabel: sender,
        ...(authoredAt ? { authoredAt } : {}),
        contentHash: textHash,
        // The export this copy of the message was read from.
        sourceFile: unit.file.relPath,
        ...(unit.entry ? { sourceMember: unit.entry.name } : {}),
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
          positions: [],
          pending: false,
          emitted: 0,
          bytesRead: 0,
          progressed: false,
          limit: options?.limit !== undefined && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY,
          stopped: false,
          finished: false,
        };
        // The items of the page going out, with their positions told first.
        const pageItems = (): RawItem[] => {
          input.reportItemPositions?.(run.positions);
          run.positions = [];
          return run.page;
        };
        // Said once per archive, before anything else it reports.
        if (!start) input.report({ kind: ARCHIVE_COMMON_FINDINGS.assumption, class: 'gap', fileIndex: 0, offset: 0 });

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
          // What was left out or assumed, by kind, and where each one was: told in one finding per kind at each
          // page, so a file of notices stays small. The finding carries every occurrence's place (`at`), so a
          // replay whose pages are cut differently counts each one once however the tallies fall.
          const tallies = new Map<string, { kind: string; findingClass: 'gap' | 'skipped'; at: number[] }>();
          const note = (kind: string, findingClass: 'gap' | 'skipped', offset: number): void => {
            const key = `${findingClass}:${kind}`;
            const place = findingOffsetOf(context, unit, offset);
            const seen = tallies.get(key);
            if (seen) seen.at.push(place);
            else tallies.set(key, { kind, findingClass, at: [place] });
          };
          const flushTallies = (): void => {
            for (const seen of tallies.values()) {
              input.report({
                kind: seen.kind,
                class: seen.findingClass,
                fileIndex: unit.fileIndex,
                offset: seen.at[0]!,
                count: seen.at.length,
                ...(seen.at.length > 1 ? { at: seen.at } : {}),
              });
            }
            tallies.clear();
          };
          const isLastFile = unit.fileIndex === input.files.length - 1;
          const isLastUnit = index === context.units.length - 1;
          const afterUnit: Place = index + 1 < context.units.length
            ? { fileIndex: unit.fileIndex, memberIndex: context.units[index + 1]!.memberIndex, offset: 0, mode: 'start', order: '?', style: '', prev: '' }
            : { fileIndex: unit.fileIndex + 1, memberIndex: 0, offset: 0, mode: 'start', order: '?', style: '', prev: '' };
          const progressAfterUnit = index + 1 < context.units.length
            ? progressOffset(context, context.units[index + 1]!, 0)
            : context.file.version.size;
          const damaged = (error: ZipMemberError, offset: number): void => {
            report(error.code === 'damaged' ? ARCHIVE_COMMON_FINDINGS.fileDamaged : ARCHIVE_COMMON_FINDINGS.sectionNotImported, 'gap', offset);
          };

          let unreadable = false;
          let order: OrderMark = place.order;
          let style = place.style;
          let prev = place.prev;
          const window = IdentityWindow.restore(place.window);

          // The date order and the file's style: read from the headers where the unit begins,
          // carried in the resume point after. A bounded read, and it counts toward the budget.
          if (place.mode === 'start') {
            if (!input.shouldContinue()) {
              run.stopped = true;
              return;
            }
            let scanSource: OpenedSource | undefined;
            try {
              scanSource = openSource(context, unit, { start: 0, useParked: false });
              const scanned = scanWhatsAppDateOrder(scanSource.source);
              run.bytesRead += scanned.bytesRead;
              run.progressed = true;
              order = orderMarkOf(scanned.order, scanned.assumed);
              style = scanned.style ?? '';
              if (scanned.assumed) report(ARCHIVE_COMMON_FINDINGS.assumption, 'gap', 0);
            } catch (error) {
              if (!(error instanceof ZipMemberError)) throw stoppedFrom(error, unit.file.relPath);
              damaged(error, 0);
              unreadable = true;
            } finally {
              scanSource?.close();
            }
          }

          let opened: OpenedSource | undefined;
          let reader: WhatsAppMessageReader | undefined;
          if (!unreadable) {
            try {
              opened = openSource(context, unit, {
                start: place.offset,
                ...(place.crc !== undefined ? { crc: place.crc } : {}),
                useParked: place.mode !== 'start',
              });
              reader = new WhatsAppMessageReader(opened.source, entryFor(place.mode));
            } catch (error) {
              opened?.close();
              opened = undefined;
              if (!(error instanceof ZipMemberError)) throw stoppedFrom(error, unit.file.relPath);
              damaged(error, place.offset);
            }
          }

          // Bytes the source delivered, and an inflater's catching up, are spent as they are read.
          const source = opened?.source;
          let mark = source?.position ?? 0;
          let replayCounted = 0;
          const spend = (): void => {
            if (!source) return;
            run.bytesRead += Math.max(0, source.position - mark);
            mark = source.position;
            const replayed = opened?.zip?.replayedBytes ?? 0;
            run.bytesRead += replayed - replayCounted;
            replayCounted = replayed;
          };
          // Asked before each read of bytes that are only dropped (the rest of a message that was cut):
          // the pass may end there, once it has moved on at all.
          const mayRead = (): boolean => {
            spend();
            if (!input.shouldContinue()) return false;
            if (run.bytesRead >= byteBudget && run.progressed) return false;
            run.progressed = true;
            return true;
          };

          const dateOrder = dateOrderOf(order);
          let yieldedAt: number | undefined;
          let clean = true;
          let ended = reader === undefined;
          const placeFrom = (point: WhatsAppResumePoint): Place => {
            const crc = isStored(unit) ? point.crc : undefined;
            if (isStored(unit) && crc === undefined) {
              throw new ArchiveImportStoppedError('resume_point_invalid', 'The checksum of a stored file could not be followed to this place.', unit.file.relPath);
            }
            const state = window.state();
            return {
              fileIndex: unit.fileIndex,
              memberIndex: unit.memberIndex,
              offset: point.offset,
              mode: point.kind === 'message' ? 'message' : point.midLine ? 'mid' : 'skip',
              order,
              style,
              prev,
              ...(state ? { window: state } : {}),
              ...(crc !== undefined ? { crc } : {}),
            };
          };
          const handOver = function* (at: WhatsAppResumePoint): Generator<SourceConnectorListPage> {
            flushTallies();
            context.current();
            input.reportPosition?.({ fileIndex: unit.fileIndex, offset: progressOffset(context, unit, at.offset) });
            yieldedAt = at.offset;
            yield { items: pageItems(), nextCursor: cursorOf(input, placeFrom(at)), done: false };
            run.emitted += run.page.length;
            run.page = [];
            run.pending = false;
          };

          try {
            // An inflater entered part-way catches up first, a step at a time, and the pass budget is asked
            // between steps. When it is spent the inflater is parked where it got to and the next pass goes
            // on from there (with nothing parked, the catch-up starts over).
            while (opened?.zip?.catchingUp) {
              if (!mayRead()) {
                run.stopped = true;
                const continuation = opened.zip.suspend();
                if (continuation) archiveContinuations.put(parkingKey(unit), continuation);
                if (input.shouldContinue()) {
                  context.current();
                  yield { items: [], nextCursor: cursorOf(input, place), done: false };
                }
                return;
              }
              try {
                opened.zip.catchUp();
              } catch (error) {
                clean = false;
                if (!(error instanceof ZipMemberError)) throw stoppedFrom(error, unit.file.relPath);
                damaged(error, place.offset);
                ended = true;
                break;
              }
            }
            spend();
            while (reader && opened && !ended) {
              if (!input.shouldContinue()) {
                run.stopped = true;
                const at = reader.resume();
                if (run.pending && at) yield* handOver(at);
                return;
              }
              let step: WhatsAppMessageStep;
              try {
                step = reader.next(mayRead);
              } catch (error) {
                if (error instanceof ZipMemberError) {
                  // What was read stays; the rest of this member cannot be.
                  clean = false;
                  damaged(error, reader.resume()?.offset ?? mark);
                  ended = true;
                  break;
                }
                clean = false;
                throw stoppedFrom(error, unit.file.relPath);
              }
              spend();
              if (step.kind === 'end') {
                ended = true;
                break;
              }
              if (step.kind === 'paused') {
                // Only dropped bytes were being read and the budget is spent: end the pass here.
                const at = reader.resume();
                run.stopped = true;
                if (at) yield* handOver(at);
                return;
              }
              const raw = step.message;
              run.progressed = true;
              run.pending = true;

              // Does this header belong to this file's export? A header in another style than the
              // file's, or dated before the one above it, may have been pasted into a message by hand.
              const header = resolveWhatsAppHeader(raw.header, dateOrder);
              const otherStyle = style !== '' && raw.header.style !== style;
              if (otherStyle || (header && prev !== '' && header.sentAt < prev)) {
                note(ARCHIVE_COMMON_FINDINGS.assumption, 'gap', raw.offset);
              }
              if (header && !otherStyle) prev = header.sentAt;

              // What this message is.
              if (unit.statusUpdates) {
                note(WHATSAPP_FINDINGS.statusUpdates, 'skipped', raw.offset);
              } else if (raw.sender === undefined) {
                note(WHATSAPP_FINDINGS.systemMessage, 'skipped', raw.offset);
              } else if (raw.text.trim() === '' || !header) {
                note(WHATSAPP_FINDINGS.messageEmpty, 'skipped', raw.offset);
              } else {
                const textHash = sha256(raw.text);
                const sameAtTime = window.ordinal(header.sentAt, sha256(`${raw.sender}\0${textHash}`).slice(0, 12));
                run.page.push(itemOf(unit, raw, header, textHash, sameAtTime));
                run.positions.push({ fileIndex: unit.fileIndex, offset: findingOffsetOf(context, unit, raw.offset) });
                const media = whatsAppMediaMarkerCount(raw.text);
                if (media > 0) report(ARCHIVE_COMMON_FINDINGS.mediaNotImported, 'gap', raw.offset, media);
                if (raw.cut) report(ARCHIVE_COMMON_FINDINGS.itemTruncated, 'gap', raw.offset);
              }

              // A page goes out when it is full, or the budget is spent.
              const at = reader.resume();
              if (!at) continue;
              const room = run.limit - run.emitted;
              const full = run.page.length >= Math.min(pageSizeDefault, room);
              const spent = run.bytesRead >= byteBudget;
              if (!full && !spent) continue;
              // The listing ends with this page: its budget is spent or it holds all the items it may.
              // A deflated member's inflater is parked at the resume point when that point lies in the
              // chunk just read (the usual case); when it does not (a line longer than a chunk), the next
              // pass enters the member cold and pays for the replay out of its own budget. The pass never
              // reads on to make the parking possible: its reads stay inside the budget.
              const last = spent || run.page.length >= room;
              yield* handOver(at);
              if (last) {
                run.stopped = true;
                return;
              }
            }

            // The unit has been read to its end (a member found damaged was told so where it was).
            if (clean && reader && opened?.zip) {
              const end = opened.zip.end;
              // A member whose checksum was not verified is not a member that checked out.
              if (!end || !end.sizeOk || end.crcOk !== true) {
                report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', unitSize(unit));
              }
            }
            flushTallies();
            context.current();
            if (isLastFile && isLastUnit) {
              input.reportPosition?.({ fileIndex: unit.fileIndex, offset: context.file.version.size });
              yield { items: pageItems(), nextCursor: doneCursor(input), done: true };
              run.page = [];
              run.finished = true;
              return;
            }
            if (run.pending) {
              input.reportPosition?.({ fileIndex: unit.fileIndex, offset: progressAfterUnit });
              yield { items: pageItems(), nextCursor: cursorOf(input, afterUnit), done: false };
              run.emitted += run.page.length;
              run.page = [];
              run.pending = false;
              if (run.emitted >= run.limit || run.bytesRead >= byteBudget) run.stopped = true;
            }
          } finally {
            try {
              // The listing stopped at a page's resume point: keep the inflater exactly there.
              if (clean && !ended && reader && opened?.zip && yieldedAt !== undefined) {
                const pending = reader.resume();
                if (pending && pending.offset === yieldedAt && reader.settle()) {
                  const continuation = opened.zip.suspend();
                  if (continuation) {
                    archiveContinuations.put(parkingKey(unit), continuation);
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
              const exact = at.mode !== 'start';
              first = context.units.findIndex((unit) => (exact ? unit.memberIndex === at.memberIndex : unit.memberIndex >= at.memberIndex));
              if (first < 0) {
                if (exact) throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point is not a position in this archive.', file.relPath);
                first = context.units.length;
              }
              const unit = context.units[first];
              if (exact && unit && (at.offset > unitSize(unit) || (isStored(unit) && at.crc === undefined))) {
                throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point is not a position in this archive.', file.relPath);
              }
            }
            for (let index = first; index < context.units.length; index += 1) {
              const place: Place = at && index === first && at.mode !== 'start'
                ? at
                : { fileIndex, memberIndex: context.units[index]!.memberIndex, offset: 0, mode: 'start', order: '?', style: '', prev: '' };
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
        yield { items: pageItems(), nextCursor: doneCursor(input), done: true };
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
