// A Telegram Desktop export's entries as records of the Telegram connector
// (docs/design/archive-live-one-dataset.md, sections 1, 4 and 9).
//
// The export is one input of the Telegram connector, beside the live capture
// spool. Each message becomes the spool's own `message` object, with the live
// item's exact key: Telegram's chat id in Telethon's marked form and the
// message id. The connector's one builder (`telegramMessageItem`) then makes
// the item, whichever input the record came from. The parts of an account
// export that are not chats (contacts, sessions, the profile...) are records
// of their own kinds, in a conversation of their own per part.
//
// Pure: no file is opened here; a media path is only ever text.

import { createHash } from 'node:crypto';
import {
  flattenTelegramText,
  isRecord,
  telegramMessageContent,
  telegramScalar,
  telegramTime,
} from '../archive-import/telegram/message.ts';
import { accountEntryContent, accountTitle, type AccountSection } from '../archive-import/telegram/account.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
} from './corpus-adapter.ts';
import { telegramMessageItem, type TelegramCaptureSpoolRecord } from './capture-spool-connector.ts';
import { telegramPeerId } from './peer-id.ts';

/** The chat types Telegram Desktop writes, as live capture names them (`chat_type_from_entity`). */
const LIVE_CHAT_TYPES: Readonly<Record<string, string>> = {
  personal_chat: 'dm',
  saved_messages: 'dm',
  replies: 'dm',
  verification_codes: 'dm',
  bot_chat: 'bot',
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

/**
 * A chat's id as live capture keys it: Telethon's marked peer id. The export
 * writes the bare id and says by the chat's type which kind of peer it is: a
 * user or bot as is, a basic group negated, a supergroup or channel behind
 * `-100`. An id that is already marked (negative) is kept; a type this does
 * not know has no exact key, so its chat is kept apart (`export:<type>:<id>`)
 * rather than risk joining the wrong live chat.
 */
export function telegramMarkedChatId(type: string | undefined, id: string | undefined): string | undefined {
  if (!id || !/^-?\d{1,20}$/.test(id)) return undefined;
  if (id.startsWith('-')) return id;
  switch (type) {
    case 'personal_chat':
    case 'bot_chat':
    case 'saved_messages':
    case 'replies':
    case 'verification_codes':
      return id;
    case 'private_group':
      return telegramPeerId('chat', id);
    case 'private_supergroup':
    case 'public_supergroup':
    case 'private_channel':
    case 'public_channel':
      return telegramPeerId('channel', id);
    default:
      return `export:${type && /^[a-z_]{1,40}$/.test(type) ? type : 'unknown'}:${id}`;
  }
}

/**
 * A sender as live capture keys it (Telethon's `sender_id`, a marked peer id):
 * `user<id>` is the user's id, `channel<id>` a channel's (`-100<id>`),
 * `chat<id>` a basic group's (`-<id>`).
 */
export function telegramExportSenderId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const found = /^(user|channel|chat)(\d{1,20})$/.exec(value.trim());
  if (!found) return undefined;
  return telegramPeerId(found[1] as 'user' | 'chat' | 'channel', found[2]!);
}

