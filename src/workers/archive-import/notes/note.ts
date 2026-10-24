/**
 * What the notes formats (Reflect, Roam) have in common: the shape a parser
 * hands the reader, the findings a notes archive can report, and how a note
 * becomes the one kind of item every note carries.
 *
 * Nothing here knows a format: a parser turns one record of its export into a
 * `NoteOutcome`, and `buildNoteItem` turns a note into a `RawItem`.
 *
 * - Identity: a hash of where the note sits in the archive (file, zip member,
 *   place in the list) and the export's own id, so two notes that share a
 *   title or an id are still two items, and no identity is ever remembered.
 * - Dates: `metadata.authoredAt` is on every item, in one ISO form so dates
 *   sort as text. The note's own created time, else its edited time, else a
 *   date its title carries (a daily note), else the day the archive file was
 *   saved, which is reported (`note_date_assumed`).
 * - Text: the title, tags and dates in plain lines above what was written,
 *   cut at NOTE_MAX_TEXT_CHARS (reported, the start is kept).
 */
import { createHash } from 'node:crypto';
import type { RawItem, SourceClassificationSignals } from '../../../core/contracts.ts';
import type { ArchiveConnectorInput } from '../../../core/archive-formats.ts';
import { compactClassificationSignals, signalText, signalTexts } from '../../../core/classification-signals.ts';

/** Text kept per note; longer notes are cut and reported. */
export const NOTE_MAX_TEXT_CHARS = 1_000_000;
/** One record of a JSON export is read whole up to this size; a bigger one is reported and passed over. */
export const NOTE_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_TAGS = 100;
const MAX_TAG_CHARS = 200;
const MAX_TITLE_CHARS = 500;

/** The kinds of finding a notes archive reports, beside the ones every format can (ARCHIVE_COMMON_FINDINGS). */
export const NOTE_FINDINGS = {
  /** A note with nothing written in it: left out. */
  empty: 'note_empty',
  /** A record that is not a note at all. */
  unreadable: 'note_unreadable',
  /** A record too big to read. */
  tooLarge: 'note_too_large',
  /**
   * A note with something in it Olympus has no rule for (a block, an embed, a
   * body of a shape it does not know): the rest of the note is kept, or the
   * note is left out when nothing else of it could be read. The same word as
   * Telegram's `message_content_unsupported`, for a note.
   */
  unsupported: 'note_content_unsupported',
  /** A note whose export gives no date: the day the archive file was saved is used. */
  dateAssumed: 'note_date_assumed',
} as const;

/** One note as a parser reads it from its export. */
export interface NoteDraft {
  /** The export's own id for the note, when it has one. */
  key?: string;
  title: string;
  /** What was written, as plain lines. Never empty: a note with nothing in it is `empty`. */
  body: string;
  tags: readonly string[];
  /** ISO times the export itself gives. */
  createdAt?: string;
  updatedAt?: string;
  /** A date the title or file name stands for (a daily note), ISO. Not the export's own word, so it comes after its times. */
  titleDate?: string;
  blockCount?: number;
  /**
   * How many parts of the record the parser could not read (a node, a block or
   * a body of a shape it has no rule for) while the rest of it was. Absent: none.
   */
  unsupported?: number;
}

export type NoteOutcome =
  | { kind: 'note'; note: NoteDraft }
  /** A note with nothing written in it: its body is there and empty, or there is none. */
  | { kind: 'empty' }
  /** Not a note. */
  | { kind: 'unreadable' }
  /** A note whose content is all of a shape the parser has no rule for: nothing of it could be read, and that is not the same as nothing being written. */
  | { kind: 'unsupported' };

