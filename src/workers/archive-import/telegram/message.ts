/**
 * One Telegram Desktop message (an object of `result.json`'s `messages`) as
 * the text and facts an item is made of. Pure: no file is opened, nothing is
 * read from disk; the paths a message names for its media are only ever text.
 *
 * Shapes are those Telegram Desktop's own writer produces
 * (telegramdesktop/tdesktop, export_output_json.cpp `SerializeMessage` and
 * `SerializeText`):
 * - `text` is a string, or when the message has formatting an array mixing
 *   strings (plain parts) and `{type, text}` objects; `text_entities` is
 *   always the array form. Releases before 5.0 have no `text_entities`.
 * - A photo is `photo` (a path), a document `file` (a path) with `media_type`
 *   (`sticker`, `video_message`, `voice_message`, `animation`, `video_file`,
 *   `audio_file`; none for a plain document). A file the export left out is a
 *   sentence in parentheses in place of the path.
 * - `type` is `service` for joins, calls, pins and the like; such a message
 *   has `action` and `actor` instead of `from` and `text`.
 */

export interface TelegramMessageContent {
  /** The text of the item: the message's words, then a line for each thing it carries that was not read. */
  text: string;
  /** Media files the message names that were not imported: those in the export (never read) and those the export left out. */
  mediaFiles: number;
  /** The kinds and names of those in the export, for search context. */
  attachments: string[];
  /** Whether there is anything to keep. */
  hasContent: boolean;
}

const MAX_LINE_CHARS = 500;
const MAX_POLL_ANSWERS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A string or whole number as text. */
export function telegramScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function cut(value: string): string {
  return value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS)}…` : value;
}

/**
 * The words of a message: strings kept, formatted parts as their text, and a
 * link whose label is not the address as `label (address)` so neither is lost.
 */
export function flattenTelegramText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  let out = '';
  for (const part of value) {
    if (typeof part === 'string') {
      out += part;
    } else if (isRecord(part)) {
      const label = typeof part.text === 'string' ? part.text : '';
      const href = typeof part.href === 'string' ? part.href.trim() : '';
      out += part.type === 'text_link' && href !== '' && href !== label ? (label !== '' ? `${label} (${href})` : href) : label;
    }
  }
  return out;
}

const MEDIA_LABELS: Readonly<Record<string, string>> = {
  sticker: 'Sticker',
  video_message: 'Video message',
  voice_message: 'Voice message',
  animation: 'GIF',
  video_file: 'Video',
  audio_file: 'Audio',
};

/** A path field the export filled with a sentence because it left the file out. */
function fileLeftOut(value: string): boolean {
  return value.startsWith('(') && value.endsWith(')');
}

function seconds(value: unknown): string | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n >= 60 ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` : `${Math.floor(n)} s`;
}

function mediaLine(message: Record<string, unknown>, content: TelegramMessageContent, lines: string[]): void {
  const photo = text(message.photo);
  if (photo) {
    if (fileLeftOut(photo)) {
      lines.push('[Photo (not in the export)]');
      content.mediaFiles += 1;
    } else {
      lines.push(`[Photo: ${cut(photo)} (not imported)]`);
      content.mediaFiles += 1;
      content.attachments.push(`Photo: ${cut(photo)}`);
    }
  }
  const file = text(message.file);
  if (file) {
    const kind = typeof message.media_type === 'string' ? MEDIA_LABELS[message.media_type] : undefined;
    const emoji = kind === 'Sticker' ? text(message.sticker_emoji) : undefined;
    const label = emoji ? `${kind} ${emoji}` : kind ?? 'File';
    if (fileLeftOut(file)) {
      lines.push(`[${label} (not in the export)]`);
      content.mediaFiles += 1;
    } else {
      const name = text(message.file_name);
      const track = [text(message.performer), text(message.title)].filter(Boolean).join(' - ');
      const duration = seconds(message.duration_seconds);
      const detail = [name && name !== file ? name : undefined, track || undefined, cut(file), duration].filter(Boolean).join(', ');
      lines.push(`[${label}: ${detail} (not imported)]`);
      content.mediaFiles += 1;
      content.attachments.push(`${label}: ${name ?? cut(file)}`);
    }
  }
}

