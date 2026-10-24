// Synthetic Telegram Desktop exports, built in code: never a real export, and
// every name, phone number and message below is made up. The shapes follow
// Telegram Desktop's own JSON writer (telegramdesktop/tdesktop,
// export_output_json.cpp): one space of indent per level, keys in the writer's
// order, a control character written as `\xNN` (which is not JSON), a
// whole-account export that lists its other sections before `chats`, and a
// single-chat export that opens with the chat's own header.
//
// Reusable: the release check imports these builders too.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TelegramFixtureMessage = Record<string, unknown>;

export interface TelegramFixtureChat {
  name: string | null;
  type: string;
  id: number;
  messages: TelegramFixtureMessage[];
}

/** 2015-01-05T10:00:00.000Z, the first message's time. */
export const TELEGRAM_FIXTURE_FIRST_SECONDS = 1_420_452_000;

/** Seconds since 1970 of message `index`: one hour apart. */
export function telegramFixtureSeconds(index: number): number {
  return TELEGRAM_FIXTURE_FIRST_SECONDS + index * 3600;
}

export function telegramFixtureIso(index: number): string {
  return new Date(telegramFixtureSeconds(index) * 1000).toISOString();
}

/** The ISO form Telegram writes in `date`: no zone in it. Here the UTC clock; real files carry the exporter's local time. */
function wallClock(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19);
}

interface Common {
  from?: string;
  fromId?: string;
  /** Leave `date_unixtime` out, as releases before 4.0 did. */
  dateOnly?: boolean;
  extra?: Record<string, unknown>;
}

function base(index: number, type: 'message' | 'service', options: Common): TelegramFixtureMessage {
  const seconds = telegramFixtureSeconds(index);
  return {
    id: 1000 + index,
    type,
    date: wallClock(seconds),
    ...(options.dateOnly ? {} : { date_unixtime: String(seconds) }),
  };
}

export type TextPart = string | { type: string; text: string; href?: string };

function entities(parts: readonly TextPart[]): Array<{ type: string; text: string; href?: string }> {
  return parts.map((part) => (typeof part === 'string' ? { type: 'plain', text: part } : part));
}

/** A plain text message. */
export function telegramText(index: number, text: string, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    text,
    text_entities: entities(text === '' ? [] : [text]),
    ...options.extra,
  };
}

/** A message with formatting: `text` is the array form, mixing strings and typed parts. */
export function telegramFormatted(index: number, parts: readonly TextPart[], options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    text: parts.map((part) => (typeof part === 'string' ? part : { ...part })),
    text_entities: entities(parts),
    ...options.extra,
  };
}

/** A join, a call, a pin: no `from`, no `text`. */
export function telegramService(index: number, action = 'join_group_by_link', options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'service', options),
    actor: options.from ?? 'Sam Example',
    actor_id: options.fromId ?? 'user1001',
    action,
  };
}

export function telegramPhoto(index: number, caption = '', options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    photo: `photos/photo_${index}@05-01-2015_10-00-00.jpg`,
    photo_file_size: 24_576,
    width: 800,
    height: 600,
    text: caption,
    text_entities: entities(caption === '' ? [] : [caption]),
    ...options.extra,
  };
}

export function telegramVoice(index: number, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    file: `voice_messages/audio_${index}@05-01-2015_10-00-00.ogg`,
    file_size: 8_192,
    media_type: 'voice_message',
    mime_type: 'audio/ogg',
    duration_seconds: 7,
    text: '',
    text_entities: [],
    ...options.extra,
  };
}

export function telegramSticker(index: number, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    file: `stickers/sticker_${index}.webp`,
    file_size: 4_096,
    media_type: 'sticker',
    sticker_emoji: '\u{1F600}',
    width: 512,
    height: 512,
    text: '',
    text_entities: [],
    ...options.extra,
  };
}

/** A file the export left out (over the size limit, or media not chosen for the export). */
export function telegramFileLeftOut(index: number, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    file: '(File not included. Change data exporting settings to download.)',
    file_name: 'synthetic-report.pdf',
    mime_type: 'application/pdf',
    text: '',
    text_entities: [],
    ...options.extra,
  };
}

export function telegramPoll(index: number, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    text: '',
    text_entities: [],
    poll: {
      question: 'Which harbour at dawn?',
      closed: false,
      total_voters: 3,
      answers: [
        { text: 'North quay', voters: 2, chosen: false },
        { text: 'South quay', voters: 1, chosen: true },
      ],
    },
    ...options.extra,
  };
}

/** A to-do list: its title and tasks (the writer calls the tasks `answers`), and no ordinary text. */
export function telegramTodo(
  index: number,
  title: string | readonly TextPart[],
  tasks: ReadonlyArray<string | readonly TextPart[]>,
  options: Common = {},
): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    text: '',
    text_entities: [],
    todo_list: {
      title,
      others_can_append: false,
      others_can_complete: true,
      answers: tasks.map((task, position) => ({ text: task, id: position + 1 })),
    },
    ...options.extra,
  };
}

/** A kind of content the importer does not read: `extra` is the part of the message the writer adds for it. */
export function telegramUnreadableKind(index: number, extra: Record<string, unknown>, options: Common & { text?: string } = {}): TelegramFixtureMessage {
  const words = options.text ?? '';
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    text: words,
    text_entities: entities(words === '' ? [] : [words]),
    ...extra,
  };
}

export function telegramContact(index: number, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    contact_information: { first_name: 'Robin', last_name: 'Placeholder', phone_number: '+1 555 0100' },
    text: '',
    text_entities: [],
    ...options.extra,
  };
}

