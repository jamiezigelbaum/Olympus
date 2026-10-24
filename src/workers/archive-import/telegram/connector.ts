/**
 * The Telegram Desktop archive connector: one RawItem per message of a
 * `result.json` (a whole-account export, with its `chats` and `left_chats`, or
 * one chat's), read as a stream so a multi-gigabyte export never sits in memory.
 *
 * Shape (telegramdesktop/tdesktop, export_output_json.cpp): a whole-account
 * export is `{about, personal_information, profile_pictures, contacts,
 * frequent_contacts, sessions, web_sessions, other_data, chats: {about, list:
 * [{name, type, id, messages: [...]}]}, left_chats: {...}}`; a single chat's is
 * `{name, type, id, messages: [...]}`. The writer puts a chat's header before
 * its messages, so the shared JSON reader's frame carries it to each message.
 *
 * - Reading: the file through the scope-safe range reader and PR-A's JSON
 *   stream reader, over the message lists. Telegram writes a control character
 *   as `\x0B`, which is not JSON; `json-repair.ts` makes those spaces, byte for
 *   byte, so offsets stay file offsets.
 * - Items: one per message. Thread = the chat, keyed by its place in the file
 *   (section and index, stable for these files): a chat's bare `id` is not
 *   unique across users, groups and channels. Text = the message's words with
 *   links kept, then a line for each picture, file, contact, place or poll it
 *   carries. `authoredAt` = `date_unixtime`, else the zone-less `date` read in
 *   this computer's zone (one assumption, counted once).
 * - Left out, counted: service messages (joins, calls, pins) and messages with
 *   nothing to read are `skipped`; media files are named in the text and
 *   counted as `media_not_imported` (the files are never opened); each part of
 *   the account export that is not messages is one `section_not_imported`.
 * - Bounds: item text over TELEGRAM_MAX_ITEM_TEXT_CHARS is cut and counted
 *   (`item_truncated`); a message too large to build is `message_too_large`.
 *   A file that is not whole JSON (cut short by an interrupted export) imports
 *   what came before and counts the file as damaged.
 * - Resume point: `tg1:<manifest>:<assumed>:<json resume point>`, the JSON
 *   reader's point after a message (section, chat index, message ordinal, byte
 *   offset) in a file of exactly this manifest. Any other manifest, or a point
 *   that is not after a message, stops the import.
 * - Live Telegram capture is a different provider (`telegram`) in different
 *   stores; nothing here reads or writes it.
 */