/** An ISO time the way the Telethon helper writes it (no milliseconds), so both inputs spell a version alike. */
function liveIso(iso: string | undefined): string | undefined {
  return iso?.replace(/\.000Z$/, 'Z');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Bounds mirroring the helper's (scripts/telegram-telethon-reader.py), which mirror the store's.
const MAX_REACTION_TOKENS = 32;
const MAX_REACTION_KEY_CHARS = 64;
const MAX_REACTION_COUNT = 1_000_000;
const MAX_REACTION_ACTORS = 32;
const MAX_REACTIONS_SERIALIZED_CHARS = 4_000;

/**
 * The export's reactions as the helper's complete aggregate: each emoji (or a
 * custom emoji as `custom:<id>`) with its count and the users among its recent
 * reactors, in the shared canonical order and within the store's bounds.
 * Undefined when the export says nothing about reactions.
 */
export function telegramExportReactions(value: unknown): Array<{ key: string; count: number; actors?: Array<{ providerActorId: string }> }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<{ key: string; count: number; actors?: Array<{ providerActorId: string }> }> = [];
  const seen = new Set<string>();
  for (const reaction of value) {
    if (!isRecord(reaction)) continue;
    const emoji = typeof reaction.emoji === 'string' ? reaction.emoji.trim() : '';
    const custom = telegramScalar(reaction.document_id);
    const key = emoji !== '' ? emoji : custom && /^\d{1,20}$/.test(custom) ? `custom:${custom}` : undefined;
    const count = reaction.count;
    if (!key || key.length > MAX_REACTION_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(key) || seen.has(key)) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_REACTION_COUNT) continue;
    seen.add(key);
    const actors: Array<{ providerActorId: string }> = [];
    if (Array.isArray(reaction.recent)) {
      for (const recent of reaction.recent) {
        const id = isRecord(recent) ? telegramExportSenderId(recent.from_id) : undefined;
        if (id && !id.startsWith('-') && !actors.some((actor) => actor.providerActorId === id)) actors.push({ providerActorId: id });
      }
    }
    actors.sort((a, b) => (a.providerActorId < b.providerActorId ? -1 : a.providerActorId > b.providerActorId ? 1 : 0));
    entries.push({ key, count, ...(actors.length > 0 ? { actors: actors.slice(0, MAX_REACTION_ACTORS) } : {}) });
  }
  entries.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  entries.length = Math.min(entries.length, MAX_REACTION_TOKENS);
  while (entries.length > 0 && JSON.stringify(entries).length > MAX_REACTIONS_SERIALIZED_CHARS) entries.pop();
  return entries;
}

/** One chat of the export, as its header gives it. */
export interface TelegramExportChat {
  name?: string;
  type?: string;
  id?: string;
}

