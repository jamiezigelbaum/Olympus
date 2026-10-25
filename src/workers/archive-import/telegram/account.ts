/**
 * The parts of a Telegram Desktop whole-account export that are not chats
 * (the profile, contacts, frequent contacts, sessions, web sessions, profile
 * pictures, stories, profile music, and `other_data`) as the text of items.
 * Pure: nothing is opened; a picture or file an entry names is only ever text.
 *
 * Shapes are those Telegram Desktop's own writer produces
 * (telegramdesktop/tdesktop, export_output_json.cpp): `personal_information`
 * and `other_data` are one object each (the profile; whatever a source JSON
 * file held); `contacts`, `frequent_contacts`, `sessions` and `web_sessions`
 * are `{about, list: [...]}`; `profile_pictures`, `stories` and
 * `profile_music` are arrays. A time is written twice, as `<name>` (the
 * exporting computer's local time, no zone) and `<name>_unixtime`.
 *
 * One entry is one item, the way a person cites it (a contact, a session, a
 * picture); the profile and the other data are one item each, built from all
 * their fields. The text is a short headline and then a line for each field
 * the entry carries, nested values indented, so nothing an entry says is left
 * out. Dates stay in the text as written: they say when a contact was added or
 * a session last used, not when a message was sent, so no entry has an
 * `authoredAt` (the chats' date range and recency stay the messages').
 */
import { TELEGRAM_MEDIA_KEYS, isRecord, telegramMediaLines, text } from './message.ts';

export interface AccountSection {
  /** The key the export gives the part. */
  readonly name: string;
  /** Where the part's entries are. */
  readonly path: readonly string[];
  /** How the part reads in the title of its items: "Telegram account: <label>". */
  readonly label: string;
  /** The part is one object whose fields together make one item, not one item per field. */
  readonly whole: boolean;
}

export const ACCOUNT_SECTIONS: readonly AccountSection[] = [
  { name: 'personal_information', path: ['personal_information'], label: 'profile', whole: true },
  { name: 'profile_pictures', path: ['profile_pictures'], label: 'profile pictures', whole: false },
  { name: 'stories', path: ['stories'], label: 'stories', whole: false },
  { name: 'profile_music', path: ['profile_music'], label: 'profile music', whole: false },
  { name: 'contacts', path: ['contacts', 'list'], label: 'contacts', whole: false },
  { name: 'frequent_contacts', path: ['frequent_contacts', 'list'], label: 'frequent contacts', whole: false },
  { name: 'sessions', path: ['sessions', 'list'], label: 'sessions', whole: false },
  { name: 'web_sessions', path: ['web_sessions', 'list'], label: 'web sessions', whole: false },
  { name: 'other_data', path: ['other_data'], label: 'other data', whole: true },
];

export function accountTitle(section: AccountSection): string {
  return `Telegram account: ${section.label}`;
}

export interface AccountEntryContent {
  text: string;
  /** Pictures and files the entry names that were not imported. */
  mediaFiles: number;
  /** Their kinds and names, for search context. */
  attachments: string[];
}

/** Nested values deeper than this are written as JSON on one line rather than indented further. */
const MAX_INDENT_DEPTH = 8;
const LATEST_PLAUSIBLE_SECONDS = 4_102_444_800; // 2100-01-01

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return undefined;
}

function labelOf(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The time `<name>_unixtime` says, as an ISO time in UTC, when it is a plausible count of seconds. */
function unixTimeText(value: unknown): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= LATEST_PLAUSIBLE_SECONDS) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function appendFields(lines: string[], indent: string, record: Record<string, unknown>, skip: ReadonlySet<string>, depth: number): void {
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key) || value === null || value === undefined) continue;
    if (key.endsWith('_unixtime')) {
      // The plain time beside it is the one shown; this one only stands in when that is missing.
      const base = key.slice(0, -'_unixtime'.length);
      if (base !== '' && scalarText(record[base]) !== undefined) continue;
      const iso = unixTimeText(value);
      if (iso) {
        lines.push(`${indent}${labelOf(base === '' ? key : base)}: ${iso}`);
        continue;
      }
    }
    appendValue(lines, indent, key, value, depth);
  }
}