/** Where a note sits in the archive, for its identity and its position in the findings. */
export interface NotePlace {
  fileIndex: number;
  /** The zip member's index; -1 for a plain file. */
  member: number;
  /** The note's place in its list or its zip. */
  ordinal: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** An id as text: a non-empty string, or a number. */
export function idText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * A time as one ISO string: text a date parses from, or a number of
 * milliseconds (or of seconds, when it is too small to be a time in
 * milliseconds since 1973). Undefined for anything else.
 */
export function isoTime(value: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = Math.abs(value) < 1e11 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    ms = /^-?\d+(?:\.\d+)?$/.test(text) ? (Math.abs(Number(text)) < 1e11 ? Number(text) * 1000 : Number(text)) : Date.parse(text);
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function earliestIso(...times: ReadonlyArray<string | undefined>): string | undefined {
  const known = times.filter((time): time is string => time !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => (a <= b ? a : b));
}

export function latestIso(...times: ReadonlyArray<string | undefined>): string | undefined {
  const known = times.filter((time): time is string => time !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => (a >= b ? a : b));
}

/** Tags as a short, de-duplicated list of text. */
export function cleanTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const text = tag.trim().replace(/^#+/, '').trim().slice(0, MAX_TAG_CHARS);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface NoteItemResult {
  item: RawItem;
  /** The text was longer than NOTE_MAX_TEXT_CHARS and the start of it is kept. */
  truncated: boolean;
  /** The date is the day the archive file was saved, not one the export gives. */
  dateAssumed: boolean;
}

/**
 * The item for one note. `savedAt` is the archive file's own modified time,
 * used for a note the export gives no date at all.
 */
export function buildNoteItem(
  input: ArchiveConnectorInput,
  draft: NoteDraft,
  place: NotePlace,
  savedAt: string,
): NoteItemResult {
  const title = draft.title.trim().slice(0, MAX_TITLE_CHARS);
  const given = draft.createdAt ?? draft.updatedAt ?? draft.titleDate;
  const authoredAt = given ?? savedAt;
  const lines = [
    title,
    draft.tags.length > 0 ? `Tags: ${draft.tags.join(', ')}` : undefined,
    draft.createdAt ? `Created: ${draft.createdAt.slice(0, 10)}` : given ? `Date: ${given.slice(0, 10)}` : undefined,
    draft.updatedAt && draft.updatedAt !== draft.createdAt ? `Updated: ${draft.updatedAt.slice(0, 10)}` : undefined,
  ].filter((line): line is string => line !== undefined && line !== '');
  let text = [lines.join('\n'), draft.body].filter((part) => part !== '').join('\n\n');
  let truncated = false;
  if (text.length > NOTE_MAX_TEXT_CHARS) {
    text = text.slice(0, NOTE_MAX_TEXT_CHARS);
    truncated = true;
  }
  const providerItemId = sha256(`${place.fileIndex}\u0000${place.member}\u0000${place.ordinal}\u0000${draft.key ?? ''}`).slice(0, 32);
  const contentHash = sha256(text);
  const item: RawItem = {
    identity: {
      family: input.format.family,
      provider: input.format.provider,
      accountScope: input.accountScope,
      providerItemId,
      localItemId: `${input.accountScope}:${providerItemId}`,
      sourceVersion: contentHash.slice(0, 32),
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text },
    metadata: Object.freeze({
      title: title || '(untitled)',
      tags: draft.tags,
      authoredAt,
      ...(draft.createdAt ? { createdAt: draft.createdAt } : {}),
      ...(draft.updatedAt ? { updatedAt: draft.updatedAt } : {}),
      ...(draft.blockCount !== undefined ? { blockCount: draft.blockCount } : {}),
      contentHash,
    }),
    fetchedAt: new Date().toISOString(),
  };
  return { item, truncated, dateAssumed: given === undefined };
}

/** What the classifier is told about a note: its title and tags, and no prior. */
export function noteClassificationSignals(item: RawItem): SourceClassificationSignals {
  return compactClassificationSignals({
    title: signalText(item.metadata, 'title'),
    labels: signalTexts(item.metadata, 'tags'),
  });
}