import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
  SourceConversationKind,
} from '../../../core/contracts.ts';
import {
  ARCHIVE_COMMON_FINDINGS,
  ArchiveImportStoppedError,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';
import type { ScopeFileReader } from '../../../core/scope-safe-fs.ts';
import { fileByteSource } from '../byte-source.ts';
import {
  JsonStreamError,
  JsonStreamReader,
  archiveStopFromReaderError,
  parseJsonResume,
  serializeJsonResume,
  type JsonResumePoint,
  type JsonStreamEvent,
} from '../json-stream.ts';
import { telegramJsonSource } from './json-repair.ts';
import { cutText, telegramMessageContent, telegramScalar, telegramTime } from './message.ts';

export const TELEGRAM_CURSOR_PREFIX = 'tg1:';
export const TELEGRAM_DEFAULT_PAGE_SIZE = 200;
export const TELEGRAM_DEFAULT_MAX_BYTES_PER_LISTING = 256 * 1024 * 1024;
/** Text kept per message; longer text is cut and counted as a gap. */
export const TELEGRAM_MAX_ITEM_TEXT_CHARS = 1_000_000;
/** A message whose JSON is longer than this is not built (it is counted as too large to read). */
export const TELEGRAM_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const TELEGRAM_FINDINGS = {
  tooLarge: 'message_too_large',
  unreadable: 'message_unreadable',
  serviceMessage: 'service_message',
  withoutText: 'message_without_text',
} as const;

// The lists of messages, then the parts of a whole-account export that are not messages.
const MESSAGE_PATHS: readonly (readonly (string | number)[])[] = [
  ['chats', 'list', '*', 'messages'],
  ['left_chats', 'list', '*', 'messages'],
  ['messages'],
];
const SECTION_PATHS: ReadonlyArray<{ path: readonly string[]; name: string }> = [
  { path: ['personal_information'], name: 'personal_information' },
  { path: ['profile_pictures'], name: 'profile_pictures' },
  { path: ['stories'], name: 'stories' },
  { path: ['profile_music'], name: 'profile_music' },
  { path: ['contacts', 'list'], name: 'contacts' },
  { path: ['frequent_contacts', 'list'], name: 'frequent_contacts' },
  { path: ['sessions', 'list'], name: 'sessions' },
  { path: ['web_sessions', 'list'], name: 'web_sessions' },
  { path: ['other_data'], name: 'other_data' },
];
const ITEM_PATHS = [...MESSAGE_PATHS, ...SECTION_PATHS.map((section) => section.path)];

const CHAT_TYPE_KINDS: Readonly<Record<string, SourceConversationKind>> = {
  saved_messages: 'direct',
  replies: 'direct',
  verification_codes: 'direct',
  personal_chat: 'direct',
  bot_chat: 'direct',
  private_group: 'group',
  private_supergroup: 'group',
  public_supergroup: 'group',
  private_channel: 'channel',
  public_channel: 'channel',
};

const CHAT_TYPE_TITLES: Readonly<Record<string, string>> = {
  saved_messages: 'Saved Messages',
  replies: 'Replies',
  verification_codes: 'Telegram verification codes',
};

interface ParsedCursor {
  resume: JsonResumePoint | undefined;
  assumedZone: boolean;
  done: boolean;
}

function manifestTag(input: ArchiveConnectorInput): string {
  return input.manifestSha256.slice(0, 16);
}

/** The frames of a resume point keep only what a message needs of its chat. */
function slimResume(point: JsonResumePoint): JsonResumePoint {
  return {
    offset: point.offset,
    levels: point.levels.map((level) => {
      const frame: Record<string, string | number | boolean | null> = {};
      for (const key of ['name', 'type', 'id']) {
        if (Object.prototype.hasOwnProperty.call(level.frame, key)) frame[key] = level.frame[key]!;
      }
      return { kind: level.kind, pointer: level.pointer, frame };
    }),
  };
}

function cursorAt(input: ArchiveConnectorInput, point: JsonResumePoint, assumedZone: boolean): string {
  return `${TELEGRAM_CURSOR_PREFIX}${manifestTag(input)}:${assumedZone ? 1 : 0}:${serializeJsonResume(slimResume(point))}`;
}

function doneCursor(input: ArchiveConnectorInput): string {
  return `${TELEGRAM_CURSOR_PREFIX}${manifestTag(input)}:done`;
}

/** Whether a resume point is the one after a message: `messages` of a single chat, or of a chat in `chats` or `left_chats`. */
function afterMessage(point: JsonResumePoint): boolean {
  const levels = point.levels;
  const isIndex = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (levels.length === 2) {
    return levels[0]!.kind === 'object' && levels[0]!.pointer === 'messages'
      && levels[1]!.kind === 'array' && isIndex(levels[1]!.pointer);
  }
  if (levels.length === 5) {
    return levels[0]!.kind === 'object' && (levels[0]!.pointer === 'chats' || levels[0]!.pointer === 'left_chats')
      && levels[1]!.kind === 'object' && levels[1]!.pointer === 'list'
      && levels[2]!.kind === 'array' && isIndex(levels[2]!.pointer)
      && levels[3]!.kind === 'object' && levels[3]!.pointer === 'messages'
      && levels[4]!.kind === 'array' && isIndex(levels[4]!.pointer);
  }
  return false;
}

function parseCursor(input: ArchiveConnectorInput, cursor: string | undefined): ParsedCursor {
  if (!cursor) return { resume: undefined, assumedZone: false, done: false };
  const prefix = `${TELEGRAM_CURSOR_PREFIX}${manifestTag(input)}:`;
  if (!cursor.startsWith(prefix)) {
    throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point belongs to other files than this archive\'s.');
  }
  const rest = cursor.slice(prefix.length);
  if (rest === 'done') return { resume: undefined, assumedZone: false, done: true };
  const flag = rest.slice(0, 2);
  const resume = flag === '0:' || flag === '1:' ? parseJsonResume(rest.slice(2)) : undefined;
  if (!resume || !afterMessage(resume) || resume.offset > input.files[0]!.version.size) {
    throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point is not a position in this archive.');
  }
  return { resume, assumedZone: flag === '1:', done: false };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ChatPlace {
  section: 'chats' | 'left_chats' | 'chat';
  chatIndex: number;
  ordinal: number;
}

function placeOf(event: JsonStreamEvent): ChatPlace {
  const path = event.path;
  if (event.pathIndex === 2) return { section: 'chat', chatIndex: 0, ordinal: Number(path[1]) };
  return { section: path[0] === 'left_chats' ? 'left_chats' : 'chats', chatIndex: Number(path[2]), ordinal: Number(path[4]) };
}

function chatTitle(name: string | undefined, type: string | undefined, place: ChatPlace): string {
  if (name) return name;
  if (type && CHAT_TYPE_TITLES[type]) return CHAT_TYPE_TITLES[type]!;
  return place.section === 'chat' ? 'Unnamed Telegram chat' : `Unnamed Telegram chat ${place.chatIndex + 1}`;
}

type MessageOutcome =
  | { kind: 'item'; item: RawItem; findings: Array<{ kind: string; count?: number }>; assumedZone: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'unreadable' };

function messageOutcome(
  input: ArchiveConnectorInput,
  event: JsonStreamEvent,
  fetchedAt: string,
): MessageOutcome {
  const message = event.value;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return { kind: 'unreadable' };
  const record = message as Record<string, unknown>;
  if (record.type === 'service') return { kind: 'skipped', reason: TELEGRAM_FINDINGS.serviceMessage };
  const content = telegramMessageContent(record);
  if (!content.hasContent) return { kind: 'skipped', reason: TELEGRAM_FINDINGS.withoutText };

  const findings: Array<{ kind: string; count?: number }> = [];
  let body = content.text;
  if (body.length > TELEGRAM_MAX_ITEM_TEXT_CHARS) {
    body = cutText(body, TELEGRAM_MAX_ITEM_TEXT_CHARS);
    findings.push({ kind: ARCHIVE_COMMON_FINDINGS.itemTruncated });
  }
  if (content.mediaFiles > 0) findings.push({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, count: content.mediaFiles });

  const place = placeOf(event);
  const frame = event.frame;
  const name = typeof frame.name === 'string' && frame.name.trim() !== '' ? frame.name : undefined;
  const type = typeof frame.type === 'string' ? frame.type : undefined;
  const chatId = telegramScalar(frame.id);
  const title = chatTitle(name, type, place);
  const conversationId = place.section === 'chat' ? 'chat' : `${place.section}:${place.chatIndex}`;

  const sent = telegramTime(record, 'date');
  const edited = telegramTime(record, 'edited');
  const sender = (typeof record.from === 'string' && record.from.trim() !== '' ? record.from : undefined)
    ?? (typeof record.author === 'string' && record.author.trim() !== '' ? record.author : undefined);
  const senderId = telegramScalar(record.from_id);
  const messageId = telegramScalar(record.id);
  const reply = telegramScalar(record.reply_to_message_id);
  const forwarded = typeof record.forwarded_from === 'string' && record.forwarded_from.trim() !== '' ? record.forwarded_from : undefined;

  const providerItemId = sha256(`${place.section}\u0000${place.chatIndex}\u0000${place.ordinal}\u0000${messageId ?? ''}`).slice(0, 32);
  const item: RawItem = {
    identity: {
      family: input.format.family,
      provider: input.format.provider,
      accountScope: input.accountScope,
      providerItemId,
      providerThreadId: conversationId,
      providerConversationId: conversationId,
      localItemId: `${input.accountScope}:${providerItemId}`,
      sourceVersion: sha256(body).slice(0, 32),
    },
    mimeType: 'text/plain; charset=utf-8',
    content: { kind: 'text', text: body },
    metadata: Object.freeze({
      title,
      chat: title,
      ...(chatId ? { chatId } : {}),
      ...(type ? { chatType: type } : {}),
      ...(place.section === 'left_chats' ? { leftChat: true } : {}),
      ...(sender ? { sender, senderLabel: sender, senderDisplayName: sender } : {}),
      ...(senderId ? { senderId } : {}),
      ...(sent.iso ? { sentAt: sent.iso, authoredAt: sent.iso } : {}),
      ...(edited.iso ? { editedAt: edited.iso } : {}),
      ...(messageId ? { telegramMessageId: messageId } : {}),
      ...(reply ? { replyToMessageId: reply } : {}),
      ...(forwarded ? { forwardSource: forwarded } : {}),
      ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
      attachmentsNotIngested: content.mediaFiles,
      contentHash: sha256(body),
    }),
    fetchedAt,
  };
  return { kind: 'item', item, findings, assumedZone: sent.assumedZone };
}

/** Why a JSON file is not whole: damaged or cut short (a file the reader could read to its end, but no further). */
function isDamage(error: unknown): boolean {
  return error instanceof JsonStreamError && error.code !== 'resume_invalid';
}

export function createTelegramArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  const pageSizeDefault = Math.max(1, input.pageSize ?? TELEGRAM_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, input.maxBytesPerListing ?? TELEGRAM_DEFAULT_MAX_BYTES_PER_LISTING);
  const file = input.files[0];
  if (!file || input.files.length !== 1) throw new Error('A Telegram export is one result.json.');
  return {
    id: input.connectorId,
    family: input.format.family,
    async authenticate(): Promise<void> {
      // No account: the approved file is the whole grant.
    },
    listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const start = parseCursor(input, options?.cursor);
        if (start.done) {
          yield { items: [], nextCursor: doneCursor(input), done: true };
          return;
        }
        const limit = options?.limit !== undefined && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
        let reader: ScopeFileReader;
        try {
          reader = input.root.openFile(file.relPath, { expected: file.version });
        } catch (error) {
          throw archiveStopFromReaderError(error, file.relPath);
        }
        // Before each page goes out: the file is still the version opened, at its name too.
        const current = (): void => {
          try {
            reader.assertCurrent();
          } catch (error) {
            throw archiveStopFromReaderError(error, file.relPath);
          }
        };
        try {
          const origin = start.resume?.offset ?? 0;
          let json: JsonStreamReader;
          try {
            json = new JsonStreamReader(telegramJsonSource(fileByteSource(reader, { start: origin })), {
              itemPaths: ITEM_PATHS,
              maxItemBytes: TELEGRAM_MAX_MESSAGE_BYTES,
              ...(start.resume ? { resume: start.resume } : {}),
            });
          } catch (error) {
            throw archiveStopFromReaderError(error, file.relPath);
          }
          const fetchedAt = new Date().toISOString();
          const reportedSections = new Set<string>();
          let assumedZone = start.assumedZone;
          let page: RawItem[] = [];
          // The resume point after the last message read, and whether a message was read since a page went out.
          let after: JsonResumePoint | undefined;
          let unsent = false;
          let emitted = 0;
          const report = (kind: string, findingClass: 'gap' | 'skipped', offset: number, count?: number): void => {
            input.report({ kind, class: findingClass, fileIndex: 0, offset, ...(count !== undefined ? { count } : {}) });
          };
          for (;;) {
            if (!input.shouldContinue()) {
              if (after && unsent) {
                current();
                input.reportPosition?.({ fileIndex: 0, offset: after.offset });
                yield { items: page, nextCursor: cursorAt(input, after, assumedZone), done: false };
              }
              return;
            }
            let event: JsonStreamEvent | undefined;
            try {
              event = json.next();
            } catch (error) {
              if (!isDamage(error)) throw archiveStopFromReaderError(error, file.relPath);
              // The reader returns every message it had finished before the error; the file is counted as damaged at its end.
              report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', file.version.size);
              break;
            }
            if (!event) break;
            if (event.pathIndex >= MESSAGE_PATHS.length) {
              // A part of the account export that is not messages: said once, where it starts.
              const section = SECTION_PATHS[event.pathIndex - MESSAGE_PATHS.length]!.name;
              if (!reportedSections.has(section)) {
                reportedSections.add(section);
                report(ARCHIVE_COMMON_FINDINGS.sectionNotImported, 'gap', event.start);
              }
              continue;
            }
            if (event.kind === 'oversize') {
              report(TELEGRAM_FINDINGS.tooLarge, 'gap', event.start);
            } else {
              const outcome = messageOutcome(input, event, fetchedAt);
              if (outcome.kind === 'unreadable') {
                report(TELEGRAM_FINDINGS.unreadable, 'gap', event.start);
              } else if (outcome.kind === 'skipped') {
                report(outcome.reason, 'skipped', event.start);
              } else {
                page.push(outcome.item);
                for (const finding of outcome.findings) report(finding.kind, 'gap', event.start, finding.count);
                if (outcome.assumedZone && !assumedZone) {
                  assumedZone = true;
                  report(ARCHIVE_COMMON_FINDINGS.assumption, 'gap', event.start);
                }
              }
            }
            after = event.resume;
            unsent = true;
            const budgetLeft = limit - emitted;
            if (page.length >= Math.min(pageSizeDefault, budgetLeft) || json.position - origin >= byteBudget) {
              current();
              input.reportPosition?.({ fileIndex: 0, offset: after.offset });
              yield { items: page, nextCursor: cursorAt(input, after, assumedZone), done: false };
              emitted += page.length;
              page = [];
              unsent = false;
              if (emitted >= limit || json.position - origin >= byteBudget) return;
            }
          }
          current();
          // A cut-short or damaged file ends the listing with what was read; it is counted, not hidden.
          yield { items: page, nextCursor: doneCursor(input), done: true };
        } finally {
          reader.close();
        }
      })();
    },
    async fetchItem(): Promise<RawItem> {
      throw new Error('An imported message is read only while its archive is listed.');
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      const title = typeof item.metadata.title === 'string' ? item.metadata.title : undefined;
      const sender = typeof item.metadata.senderLabel === 'string' && item.metadata.senderLabel ? item.metadata.senderLabel : undefined;
      const chatType = typeof item.metadata.chatType === 'string' ? item.metadata.chatType : undefined;
      const conversationKind = chatType ? CHAT_TYPE_KINDS[chatType] : undefined;
      const conversation = item.identity.providerConversationId;
      return {
        ...(title ? { title } : {}),
        ...(sender ? { sender } : {}),
        ...(conversationKind ? { conversationKind } : {}),
        ...(conversation ? { folderKeys: [conversation] } : {}),
      };
    },
  };
}

/** Registers the Telegram connector with the format registry. Idempotent. */
export function registerTelegramArchiveConnector(): void {
  registerArchiveFormatConnector('telegram_json', createTelegramArchiveConnector);
}