function appendValue(lines: string[], indent: string, key: string, value: unknown, depth: number): void {
  const label = labelOf(key);
  const scalar = scalarText(value);
  if (scalar !== undefined) {
    lines.push(`${indent}${label}: ${scalar}`);
    return;
  }
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== undefined);
    if (items.length === 0) return;
    if (items.every((item) => scalarText(item) !== undefined)) {
      lines.push(`${indent}${label}: ${items.map((item) => scalarText(item)).join(', ')}`);
      return;
    }
    if (depth >= MAX_INDENT_DEPTH) {
      lines.push(`${indent}${label}: ${JSON.stringify(items)}`);
      return;
    }
    lines.push(`${indent}${label}:`);
    for (const item of items) {
      const plain = scalarText(item);
      if (plain !== undefined) {
        lines.push(`${indent}  - ${plain}`);
      } else if (isRecord(item)) {
        lines.push(`${indent}  -`);
        appendFields(lines, `${indent}    `, item, new Set(), depth + 1);
      } else {
        lines.push(`${indent}  - ${JSON.stringify(item)}`);
      }
    }
    return;
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return;
    if (depth >= MAX_INDENT_DEPTH) {
      lines.push(`${indent}${label}: ${JSON.stringify(value)}`);
      return;
    }
    lines.push(`${indent}${label}:`);
    appendFields(lines, `${indent}  `, value, new Set(), depth + 1);
  }
}

function nameOf(record: Record<string, unknown>): string | undefined {
  const name = [text(record.first_name), text(record.last_name)].filter(Boolean).join(' ').trim();
  return name === '' ? undefined : name;
}

/** The first line of an entry: what it is and who or what it is of, in a few words. */
function headline(section: AccountSection, record: Record<string, unknown>): string {
  switch (section.name) {
    case 'personal_information': {
      const name = nameOf(record);
      const user = text(record.username);
      return `Telegram profile${name || user ? `: ${[name, user ? `(${user})` : undefined].filter(Boolean).join(' ')}` : ''}`;
    }
    case 'contacts':
      return `Contact: ${nameOf(record) ?? text(record.phone_number) ?? 'no name or number in the export'}`;
    case 'frequent_contacts': {
      const category = text(record.category)?.replace(/_/g, ' ');
      return `Frequent contact: ${text(record.name) ?? 'unnamed'}${category ? ` (${category})` : ''}`;
    }
    case 'sessions': {
      const app = [text(record.application_name), text(record.application_version)].filter(Boolean).join(' ');
      const device = text(record.device_model) ?? text(record.platform);
      return `Telegram session: ${[app || undefined, device ? `on ${device}` : undefined].filter(Boolean).join(' ') || 'device not named in the export'}`;
    }
    case 'web_sessions': {
      const site = text(record.domain_name) ?? text(record.bot_username);
      const browser = text(record.browser);
      return `Web session: ${[site, browser].filter(Boolean).join(', ') || 'site not named in the export'}`;
    }
    case 'profile_pictures':
      return 'Profile picture';
    case 'stories':
      return 'Story';
    case 'profile_music':
      return 'Profile music';
    default:
      return 'Other Telegram account data';
  }
}

/**
 * The text of one entry of a part of the account export. `value` is the entry
 * as the reader parsed it (an object, or for a part of plain values the value).
 */
export function accountEntryContent(section: AccountSection, value: unknown): AccountEntryContent {
  if (!isRecord(value)) {
    const plain = scalarText(value);
    const lines = [headline(section, {})];
    if (plain !== undefined) lines.push(plain);
    else if (value !== null && value !== undefined) appendValue(lines, '', 'value', value, 0);
    return { text: lines.join('\n'), mediaFiles: 0, attachments: [] };
  }
  // A picture or file an entry names (itself, or in a `media` object) is named and counted, never opened.
  const own = telegramMediaLines(value);
  const nested = isRecord(value.media) ? telegramMediaLines(value.media) : { lines: [], mediaFiles: 0, attachments: [] };
  const skip = new Set<string>();
  if (own.lines.length > 0) for (const key of TELEGRAM_MEDIA_KEYS) skip.add(key);
  if (nested.lines.length > 0) skip.add('media');
  const lines = [headline(section, value), ...own.lines, ...nested.lines];
  appendFields(lines, '', value, skip, 0);
  return {
    text: lines.join('\n'),
    mediaFiles: own.mediaFiles + nested.mediaFiles,
    attachments: [...own.attachments, ...nested.attachments],
  };
}