export function telegramLocation(index: number, options: Common = {}): TelegramFixtureMessage {
  return {
    ...base(index, 'message', options),
    from: options.from ?? 'Sam Example',
    from_id: options.fromId ?? 'user1001',
    location_information: { latitude: 51.5, longitude: -0.12 },
    place_name: 'Synthetic Pier',
    text: '',
    text_entities: [],
    ...options.extra,
  };
}

export function telegramChat(input: Partial<TelegramFixtureChat> & { messages: TelegramFixtureMessage[] }): TelegramFixtureChat {
  return {
    name: input.name === undefined ? 'Synthetic Harbour Group' : input.name,
    type: input.type ?? 'private_group',
    id: input.id ?? 1_000_001,
    messages: input.messages,
  };
}

/** `count` plain messages, `first` being the index of the first one. */
export function telegramTexts(count: number, options: { first?: number; label?: string; from?: string } = {}): TelegramFixtureMessage[] {
  const first = options.first ?? 0;
  return Array.from({ length: count }, (_, offset) =>
    telegramText(first + offset, `${options.label ?? 'The synthetic harbour log'}, entry ${first + offset}.`, options.from ? { from: options.from } : {}));
}

const SECTION_ABOUT = 'Synthetic placeholder text for a part of the export.';

/**
 * A whole-account export in the writer's order: `about`, the personal
 * sections, then `chats` and `left_chats`. The personal sections are written
 * large enough that `chats` starts well past the first few kilobytes, as it
 * does in a real export.
 */
export function telegramFullExport(input: {
  chats?: readonly TelegramFixtureChat[];
  leftChats?: readonly TelegramFixtureChat[];
  /** Entries in `contacts` (default 60). */
  contacts?: number;
  /** Leave the personal sections out, as an export that excluded them does. */
  withoutPersonalSections?: boolean;
  /** Sections to leave out by name. */
  omit?: readonly string[];
} = {}): Record<string, unknown> {
  const omit = new Set(input.omit ?? []);
  const contacts = input.contacts ?? 60;
  const personal: Record<string, unknown> = input.withoutPersonalSections ? {} : {
    personal_information: {
      user_id: 1001,
      first_name: 'Sam',
      last_name: 'Example',
      phone_number: '+1 555 0101',
      username: 'synthetic_sam',
      bio: 'Synthetic account for tests.',
    },
    profile_pictures: [
      { date: '2015-01-04T09:00:00', date_unixtime: '1420362000', photo: 'profile_pictures/photo_1.jpg' },
    ],
    contacts: {
      about: SECTION_ABOUT,
      list: Array.from({ length: contacts }, (_, index) => ({
        first_name: `Contact${index}`,
        last_name: 'Placeholder',
        phone_number: `+1 555 02${String(index).padStart(2, '0')}`,
        date: '2015-01-04T09:00:00',
        date_unixtime: '1420362000',
      })),
    },
    frequent_contacts: {
      about: SECTION_ABOUT,
      list: [{ id: 2002, category: 'people', type: 'personal_chat', name: 'Synthetic Frequent', rating: 0.5 }],
    },
    sessions: {
      about: SECTION_ABOUT,
      list: [{ last_active: '2015-01-04T09:00:00', last_active_unixtime: '1420362000', device_model: 'Synthetic Phone', platform: 'Android' }],
    },
    web_sessions: { about: SECTION_ABOUT, list: [] },
    other_data: { about: SECTION_ABOUT, notes: 'Synthetic other data.' },
  };
  const out: Record<string, unknown> = { about: 'Synthetic placeholder: here is the data you requested.' };
  for (const [key, value] of Object.entries(personal)) if (!omit.has(key)) out[key] = value;
  if (input.chats !== undefined && !omit.has('chats')) out.chats = { about: 'This page lists all chats from this export.', list: [...input.chats] };
  if (input.leftChats !== undefined && !omit.has('left_chats')) out.left_chats = { about: 'This page lists all left chats from this export.', list: [...input.leftChats] };
  return out;
}

/** A single chat's export: the chat's header, then its messages. */
export function telegramSingleChatExport(chat: TelegramFixtureChat): Record<string, unknown> {
  return { name: chat.name, type: chat.type, id: chat.id, messages: chat.messages };
}

/**
 * The JSON text Telegram Desktop writes: one space per level, and a control
 * character as `\xNN` (upper-case hex) where standard JSON would write `\u00NN`.
 */
export function telegramJson(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(
    /(\\\\)|\\u00([01][0-9a-f])/g,
    (whole: string, backslashes: string | undefined, code: string | undefined) =>
      backslashes !== undefined ? whole : `\\x${code!.toUpperCase()}`,
  );
}

/** `result.json` as the file chosen directly, or inside a folder named like an export. */
export function writeTelegramExport(dir: string, text: string, name = 'result.json'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** Telegram's HTML export form: `messages.html` and its page files, with no JSON. */
export function writeTelegramHtmlExport(dir: string): string {
  mkdirSync(join(dir, 'css'), { recursive: true });
  mkdirSync(join(dir, 'js'), { recursive: true });
  writeFileSync(join(dir, 'css', 'style.css'), 'body { margin: 0; }\n');
  writeFileSync(join(dir, 'js', 'script.js'), 'function ShowSynthetic() {}\n');
  const page = join(dir, 'messages.html');
  writeFileSync(page, '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Exported Data</title></head><body><div class="page_wrap">Synthetic chat history.</div></body></html>\n');
  return page;
}
