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
 *   has `action` and `actor` instead of `from` and `text`, and `telegramServiceContent`
 *   turns it into a plain sentence.
 * - A poll, a to-do list, an invoice, a contact and a place are objects whose
 *   words are read (the words of a poll or a list can be formatted, so they
 *   are text in the `text` form). A giveaway, a rich message, paid media and
 *   anything the writer adds later are objects or amounts this reader does not
 *   know how to read: a message that carries one is said to, never counted as
 *   empty.
 */

export interface TelegramMessageContent {
  /** The text of the item: the message's words, then a line for each thing it carries that was not read. */
  text: string;
  /** Media files the message names that were not imported: those in the export (never read) and those the export left out. */
  mediaFiles: number;
  /** The kinds and names of those the message names, for search context (a file with no name has none). */
  attachments: string[];
  /** Whether there is anything to keep. */
  hasContent: boolean;
  /** The message carries something this reader cannot read (a giveaway, a rich message, paid media, a kind the writer added later). */
  unsupported: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A string or whole number as text. */
export function telegramScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
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

/** The keys `mediaLine` reads, so a caller that prints the rest of a record does not print them twice. */
export const TELEGRAM_MEDIA_KEYS: ReadonlySet<string> = new Set([
  'photo', 'file', 'media_type', 'file_name', 'sticker_emoji', 'performer', 'title', 'duration_seconds',
]);

/** A line for each picture or file a record names (never opened), with the count and the names for search. */
export function telegramMediaLines(record: Record<string, unknown>): { lines: string[]; mediaFiles: number; attachments: string[] } {
  const content: TelegramMessageContent = { text: '', mediaFiles: 0, attachments: [], hasContent: false, unsupported: false };
  const lines: string[] = [];
  mediaLine(record, content, lines);
  return { lines, mediaFiles: content.mediaFiles, attachments: content.attachments };
}

function mediaLine(message: Record<string, unknown>, content: TelegramMessageContent, lines: string[]): void {
  const photo = text(message.photo);
  if (photo) {
    if (fileLeftOut(photo)) {
      lines.push('[Photo (not in the export)]');
      content.mediaFiles += 1;
    } else {
      lines.push(`[Photo: ${photo} (not imported)]`);
      content.mediaFiles += 1;
      content.attachments.push(`Photo: ${photo}`);
    }
  }
  const file = text(message.file);
  if (file) {
    const kind = typeof message.media_type === 'string' ? MEDIA_LABELS[message.media_type] : undefined;
    const emoji = kind === 'Sticker' ? text(message.sticker_emoji) : undefined;
    const label = emoji ? `${kind} ${emoji}` : kind ?? 'File';
    const name = text(message.file_name);
    if (fileLeftOut(file)) {
      // The export still names the file it left out; the name is what a search for it finds.
      lines.push(name ? `[${label}: ${name} (not in the export)]` : `[${label} (not in the export)]`);
      content.mediaFiles += 1;
      if (name) content.attachments.push(`${label}: ${name}`);
    } else {
      const track = [text(message.performer), text(message.title)].filter(Boolean).join(' - ');
      const duration = seconds(message.duration_seconds);
      const detail = [name && name !== file ? name : undefined, track || undefined, file, duration].filter(Boolean).join(', ');
      lines.push(`[${label}: ${detail} (not imported)]`);
      content.mediaFiles += 1;
      content.attachments.push(`${label}: ${name ?? file}`);
    }
  }
}

function factLines(message: Record<string, unknown>, lines: string[]): void {
  const contact = message.contact_information;
  if (isRecord(contact)) {
    const name = [text(contact.first_name), text(contact.last_name)].filter(Boolean).join(' ');
    const detail = [name || undefined, text(contact.phone_number)].filter(Boolean).join(', ');
    if (detail) lines.push(`Contact: ${detail}`);
  }
  const place = [text(message.place_name), text(message.address)].filter(Boolean).join(', ');
  if (place) lines.push(`Place: ${place}`);
  const location = message.location_information;
  if (isRecord(location) && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
    lines.push(`Location: ${location.latitude}, ${location.longitude}`);
  }
  const poll = message.poll;
  if (isRecord(poll)) {
    const question = flattenTelegramText(poll.question).trim();
    if (question) lines.push(`Poll: ${question}`);
    if (Array.isArray(poll.answers)) {
      for (const answer of poll.answers) {
        if (!isRecord(answer)) continue;
        const label = flattenTelegramText(answer.text).trim();
        if (!label) continue;
        const voters = typeof answer.voters === 'number' ? ` (${answer.voters} ${answer.voters === 1 ? 'vote' : 'votes'})` : '';
        lines.push(`- ${label}${voters}`);
      }
    }
  }
  // A to-do list is a title and its tasks (the writer calls them `answers`); who ticked what is not exported.
  const todo = message.todo_list;
  if (isRecord(todo)) {
    const title = flattenTelegramText(todo.title).trim();
    const tasks: string[] = [];
    if (Array.isArray(todo.answers)) {
      for (const task of todo.answers) {
        const label = isRecord(task) ? flattenTelegramText(task.text).trim() : '';
        if (label) tasks.push(`- ${label}`);
      }
    }
    if (title || tasks.length > 0) lines.push(title ? `To-do list: ${title}` : 'To-do list:', ...tasks);
  }
  const invoice = message.invoice_information;
  if (isRecord(invoice)) {
    const detail = [text(invoice.title), text(invoice.description)].filter(Boolean).join(', ');
    if (detail) lines.push(`Invoice: ${detail}`);
  }
  const game = [text(message.game_title), text(message.game_description)].filter(Boolean).join(', ');
  if (game) lines.push(`Game: ${game}`);
}

/** Objects of a message whose words are read, or that hold no words of their own. */
const READ_OBJECTS: ReadonlySet<string> = new Set([
  'contact_information', 'location_information', 'poll', 'todo_list', 'invoice_information',
  'text', 'text_entities', 'reactions', 'inline_bot_buttons',
]);

/**
 * Whether the message carries something this reader cannot read: a message
 * the writer marked `unsupported`, paid media, and any object it does not
 * know (a giveaway, a rich message, a kind added after this was written).
 */
function carriesUnsupported(message: Record<string, unknown>): boolean {
  if (message.type === 'unsupported' || message.paid_stars_amount !== undefined) return true;
  for (const [key, value] of Object.entries(message)) {
    if (typeof value === 'object' && value !== null && !READ_OBJECTS.has(key)) return true;
  }
  return false;
}

/**
 * What a (non-service) message keeps: its words, then a line for each
 * picture or file it names (marked as not imported), contact, place, poll,
 * to-do list, invoice or game it carries. Empty when it has none of these;
 * `unsupported` says when that is because it carries what is not read.
 */
export function telegramMessageContent(message: Record<string, unknown>): TelegramMessageContent {
  const content: TelegramMessageContent = { text: '', mediaFiles: 0, attachments: [], hasContent: false, unsupported: carriesUnsupported(message) };
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


// --- Service messages -----------------------------------------------------------

/** Seconds as words: "1 hour 5 minutes 3 seconds". Undefined when it is not a count of seconds. */
function durationWords(value: unknown): string | undefined {
  const total = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(total) || total < 0) return undefined;
  const whole = Math.floor(total);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} ${secs === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/** The people a service message names (`members`, a list of names), joined; their ids are not names. */
function peopleOf(value: unknown): string | undefined {
  const names: string[] = [];
  if (typeof value === 'string' && value.trim() !== '') names.push(value.trim());
  if (Array.isArray(value)) {
    for (const member of value) {
      if (typeof member === 'string' && member.trim() !== '') names.push(member.trim());
      else if (isRecord(member)) {
        const name = text(member.name) ?? text(member.first_name);
        if (name) names.push(name);
      }
    }
  }
  if (names.length === 0) return undefined;
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function quoted(value: unknown): string | undefined {
  const words = text(value);
  return words ? `"${words.trim()}"` : undefined;
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

/** An amount and its currency as the export gives them (an amount may be in the smallest unit; it is shown as written). */
function amountOf(message: Record<string, unknown>): string | undefined {
  const amount = telegramScalar(message.amount) ?? telegramScalar(message.cost);
  const currency = text(message.currency);
  return amount ? (currency ? `${amount} ${currency}` : amount) : undefined;
}

/** Every field a sentence does not use, as `name: value` for the plain ones, so a kind of event this does not know loses nothing. */
function remainingFacts(message: Record<string, unknown>, used: ReadonlySet<string>): string[] {
  const facts: string[] = [];
  for (const [key, value] of Object.entries(message)) {
    if (used.has(key) || key === 'id' || key === 'type' || key === 'date' || key === 'date_unixtime' || key === 'edited' || key === 'edited_unixtime') continue;
    if (key === 'photo' || key === 'file') continue; // named by the media lines
    const label = key.replace(/_/g, ' ');
    if (typeof value === 'string' && value.trim() !== '') facts.push(`${label}: ${value}`);
    else if (typeof value === 'number' || typeof value === 'boolean') facts.push(`${label}: ${value}`);
    else if (Array.isArray(value) || isRecord(value)) {
      const named = peopleOf(value);
      facts.push(`${label}: ${named ?? JSON.stringify(value)}`);
    }
  }
  return facts;
}

/**
 * What a service message (a join, a call, a pin, a new title, a group made...)
 * says, as one plain sentence with who did it, built from the writer's own
 * `action` and the fields that action carries. The common actions have their
 * own sentence; any other (the writer adds new ones) reads "<who>: <action
 * words>." followed by every field it carries, so nothing of it is lost.
 * The sentence names who did it, and the item carries when.
 */
export function telegramServiceContent(message: Record<string, unknown>): TelegramMessageContent {
  const action = text(message.action)?.trim() ?? '';
  const actor = text(message.actor)?.trim();
  const who = actor ?? 'Someone';
  const members = peopleOf(message.members);
  const title = quoted(message.title);
  const used = new Set<string>(['action', 'actor', 'actor_id']);
  const use = (...keys: string[]): void => { for (const key of keys) used.add(key); };
  let sentence: string;
  switch (action) {
    case 'create_group':
      use('title', 'members');
      sentence = `${who} created the group${title ? ` ${title}` : ''}${members ? ` with ${members}` : ''}.`;
      break;
    case 'create_channel':
      use('title');
      sentence = `${actor ? `${actor} created` : 'Created'} the channel${title ? ` ${title}` : ''}.`;
      break;
    case 'edit_group_title':
      use('title');
      sentence = `${who} changed the group name${title ? ` to ${title}` : ''}.`;
      break;
    case 'edit_group_photo':
      use('photo_file_size', 'width', 'height', 'media_spoiler');
      sentence = `${who} changed the group photo.`;
      break;
    case 'delete_group_photo':
      sentence = `${who} removed the group photo.`;
      break;
    case 'invite_members':
      use('members');
      sentence = members ? `${who} added ${members}.` : `${who} added members.`;
      break;
    case 'remove_members':
      use('members');
      sentence = members ? `${who} removed ${members}.` : `${who} removed members.`;
      break;
    case 'join_group_by_link': {
      const inviter = text(message.inviter);
      use('inviter');
      sentence = `${who} joined the group by invite link${inviter ? ` from ${inviter}` : ''}.`;
      break;
    }
    case 'join_group_by_request':
      sentence = `${who} joined the group by request.`;
      break;
    case 'migrate_to_supergroup':
      sentence = 'This group was upgraded to a supergroup.';
      break;
    case 'migrate_from_group':
      use('title');
      sentence = `This supergroup was upgraded from the group${title ? ` ${title}` : ''}.`;
      break;
    case 'pin_message': {
      const pinned = telegramScalar(message.message_id);
      use('message_id', 'reply_to_peer_id');
      sentence = `${who} pinned ${pinned ? `message ${pinned}` : 'a message'}.`;
      break;
    }
    case 'clear_history':
      sentence = `${who} cleared the chat history.`;
      break;
    case 'phone_call': {
      const reason = text(message.discard_reason)?.trim();
      const length = durationWords(message.duration_seconds);
      use('duration_seconds', 'discard_reason');
      if (reason === 'missed') sentence = `Missed phone call from ${who}.`;
      else if (reason === 'busy') sentence = `${who} called; the line was busy.`;
      else sentence = `${who} made a phone call${length ? ` that lasted ${length}` : ''}.`;
      break;
    }
    case 'conference_call': {
      const length = durationWords(message.duration_seconds);
      use('duration_seconds', 'is_active', 'is_missed');
      sentence = message.is_missed === true
        ? `Missed group call from ${who}.`
        : `${who} started a group call${length ? ` that lasted ${length}` : ''}${message.is_active === true ? ' and it is still going' : ''}.`;
      break;
    }
    case 'group_call': {
      const length = durationWords(message.duration);
      use('duration');
      sentence = `${who} started a voice chat${length ? ` that lasted ${length}` : ''}.`;
      break;
    }
    case 'invite_to_group_call':
      use('members');
      sentence = members ? `${who} invited ${members} to the voice chat.` : `${who} invited members to the voice chat.`;
      break;
    case 'joined_telegram':
      sentence = `${who} joined Telegram.`;
      break;
    case 'set_messages_ttl': {
      const period = durationWords(message.period);
      use('period');
      sentence = period ? `${who} set messages to disappear after ${period}.` : `${who} changed when messages disappear.`;
      break;
    }
    case 'topic_created':
      use('title');
      sentence = `${who} created the topic${title ? ` ${title}` : ''}.`;
      break;
    case 'topic_edit': {
      const next = quoted(message.new_title);
      use('new_title');
      sentence = `${who} edited the topic${next ? `, now called ${next}` : ''}.`;
      break;
    }
    case 'send_payment': {
      const amount = amountOf(message);
      use('amount', 'currency');
      sentence = `${who} sent a payment${amount ? ` of ${amount}` : ''}.`;
      break;
    }
    case 'take_screenshot':
      sentence = `${who} took a screenshot.`;
      break;
    case 'information_text': {
      const info = flattenTelegramText(message.text).trim();
      use('text', 'text_entities');
      sentence = info !== '' ? info : `${who}: information.`;
      break;
    }
    case 'boost_apply': {
      const boosts = typeof message.boosts === 'number' ? message.boosts : undefined;
      use('boosts');
      sentence = `${who} boosted the chat${boosts !== undefined ? ` with ${plural(boosts, 'boost')}` : ''}.`;
      break;
    }
    default: {
      const words = action.replace(/_/g, ' ').trim();
      sentence = words !== '' ? `${who}: ${words}.` : `${who}: a service event.`;
    }
  }
  const media = telegramMediaLines(message);
  const lines = [sentence, ...media.lines, ...remainingFacts(message, used)];
  return {
    text: lines.join('\n'),
    mediaFiles: media.mediaFiles,
    attachments: media.attachments,
    hasContent: true,
    unsupported: false,
  };
}
