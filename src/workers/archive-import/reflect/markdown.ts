/**
 * One note of a Reflect Markdown export (a zip with one .md file per note), as
 * a pure function of its text and file name.
 *
 * The files' structure is not published, so this reads liberally: an optional
 * front-matter block (`---` lines around `key: value` pairs, with a title, a
 * created and an updated time, tags as a list or as text), then the note. A
 * block is front matter only when every line in it is a `key: value` pair, a
 * list item of one or a comment, and at least one key is one this reader
 * knows; anything else between two `---` rules is the note, and stays in it.
 * The title is the front matter's, else the first `# ` heading, else the file name.
 * A daily note is named for its day ("Tue, March 21st, 2023.md"); that day is
 * the note's date when the file gives none.
 */
import { reflectDailyNoteDate } from '../../../core/archive-formats.ts';
import { cleanTags, isoTime, type NoteOutcome } from '../notes/note.ts';

const MAX_FRONT_MATTER_LINES = 100;

/** The keys a Reflect front-matter block is known by (lower case); a block with none of them is not taken for one. */
const FRONT_MATTER_KEYS = new Set([
  'created', 'created_at', 'createdat', 'created-at', 'date',
  'id',
  'modified',
  'subject', 'tag', 'tags', 'title',
  'uid', 'updated', 'updated_at', 'updatedat', 'updated-at',
]);

interface FrontMatter {
  meta: Map<string, string | string[]>;
  body: string;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\'')))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * A leading `---` block of `key: value` lines (and `- item` lists), if the
 * text has one and the block is front matter; any other text, including a
 * block between two rules that says something else, is returned whole.
 */
export function splitFrontMatter(text: string): FrontMatter {
  const plain = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = plain.split(/\r?\n/);
  const whole: FrontMatter = { meta: new Map(), body: plain };
  if (lines[0]?.trim() !== '---') return whole;
  let close = -1;
  for (let index = 1; index < lines.length && index <= MAX_FRONT_MATTER_LINES; index += 1) {
    const line = lines[index]!.trim();
    if (line === '---' || line === '...') {
      close = index;
      break;
    }
  }
  if (close < 0) return whole;
  const meta = new Map<string, string | string[]>();
  let listKey: string | undefined;
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey !== undefined) {
      const current = meta.get(listKey);
      if (Array.isArray(current)) current.push(unquote(item[1]!));
      continue;
    }
    const pair = /^([A-Za-z_][\w -]*?)\s*:\s*(.*)$/.exec(line);
    // A line that is no pair: this is text between two rules, not metadata.
    if (!pair) return whole;
    const key = pair[1]!.toLowerCase();
    const value = pair[2]!.trim();
    if (value === '') {
      meta.set(key, []);
      listKey = key;
    } else {
      meta.set(key, value);
      listKey = undefined;
    }
  }
  if (![...meta.keys()].some((key) => FRONT_MATTER_KEYS.has(key))) return whole;
  return { meta, body: lines.slice(close + 1).join('\n') };
}

function metaText(meta: Map<string, string | string[]>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = meta.get(key);
    if (typeof value === 'string' && value.trim() !== '') return unquote(value);
  }
  return undefined;
}

function metaTags(meta: Map<string, string | string[]>): string[] {
  const value = meta.get('tags') ?? meta.get('tag');
  if (Array.isArray(value)) return cleanTags(value);
  if (typeof value !== 'string') return [];
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return cleanTags(inner.split(',').map(unquote));
}

/** One .md file of a Reflect export as a note, or an empty note when nothing is written in it. */
export function parseReflectMarkdown(text: string, fileName: string): NoteOutcome {
  const { meta, body: rest } = splitFrontMatter(text);
  let body = rest.trim();
  const heading = /^#\s+(.+?)(?:\s+#+)?\s*$/m.exec(body);
  const baseName = fileName.replace(/\.(?:md|markdown)$/i, '').trim();
  const fromHeading = body.startsWith('# ') && heading ? heading[1]!.trim() : undefined;
  const title = metaText(meta, 'title', 'subject') ?? fromHeading ?? baseName;
  if (fromHeading !== undefined && title === fromHeading) {
    // The heading is the title, said once.
    body = body.slice(body.indexOf('\n') < 0 ? body.length : body.indexOf('\n') + 1).trim();
  }
  if (body === '') return { kind: 'empty' };
  const createdAt = isoTime(metaText(meta, 'created', 'created_at', 'createdat', 'created-at', 'date'));
  const updatedAt = isoTime(metaText(meta, 'updated', 'updated_at', 'updatedat', 'updated-at', 'modified'));
  const titleDate = reflectDailyNoteDate(fileName);
  return {
    kind: 'note',
    note: {
      title,
      body,
      tags: metaTags(meta),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(titleDate !== undefined ? { titleDate } : {}),
    },
  };
}