/** A file a message names, for the connector to bind as a child (the path is relative to the export's folder). */
export interface TelegramExportMedia {
  /** `photo` or `file`, the field that names it. */
  field: 'photo' | 'file';
  path?: string;
  /** The export left the file out (a sentence in place of the path). */
  leftOut: boolean;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface TelegramExportRecordContext {
  /** The live account scope (`telegram.personal`). */
  account: string;
  fetchedAt: string;
  /** The exporting account's user id, when the export carries its profile: its own messages are the owner's. */
  ownUserId?: string;
}

export type TelegramExportOutcome =
  | { kind: 'record'; record: TelegramCaptureSpoolRecord; media: TelegramExportMedia[]; assumedZone: boolean; unsupported: boolean; mediaNotRead: number; withoutText: boolean }
  | { kind: 'skipped'; reason: 'message_without_text' }
  | { kind: 'gap'; reason: 'message_unreadable' | 'message_content_unsupported' | 'chat_unknown' };

/** The time an export was made, when the input knows it (its file's modification time): what an account entry's version says. */
export interface TelegramExportClock {
  exportedAt?: string;
}

const SERVICE_FIELDS = ['title', 'new_title', 'members', 'duration_seconds', 'duration', 'discard_reason', 'period', 'amount', 'currency', 'boosts', 'inviter'];

function mediaOf(message: Record<string, unknown>): TelegramExportMedia[] {
  const out: TelegramExportMedia[] = [];
  const named = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
  const leftOut = (value: string): boolean => value.startsWith('(') && value.endsWith(')');
  const size = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
  const photo = named(message.photo);
  if (photo) {
    const sizeBytes = size(message.photo_file_size);
    out.push({
      field: 'photo',
      ...(leftOut(photo) ? {} : { path: photo }),
      leftOut: leftOut(photo),
      name: leftOut(photo) ? 'Photo' : photo.split('/').pop()!,
      mimeType: 'image/jpeg',
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }
  const file = named(message.file);
  if (file) {
    const sizeBytes = size(message.file_size);
    const fileName = named(message.file_name);
    out.push({
      field: 'file',
      ...(leftOut(file) ? {} : { path: file }),
      leftOut: leftOut(file),
      name: fileName ?? (leftOut(file) ? 'File' : file.split('/').pop()!),
      ...(named(message.mime_type) ? { mimeType: named(message.mime_type)! } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }
  return out;
}

/**
 * One message of a chat as a record of the Telegram connector, in the spool's
 * own shape and with the live item's key; a service message (a join, a call, a
 * pin) as its event, by the export's own names, which the builder writes as a
 * sentence. Nothing in a message is cut.
 */
export function telegramExportMessageRecord(
  context: TelegramExportRecordContext,
  chat: TelegramExportChat,
  value: unknown,
): TelegramExportOutcome {
  if (!isRecord(value)) return { kind: 'gap', reason: 'message_unreadable' };
  const messageId = telegramScalar(value.id);
  if (!messageId || !/^-?\d{1,20}$/.test(messageId)) return { kind: 'gap', reason: 'message_unreadable' };
  const conversationId = telegramMarkedChatId(chat.type, chat.id);
  if (!conversationId) return { kind: 'gap', reason: 'chat_unknown' };
  const service = value.type === 'service';
  const content = service ? undefined : telegramMessageContent(value);
  // A message with nothing to read (empty, or a kind of content this reader cannot read) is still a message: it
  // becomes an item by its names (id, sender, time, chat), so nothing of it is lost, and is counted.
  const withoutText = content !== undefined && !content.hasContent;
  const sent = telegramTime(value, 'date');
  const edited = telegramTime(value, 'edited');
  const named = (field: unknown): string | undefined => (typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined);
  const senderName = service ? named(value.actor) : named(value.from) ?? named(value.author);
  const senderId = telegramExportSenderId(service ? value.actor_id : value.from_id);
  const reactions = telegramExportReactions(value.reactions);
  const media = mediaOf(value);
  const sentAt = liveIso(sent.iso);
  const editedAt = liveIso(edited.iso);
  const replyTo = telegramScalar(service && value.action === 'pin_message' ? value.message_id : value.reply_to_message_id);
  const forwardedFrom = named(value.forwarded_from);
  let sourceVersion = `${context.account}:${conversationId}:${messageId}:${editedAt ?? sentAt ?? ''}`;
  if (reactions) sourceVersion += `:r${sha256(JSON.stringify(reactions)).slice(0, 8)}`;
  const serviceEvent: Record<string, unknown> = {};
  if (service) {
    serviceEvent.action = named(value.action) ?? 'service';
    for (const key of SERVICE_FIELDS) {
      const field = value[key];
      if (typeof field === 'string' || typeof field === 'number') serviceEvent[key] = field;
      else if (Array.isArray(field)) {
        const names = field.flatMap((entry) => (typeof entry === 'string' && entry.trim() !== '' ? [entry.trim()] : isRecord(entry) && named(entry.name) ? [named(entry.name)!] : []));
        if (names.length > 0) serviceEvent[key] = names;
      }
    }
    const info = service && value.action === 'information_text' ? flattenTelegramText(value.text).trim() : '';
    if (info) serviceEvent.title = info;
  }
  const message: Record<string, unknown> = {
    id: messageId,
    chatId: conversationId,
    conversationId,
    ...(sentAt ? { sentAt } : {}),
    ...(editedAt ? { editedAt } : {}),
    chatTitle: chat.name ?? (chat.type ? CHAT_TYPE_TITLES[chat.type] : undefined) ?? undefined,
    ...(chat.type && LIVE_CHAT_TYPES[chat.type] ? { chatType: LIVE_CHAT_TYPES[chat.type] } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderDisplayName: senderName } : {}),
    ...(senderId && context.ownUserId ? { senderIsOwner: senderId === context.ownUserId } : {}),
    ...(content && content.hasContent ? { boundedText: content.text } : {}),
    ...(service ? { service: serviceEvent } : {}),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    ...(forwardedFrom ? { forwardSource: 'telegram_forward', forwardFromName: forwardedFrom } : {}),
    ...(media.length > 0
      ? { attachments: media.map((entry) => ({ type: entry.field === 'photo' ? 'image' : 'file', name: entry.name, ...(entry.mimeType ? { mimeType: entry.mimeType } : {}), ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}) })) }
      : {}),
    ...(reactions ? { reactions } : {}),
    sourceVersion,
  };
  if (message.chatTitle === undefined) delete message.chatTitle;
  const capturedItem = telegramMessageItem({
    account: context.account,
    conversationId,
    trustDomain: 'internal',
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    message,
    fetchedAt: context.fetchedAt,
  });
  return {
    kind: 'record',
    record: {
      captureId: sha256([context.account, conversationId, messageId, sourceVersion].join('\x1f')),
      capturedAt: context.fetchedAt,
      capturedItem,
    },
    media,
    assumedZone: sent.assumedZone,
    unsupported: content?.unsupported ?? false,
    mediaNotRead: media.length,
    withoutText,
  };
}

/** The conversation each part of the account export is kept in. */
export function telegramAccountConversation(section: AccountSection): string {
  return `account:${section.name}`;
}

/**
 * The key of one entry of a part of the account export, stable across exports
 * of the same account where the entry says who it is: a contact by its user
 * id (else its phone number and name), a session by its device, app and when
 * it began, the profile and other data as the one entry they are. Otherwise
 * its content.
 */
export function telegramAccountEntryKey(section: AccountSection, value: unknown, ordinal: number): string {
  if (section.whole) return section.name;
  if (isRecord(value)) {
    const userId = telegramScalar(value.user_id);
    if ((section.name === 'contacts' || section.name === 'frequent_contacts') && userId) return `user${userId}`;
    const parts = section.name === 'sessions' || section.name === 'web_sessions'
      ? [value.device_model, value.platform, value.application_name, value.domain, value.bot_username, value.created_unixtime ?? value.created]
      : section.name === 'contacts' || section.name === 'frequent_contacts'
        // A contact is who its number is (a renamed contact is the same one); without a number, its names.
        ? (telegramScalar(value.phone_number) ? [value.phone_number] : [value.first_name, value.last_name, value.name, value.category])
        : [];
    const known = parts.map((part) => telegramScalar(part) ?? '');
    if (known.some((part) => part !== '')) return sha256(known.join('\x1f')).slice(0, 24);
  }
  return sha256(`${ordinal}\x1f${JSON.stringify(value) ?? ''}`).slice(0, 24);
}

/**
 * One entry of a part of the account export (a contact, a session, the
 * profile) as a record of its own kind: its fields as text, in the part's own
 * conversation ("Telegram account: contacts"). It has no time of a message;
 * its version is its text, so the same entry exported again is the same record.
 */
export function telegramAccountEntryRecord(
  context: TelegramExportRecordContext,
  section: AccountSection,
  ordinal: number,
  value: unknown,
  clock: TelegramExportClock = {},
): { record: TelegramCaptureSpoolRecord; mediaFiles: number } {
  const content = accountEntryContent(section, value);
  const conversationId = telegramAccountConversation(section);
  const id = telegramAccountEntryKey(section, value, ordinal);
  // An entry has no time of its own: its version is when the export was made, so a later export's snapshot of
  // the same entry is newer (its text may have changed) and an older export's never replaces it.
  const exportedAt = liveIso(clock.exportedAt) ?? '';
  const sourceVersion = `${context.account}:${conversationId}:${id}:text:${sha256(content.text).slice(0, 16)}:${exportedAt}`;
  const capturedItem = telegramMessageItem({
    account: context.account,
    conversationId,
    trustDomain: 'internal',
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    message: {
      id,
      conversationId,
      chatTitle: accountTitle(section),
      recordKind: section.name,
      boundedText: content.text,
      sourceVersion,
    },
    fetchedAt: context.fetchedAt,
  });
  return {
    record: {
      captureId: sha256([context.account, conversationId, id, sourceVersion].join('\x1f')),
      capturedAt: context.fetchedAt,
      capturedItem,
    },
    mediaFiles: content.mediaFiles,
  };
}