function factLines(message: Record<string, unknown>, lines: string[]): void {
  const contact = message.contact_information;
  if (isRecord(contact)) {
    const name = [text(contact.first_name), text(contact.last_name)].filter(Boolean).join(' ');
    const detail = [name || undefined, text(contact.phone_number)].filter(Boolean).join(', ');
    if (detail) lines.push(`Contact: ${cut(detail)}`);
  }
  const place = [text(message.place_name), text(message.address)].filter(Boolean).join(', ');
  if (place) lines.push(`Place: ${cut(place)}`);
  const location = message.location_information;
  if (isRecord(location) && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
    lines.push(`Location: ${location.latitude}, ${location.longitude}`);
  }
  const poll = message.poll;
  if (isRecord(poll)) {
    const question = text(poll.question);
    if (question) lines.push(`Poll: ${cut(question)}`);
    if (Array.isArray(poll.answers)) {
      for (const answer of poll.answers.slice(0, MAX_POLL_ANSWERS)) {
        if (!isRecord(answer)) continue;
        const label = text(answer.text);
        if (!label) continue;
        const voters = typeof answer.voters === 'number' ? ` (${answer.voters} ${answer.voters === 1 ? 'vote' : 'votes'})` : '';
        lines.push(`- ${cut(label)}${voters}`);
      }
    }
  }
  const game = text(message.game_title);
  if (game) lines.push(`Game: ${cut(game)}`);
}

/**
 * What a (non-service) message keeps: its words, then a line for each
 * picture or file it names (marked as not imported), contact, place, poll or
 * game it carries. Empty when it has none of these.
 */
export function telegramMessageContent(message: Record<string, unknown>): TelegramMessageContent {
  const content: TelegramMessageContent = { text: '', mediaFiles: 0, attachments: [], hasContent: false };
  let words = flattenTelegramText(message.text);
  if (words.trim() === '') words = flattenTelegramText(message.text_entities);
  const lines: string[] = [];
  mediaLine(message, content, lines);
  factLines(message, lines);
  const parts = [words.trim() === '' ? '' : words, ...lines].filter((part) => part !== '');
  content.text = parts.join('\n');
  content.hasContent = content.text.trim() !== '';
  return content;
}

// --- Dates --------------------------------------------------------------------

export interface TelegramMessageTime {
  /** ISO time, undefined when the message carries no date that reads. */
  iso?: string;
  /** The time came from a date with no zone in it, read in this computer's zone. */
  assumedZone: boolean;
}

const LATEST_PLAUSIBLE_SECONDS = 4_102_444_800; // 2100-01-01
const ZONELESS_DATE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A time field of a message. `<name>_unixtime` (a string of seconds since
 * 1970, written by releases since 4.0) is exact; the plain ISO date next to
 * it has no zone in it (Telegram writes the exporting computer's local time),
 * so a message that has only that is read in this computer's zone and said so.
 */
export function telegramTime(message: Record<string, unknown>, field: 'date' | 'edited'): TelegramMessageTime {
  const raw = message[`${field}_unixtime`];
  const unix = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  if (Number.isFinite(unix) && unix > 0 && unix < LATEST_PLAUSIBLE_SECONDS) {
    return { iso: new Date(unix * 1000).toISOString(), assumedZone: false };
  }
  const date = message[field];
  if (typeof date !== 'string') return { assumedZone: false };
  const zoneless = ZONELESS_DATE.exec(date.trim());
  if (zoneless) {
    const local = new Date(
      Number(zoneless[1]), Number(zoneless[2]) - 1, Number(zoneless[3]),
      Number(zoneless[4]), Number(zoneless[5]), Number(zoneless[6] ?? 0),
    );
    return Number.isFinite(local.getTime()) ? { iso: local.toISOString(), assumedZone: true } : { assumedZone: false };
  }
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? { iso: new Date(parsed).toISOString(), assumedZone: false } : { assumedZone: false };
}

/** Cuts text to `limit` characters without splitting a surrogate pair. */
export function cutText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const end = value.charCodeAt(limit - 1);
  return value.slice(0, end >= 0xd800 && end <= 0xdbff ? limit - 1 : limit);
}
