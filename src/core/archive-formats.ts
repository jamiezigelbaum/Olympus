/**
 * Archive formats Olympus can import (docs/design/archive-import.md).
 *
 * Pure data like `file-scope-sources.ts`: each entry is a format id, a label,
 * the source family its items belong to, the provider name its items carry,
 * and a cheap detection probe over names and first bytes, never a parse.
 * Adding a format adds one entry here and one thin connector; nothing
 * downstream of the connector branches on the format.
 *
 * Connector factories live with their workers and register here at runtime
 * (`registerArchiveFormatConnector`), so this module imports no worker code.
 */
import type { SourceConnector } from './contracts.ts';
import type { ScopeFileReader, ScopeFileVersion, ScopeRoot } from './scope-safe-fs.ts';
import type { SourceFamily, SourceTrustDomain } from './source-index/types.ts';

/** How many first bytes the probe reads from a file. */
export const ARCHIVE_PROBE_HEAD_BYTES = 4096;
/** How many entries of a chosen folder the probe looks at. */
export const ARCHIVE_PROBE_MAX_CHILDREN = 256;
/**
 * How many more entries the probe keeps, past the first ARCHIVE_PROBE_MAX_CHILDREN,
 * when their names are ones a format asks for (`probeNames`).
 */
export const ARCHIVE_PROBE_MAX_NAMED = 1024;

/** One file or folder the probe looked at. */
export interface ArchiveProbeEntry {
  /**
   * Relative to the chosen path; '' is the chosen path itself. For a member
   * of a zip (`members`) it is the member's name inside the zip, never a
   * path on disk.
   */
  relPath: string;
  name: string;
  kind: 'file' | 'directory';
  /** The first ARCHIVE_PROBE_HEAD_BYTES bytes of a file (fewer when it is shorter). */
  head?: Uint8Array;
  /**
   * A file that is a zip: the members the probe looked at (the first
   * ARCHIVE_PROBE_MAX_CHILDREN, and members a format asks for by name past
   * them), each with its first bytes where they could be read.
   */
  members?: readonly ArchiveProbeEntry[];
  /**
   * A zip with no member a format names as a signature (`signatureNames`)
   * and more members a format asks for (`probeNames`) than the probe read the
   * first bytes of: how many it did not. Absent when it read them all, or
   * when a signature member says what the zip is.
   */
  membersNotLookedAt?: number;
  /**
   * For a JSON file: reads on past `head` to the keys of the first record of
   * the list at `list` (the keys from the document's root; `[]` is the root
   * itself), skipping every value, so a first record that writes a long text
   * before its identifying keys is still told by them. `enough` ends the read
   * once the keys so far decide. Absent when the probe cannot read the file
   * further; undefined when the file holds no such record. Asked only when
   * `head` did not settle the question, so a conclusive head costs nothing.
   */
  firstRecordKeys?(
    list: readonly string[],
    enough?: (keys: ReadonlySet<string>) => boolean,
  ): ReadonlySet<string> | undefined;
  /**
   * For a JSON file: whether the value at the keys `list` (from the document's
   * root) is a list with nothing in it, read past `head` when that did not
   * reach it. Asked only of a zip's JSON member whose notes list the first
   * bytes did not reach and whose first record's keys found no record. Absent
   * when the probe cannot read the file further. The reads of one entry share
   * one allowance (`record-probe.ts`): past it, nothing is found.
   */
  listIsEmpty?(list: readonly string[]): boolean;
}

export interface ArchiveProbe {
  chosen: ArchiveProbeEntry;
  /**
   * For a chosen folder, the entries directly inside it: the first
   * ARCHIVE_PROBE_MAX_CHILDREN, then up to ARCHIVE_PROBE_MAX_NAMED more whose
   * names a format asks for (`probeNames`).
   */
  children: readonly ArchiveProbeEntry[];
  /**
   * For a chosen folder: how many of its entries whose names a format asks for
   * (`probeNames`) the probe did not look at because there were more than
   * ARCHIVE_PROBE_MAX_NAMED of them. Zero when it looked at all.
   */
  notLookedAt?: number;
  /**
   * For a chosen folder: how many files nobody asked for by name the probe did
   * not read the first bytes of (more than it reads, or past the first
   * ARCHIVE_PROBE_MAX_CHILDREN entries), and zips among the files it read
   * that it did not open. A format that detects from the first bytes alone
   * can have its export among them, whatever the format: when nothing is
   * detected, the refusal says the look was not complete. Zero or absent when
   * it read them all.
   */
  othersNotLookedAt?: number;
  /**
   * For a chosen folder, or a chosen zip: whether a read on past a first
   * bytes (`firstRecordKeys`, `listIsEmpty`) was refused because the
   * allowance the folder's files, or the zip's members, share was spent, so
   * some file or member was not looked through as far as it needed. Absent
   * when the probe keeps no such allowance.
   */
  readsRanOut?(): boolean;
}

export interface ArchiveFormatDefinition {
  id: string;
  label: string;
  family: SourceFamily;
  /** The provider name every item of this format carries. */
  provider: string;
  /**
   * How the person is told to choose this kind of export, in the sentence
   * "Choose a file or folder on this computer: <hint>." ("a mail export (an
   * .mbox file ...)"). Absent: the format's label.
   */
  chooseHint?: string;
  /** How an answer's citation names this format's items ("Imported mail"); absent: the family's word. */
  citationLabel?: string;
  /**
   * File and zip-member names (`*` and `?` wildcards, case-insensitive) this
   * format recognises itself by. A folder of thousands of files, or a zip of
   * thousands of members, hides the one file that says what it is; the
   * probe lists these names even past its usual bound and reads their first
   * bytes before any other file's. Absent: only the usual look.
   */
  probeNames?: readonly string[];
  /**
   * The few `probeNames` that say what the export is by themselves (`result.json`,
   * `_chat.txt`), as against patterns that match any file of a kind (`*.txt`).
   * The probe lists and reads these before the broad ones, so a hundred
   * ordinary text files ahead of `_chat.txt` in a zip or a folder cannot hide
   * it. They count as asked names without being listed in `probeNames` too.
   */
  signatureNames?: readonly string[];
  /**
   * Other forms of this format's export that cannot be read, recognised by the
   * same cheap probe, with what the person can do instead. Only consulted when
   * no format matched: the refusal then carries the advice beside the list of
   * what is supported.
   */
  unsupportedVariants?: readonly ArchiveUnsupportedVariant[];
  /**
   * The files to read, relative to the chosen path and in reading order, when
   * the probe is this format; undefined when it is not.
   */
  detect(probe: ArchiveProbe): readonly string[] | undefined;
  /**
   * For a chosen folder: how many of its files look like this format's
   * exports but were not taken, because nothing besides their first bytes
   * says so. They are counted and told, never silently left out.
   */
  unconfirmed?(probe: ArchiveProbe): number;
}

/**
 * An export Olympus recognises and cannot read: `advice` says, in plain words
 * and without the person's file names, how to get one it can.
 */
export interface ArchiveUnsupportedVariant {
  matches(probe: ArchiveProbe): boolean;
  advice: string;
}

export type ArchiveDetection =
  | { kind: 'match'; format: ArchiveFormatDefinition; files: readonly string[] }
  | { kind: 'none'; supported: readonly string[]; advice?: string }
  | { kind: 'ambiguous'; formats: readonly string[] };

const FROM_LINE = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

function startsWithFromLine(head: Uint8Array | undefined): boolean {
  if (!head || head.length < FROM_LINE.length) return false;
  return FROM_LINE.every((byte, index) => head[index] === byte);
}

/**
 * Mail in mbox form: one file that starts with a `From ` line (a Google
 * Takeout `.mbox` file, or a Thunderbird mail file, which has no extension),
 * or Apple Mail's "Export Mailbox" folder `Name.mbox` holding an `mbox` file.
 */
export const MBOX_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'mbox',
  label: 'Mail (mbox)',
  family: 'email',
  provider: 'mbox',
  chooseHint: 'a mail export (an .mbox file from Google Takeout or Thunderbird, or an .mbox folder from Apple Mail)',
  citationLabel: 'Imported mail',
  detect(probe: ArchiveProbe): readonly string[] | undefined {
    if (probe.chosen.kind === 'file') return startsWithFromLine(probe.chosen.head) ? [''] : undefined;
    if (!probe.chosen.name.toLowerCase().endsWith('.mbox')) return undefined;
    const inner = probe.children.find((entry) =>
      entry.kind === 'file' && entry.name === 'mbox' && startsWithFromLine(entry.head));
    return inner ? [inner.relPath] : undefined;
  },
});

// --- WhatsApp chat export ------------------------------------------------------

// The signature of a WhatsApp message line, as a first line: a date and a
// time in brackets, or a date and a time and a dash. The connector's grammar
// (workers/archive-import/whatsapp/grammar.ts) reads every style the phones
// write and decides what a line means; detection only has to tell a chat
// export from other text, so this stays a loose shape and a test holds it in
// step with the grammar.
const WHATSAPP_DATE = String.raw`\d{1,4}[./-]\s?\d{1,2}[./-]\s?\d{1,4}`;
const WHATSAPP_TIME = String.raw`\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[ap]\.?\s?m\.?)?`;
const WHATSAPP_FIRST_LINE = new RegExp(
  `^(?:\\[\\s?${WHATSAPP_DATE},?\\s+${WHATSAPP_TIME}\\s?\\]|${WHATSAPP_DATE},?\\s+${WHATSAPP_TIME}\\s[-\\u2013]\\s)`,
  'i',
);
// Direction marks, a byte order mark and no-break spaces that phones put around a line.
const WHATSAPP_LINE_NOISE = new RegExp('[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
const WHATSAPP_NARROW_SPACES = new RegExp('[\\u00a0\\u202f\\u2007\\u2009]', 'g');
// How WhatsApp names the text of an export: iOS `_chat.txt`, Android `WhatsApp Chat with <name>.txt`.
const WHATSAPP_TEXT_NAME = /^(?:_chat|whatsapp chat (?:with|-)\s+\S.*)\.txt$/i;

function lastNameOf(name: string): string {
  return name.split('/').pop() ?? name;
}

function whatsAppNoiseName(name: string): boolean {
  const base = lastNameOf(name);
  return name.endsWith('/') || name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')
    || base.startsWith('._') || base === '.DS_Store';
}

/** Whether a name says it is the text of a WhatsApp export: the evidence a folder's file needs. */
function whatsAppNamed(name: string): boolean {
  return !whatsAppNoiseName(name) && WHATSAPP_TEXT_NAME.test(lastNameOf(name));
}

function startsLikeWhatsAppChat(head: Uint8Array | undefined): boolean {
  if (!head || head.length < 10 || head.includes(0)) return false;
  for (const raw of new TextDecoder('utf-8').decode(head).split('\n').slice(0, 8)) {
    const line = raw.replace(WHATSAPP_LINE_NOISE, '').replace(WHATSAPP_NARROW_SPACES, ' ').replace(/\r$/, '');
    if (line.trim() === '') continue;
    return WHATSAPP_FIRST_LINE.test(line);
  }
  return false;
}

/**
 * Whether a file starts like a chat export. A zip is one when a text member of it
 * does; with `needName`, the member (or the text file) must also be named as
 * WhatsApp names an export. A header-shaped first line alone is the weaker evidence.
 */
function whatsAppIsExport(entry: ArchiveProbeEntry, needName: boolean): boolean {
  if (entry.kind !== 'file') return false;
  if (entry.members) {
    return entry.members.some((member) =>
      member.kind === 'file' && !whatsAppNoiseName(member.relPath) && member.relPath.toLowerCase().endsWith('.txt')
      && (!needName || whatsAppNamed(member.relPath)) && startsLikeWhatsAppChat(member.head));
  }
  return entry.name.toLowerCase().endsWith('.txt') && (!needName || whatsAppNamed(entry.name)) && startsLikeWhatsAppChat(entry.head);
}

/**
 * A WhatsApp chat export: the text file of "Export Chat" (`_chat.txt` from an
 * iPhone, `WhatsApp Chat with <name>.txt` from an Android phone), or the zip
 * WhatsApp shares, which holds that text file and the chat's media. A chosen
 * folder imports every export in it.
 *
 * What counts as an export depends on who chose it. A file the person chose
 * themselves is one when it starts like a chat (any name). A file found in a
 * chosen folder needs more: a text file named as WhatsApp names it, or a zip
 * holding one, and the start of a chat inside. A header-shaped line alone is
 * not enough there: a build log or a debug dump can start the same way.
 */
export const WHATSAPP_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'whatsapp_chat',
  label: 'WhatsApp chat export',
  family: 'chat',
  provider: 'whatsapp_export',
  chooseHint: 'a WhatsApp chat export (the .zip or the text file from Export Chat, or a folder of them)',
  citationLabel: 'WhatsApp',
  // Every text file and every zip is looked at, however it is named: the evidence is inside (see above).
  // The names WhatsApp gives its exports are looked at before the rest, so ordinary files ahead of them cannot hide them.
  probeNames: Object.freeze(['*.txt', '*.zip']),
  signatureNames: Object.freeze(['_chat.txt', 'WhatsApp Chat with *.txt', 'WhatsApp Chat - *.txt', 'WhatsApp Chat*.zip']),
  detect(probe: ArchiveProbe): readonly string[] | undefined {
    if (probe.chosen.kind === 'file') return whatsAppIsExport(probe.chosen, false) ? [''] : undefined;
    const found = probe.children.filter((entry) => whatsAppIsExport(entry, true)).map((entry) => entry.relPath).sort();
    return found.length > 0 ? found : undefined;
  },
  unconfirmed(probe: ArchiveProbe): number {
    if (probe.chosen.kind === 'file') return 0;
    // Files that start like a chat but nothing else says they are an export: left alone, and counted.
    return probe.children.filter((entry) => !whatsAppIsExport(entry, true) && whatsAppIsExport(entry, false)).length;
  },
});

// --- Notes exports: Reflect and Roam --------------------------------------------

const leniencyDecoder = new TextDecoder('utf-8');

/** A probed head as text; a byte order mark is dropped and a cut at the end is forgiven. */
export function archiveHeadText(head: Uint8Array | undefined): string {
  return head && head.length > 0 ? leniencyDecoder.decode(head) : '';
}

/**
 * A name that is not part of an export: the metadata macOS adds to a zip
 * (`__MACOSX/`, `._name`) and hidden files such as `.DS_Store`.
 */
export function isJunkArchiveMember(name: string): boolean {
  const parts = name.split('/').filter((part) => part !== '');
  return parts.includes('__MACOSX') || (parts[parts.length - 1] ?? '').startsWith('.');
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "Tue, March 21st, 2023.md": how Reflect's Markdown export names a daily note (its JSON export titles one the same way, without the extension). */
const DAILY_NOTE_FILE = /^([a-z]+),?\s+([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:\.(?:md|markdown))?$/i;

/**
 * The day a Reflect daily note's file name or title stands for ("2023-03-21T12:00:00.000Z",
 * midday so no time zone moves it a day), or undefined for any other name.
 */
export function reflectDailyNoteDate(fileName: string): string | undefined {
  const match = DAILY_NOTE_FILE.exec(fileName.trim());
  if (!match) return undefined;
  const weekday = match[1]!.slice(0, 3).toLowerCase();
  const month = MONTHS.indexOf(match[2]!.slice(0, 3).toLowerCase());
  const day = Number(match[3]);
  const year = Number(match[4]);
  if (!WEEKDAYS.includes(weekday) || month < 0 || day < 1 || day > 31) return undefined;
  const at = new Date(Date.UTC(year, month, day, 12));
  return at.getUTCMonth() === month && at.getUTCDate() === day ? at.toISOString() : undefined;
}

/**
 * The key a Reflect JSON export keeps its list of notes under when the document
 * is an object (`{"notes": [...]}`); Reflect's connector reads the same list.
 */
export const REFLECT_NOTES_LIST_KEY = 'notes';

/** What the first bytes of a JSON document show of its list of records. */
interface HeadRecords {
  /** `list`: the document is the list; `notes`: it is an object whose `notes` key holds the list. */
  shape: 'list' | 'notes';
  /** The keys of every record that is a direct element of the list, each as far as the head shows it. */
  records: ReadonlySet<string>[];
  /** The list closed within the head with no element in it at all. */
  empty: boolean;
  /**
   * The keys of the first record are not all shown: the head ended inside it,
   * or (in an object) before the list's own key was reached.
   */
  firstRecordCut: boolean;
  /** An object whose notes list the head did not reach. */
  unreached: boolean;
}

/**
 * The keys of the records at the head of a JSON document: every object that is
 * a direct element of its top-level list, or of the list under the object's notes key.
 * A record cut off by the end of the head keeps the keys seen so far. Only
 * keys count: a word inside a piece of text never does.
 */
function headRecordKeys(head: Uint8Array | undefined): HeadRecords | undefined {
  const text = archiveHeadText(head);
  const n = text.length;
  let i = 0;
  const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';
  while (i < n && isSpace(text[i])) i += 1;
  const stack: Array<'a' | 'o'> = [];
  let shape: 'list' | 'notes' | undefined;
  let listDepth = 0;
  let closed = false;
  let hasElements = false;
  // The document is an object that goes on past the head without its notes key shown, or with the key's value cut off.
  let objectRoot = false;
  // The notes key is there and holds something that is not a list: nothing to read on for.
  let notesNotAList = false;
  if (text[i] === '[') {
    shape = 'list';
    listDepth = 1;
    stack.push('a');
  } else if (text[i] === '{') {
    objectRoot = true;
    stack.push('o');
  } else {
    return undefined;
  }
  i += 1;
  const records: Set<string>[] = [];
  let current: Set<string> | undefined;
  while (i < n) {
    const char = text[i]!;
    // Anything directly in the list that is not a separator is an element, whatever its kind.
    if (listDepth > 0 && stack.length === listDepth && !isSpace(char) && char !== ',' && char !== ']') hasElements = true;
    if (char === '"') {
      let end = i + 1;
      while (end < n && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= n) break;
      const raw = text.slice(i + 1, end);
      let after = end + 1;
      while (after < n && isSpace(text[after])) after += 1;
      if (text[after] === ':' && stack[stack.length - 1] === 'o') {
        if (listDepth > 0 && stack.length === listDepth + 1) {
          current?.add(raw);
        } else if (shape === undefined && stack.length === 1 && raw === REFLECT_NOTES_LIST_KEY) {
          let value = after + 1;
          while (value < n && isSpace(text[value])) value += 1;
          if (text[value] === '[') {
            shape = 'notes';
            listDepth = 2;
          } else if (value < n) {
            notesNotAList = true;
          }
        }
      }
      i = end + 1;
      continue;
    }
    if (char === '[' || char === '{') {
      stack.push(char === '[' ? 'a' : 'o');
      if (char === '{' && listDepth > 0 && stack.length === listDepth + 1) {
        current = new Set<string>();
        records.push(current);
      }
    } else if (char === ']' || char === '}') {
      stack.pop();
      // The list itself has closed: nothing after it is one of its records.
      if (listDepth > 0 && stack.length < listDepth) {
        closed = true;
        listDepth = 0;
      }
      if (stack.length === 0) break;
      if (listDepth > 0 && stack.length === listDepth) current = undefined;
    }
    i += 1;
  }
  if (!shape) {
    // An object still open at the end of the head, whose notes key has not shown: the list may follow further down.
    if (objectRoot && !notesNotAList && stack.length > 0) {
      return { shape: 'notes', records: [], empty: false, firstRecordCut: true, unreached: true };
    }
    return undefined;
  }
  const open = listDepth > 0;
  return { shape, records, empty: closed && !hasElements, firstRecordCut: open && records.length === 1 && current !== undefined, unreached: false };
}

/** Keys that carry what a Reflect note says. */
const REFLECT_BODY_KEYS = ['content', 'body', 'document_json', 'documentJson'] as const;
/** Keys that carry a Reflect note's title or dates. */
const REFLECT_NOTE_KEYS = ['subject', 'title', 'created_at', 'createdAt', 'updated_at', 'updatedAt'] as const;
/** Keys only Roam's pages and blocks carry: their times and who made them. */
const ROAM_TIME_KEYS = ['create-time', 'edit-time', 'create-email', 'edit-email'] as const;

/** A record that says something and is titled or dated, in Reflect's keys. One key alone is any application's data. */
function isReflectRecord(keys: ReadonlySet<string>): boolean {
  return REFLECT_BODY_KEYS.some((key) => keys.has(key)) && REFLECT_NOTE_KEYS.some((key) => keys.has(key));
}

/** A titled record with Roam's keys: its times or authors, or its blocks with an id. Blocks alone are any outline. */
function isRoamRecord(keys: ReadonlySet<string>): boolean {
  return keys.has('title') && (ROAM_TIME_KEYS.some((key) => keys.has(key)) || (keys.has('children') && keys.has('uid')));
}

/** Whether a record's keys say a note is Reflect's or a page is Roam's, or both. */
function recordsFormat(records: readonly ReadonlySet<string>[], shape: 'list' | 'notes'): 'reflect' | 'roam' | undefined {
  const reflect = records.some(isReflectRecord);
  const roam = records.some(isRoamRecord);
  if (reflect === roam) return undefined;
  // Roam's export is a bare list of pages.
  if (roam) return shape === 'list' ? 'roam' : undefined;
  return 'reflect';
}

/** What a probe entry can say of a JSON file: its first bytes, and the way on to the keys they did not reach. */
export interface ArchiveJsonProbe {
  head?: Uint8Array | undefined;
  firstRecordKeys?: ArchiveProbeEntry['firstRecordKeys'];
  listIsEmpty?: ArchiveProbeEntry['listIsEmpty'];
}

/**
 * Which notes export a JSON file is, if exactly one: judged on the keys of its
 * first records (a Reflect note says something and is titled or dated; a Roam
 * page is titled and has its times or blocks with an id), never on a word
 * anywhere else. A file that shows both, or neither, is neither: the person
 * is told what Olympus does import rather than have it guess.
 *
 * The first bytes decide when they can. When they end inside the first record,
 * before the keys that would say, the probe reads on to the end of that record
 * (skipping values, `firstRecordKeys`) and the decision is made on all of it.
 */
function notesJsonFormat(probe: ArchiveJsonProbe): 'reflect' | 'roam' | undefined {
  const parsed = headRecordKeys(probe.head);
  if (!parsed) return undefined;
  const fromHead = recordsFormat(parsed.records, parsed.shape);
  if (fromHead || !parsed.firstRecordCut || !probe.firstRecordKeys) return fromHead;
  // Every format asks about the same entry; the file is read on once.
  let scanned = SCANNED.get(probe);
  if (!scanned) {
    const keys = probe.firstRecordKeys(parsed.shape === 'list' ? [] : [REFLECT_NOTES_LIST_KEY], (seen) => isReflectRecord(seen) || isRoamRecord(seen));
    scanned = { keys };
    SCANNED.set(probe, scanned);
  }
  return scanned.keys ? recordsFormat([scanned.keys], parsed.shape) : undefined;
}

/** What reading on past the first bytes found for an entry, so the formats that ask about it share one read. */
const SCANNED = new WeakMap<object, { keys: ReadonlySet<string> | undefined }>();

/** Whether the first bytes show a list that closes with nothing in it (`[]`, or `{"notes": []}` when `inNotes`). */
function isEmptyRecordList(head: Uint8Array | undefined, inNotes: boolean): boolean {
  const parsed = headRecordKeys(head);
  return parsed !== undefined && parsed.empty && (inNotes || parsed.shape === 'list');
}

/** Whether a file's first bytes are a Reflect JSON export: a list of notes (or an object holding a `notes` list) in Reflect's keys. */
export function looksLikeReflectJson(head: Uint8Array | undefined): boolean {
  return notesJsonFormat({ head }) === 'reflect';
}

/** Whether a file's first bytes are a Roam JSON export: a list of titled pages with Roam's keys. */
export function looksLikeRoamJson(head: Uint8Array | undefined): boolean {
  return notesJsonFormat({ head }) === 'roam';
}

/**
 * Whether a JSON file inside a zip may be read as a Reflect export: it is one
 * (read on past its first bytes when they do not say), or it is an export's
 * list with nothing in it, which reads as no notes and is not another thing.
 */
export function acceptsReflectJson(probe: ArchiveJsonProbe): boolean {
  if (notesJsonFormat(probe) === 'reflect' || isEmptyRecordList(probe.head, true)) return true;
  // An object whose notes list is further down than the first bytes reach may hold an empty one; a list with a record in it is not empty.
  if (!probe.listIsEmpty || SCANNED.get(probe)?.keys) return false;
  return headRecordKeys(probe.head)?.unreached === true && probe.listIsEmpty([REFLECT_NOTES_LIST_KEY]);
}

/** Whether a JSON file inside a zip may be read as a Roam export: a list of pages, or an empty list. */
export function acceptsRoamJson(probe: ArchiveJsonProbe): boolean {
  return notesJsonFormat(probe) === 'roam' || isEmptyRecordList(probe.head, false);
}

/**
 * A file this format reads: the chosen file itself, or for a chosen folder the
 * one file inside it that does. Two candidates in a folder is no match, never a guess.
 */
function detectFile(probe: ArchiveProbe, reads: (entry: ArchiveProbeEntry) => boolean): readonly string[] | undefined {
  if (probe.chosen.kind === 'file') return reads(probe.chosen) ? [''] : undefined;
  const found = probe.children.filter((entry) => entry.kind === 'file' && !isJunkArchiveMember(entry.name) && reads(entry));
  return found.length === 1 ? [found[0]!.relPath] : undefined;
}

/** The JSON files inside a zip, as the probe lists them. */
function zipJsonMembers(entry: ArchiveProbeEntry): ArchiveProbeEntry[] {
  return (entry.members ?? []).filter((member) =>
    member.kind === 'file' && /\.json$/i.test(member.name) && !isJunkArchiveMember(member.relPath));
}

/**
 * A JSON export, as a .json file or as a zip holding one. A zip is this
 * format's when one of its JSON files is and none is the other notes
 * format's: a zip of both is not guessed at. (Its other JSON files are not
 * read as this format; the connector leaves them out and says so.)
 */
function readsJsonExport(
  entry: ArchiveProbeEntry,
  format: 'reflect' | 'roam',
): boolean {
  const other = format === 'reflect' ? 'roam' : 'reflect';
  if (entry.members) {
    const members = zipJsonMembers(entry).map((member) => notesJsonFormat(member));
    return members.includes(format) && !members.includes(other);
  }
  return notesJsonFormat(entry) === format;
}

/** Reflect's export as one JSON file (or a zip holding it): the notes with their dates and tags. */
export const REFLECT_JSON_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'reflect-json',
  label: 'Reflect notes (JSON)',
  family: 'note',
  provider: 'reflect',
  chooseHint: 'a Reflect export in JSON (the .json file, or the .zip that holds it)',
  citationLabel: 'Reflect',
  probeNames: Object.freeze(['*.json']),
  detect: (probe: ArchiveProbe) => detectFile(probe, (entry) => readsJsonExport(entry, 'reflect')),
});

/**
 * Reflect's export as a zip of Markdown files, one note each. Markdown alone
 * says nothing about which app wrote it (Roam's Markdown export is a zip of
 * .md files too), so it must show Reflect's hand: its name, the way it names
 * a daily note, or a link to Reflect. A zip that does not is not guessed at.
 */
export const REFLECT_MARKDOWN_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'reflect-markdown',
  label: 'Reflect notes (Markdown zip)',
  family: 'note',
  provider: 'reflect',
  chooseHint: 'a Reflect export as Markdown (the .zip file)',
  citationLabel: 'Reflect',
  probeNames: Object.freeze(['*, *, ????.md']),
  detect: (probe: ArchiveProbe) => detectFile(probe, (entry) => {
    if (!entry.members || /^roam/i.test(entry.name)) return false;
    const files = entry.members.filter((member) => member.kind === 'file' && !isJunkArchiveMember(member.relPath));
    if (files.some((member) => /\.json$/i.test(member.name))) return false;
    const notes = files.filter((member) => /\.(?:md|markdown)$/i.test(member.name));
    if (notes.length === 0) return false;
    return /reflect/i.test(entry.name)
      || notes.some((member) => reflectDailyNoteDate(member.name) !== undefined)
      || notes.some((member) => /reflect\.app\//i.test(archiveHeadText(member.head)));
  }),
});

/** Roam's "Export All" as JSON (or a zip holding the .json): a list of pages, each a tree of blocks. */
export const ROAM_JSON_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'roam-json',
  label: 'Roam notes (JSON)',
  family: 'note',
  provider: 'roam',
  chooseHint: 'a Roam export in JSON (the .json file from Export All, or the .zip that holds it)',
  citationLabel: 'Roam',
  probeNames: Object.freeze(['*.json']),
  detect: (probe: ArchiveProbe) => detectFile(probe, (entry) => readsJsonExport(entry, 'roam')),
});

// --- Evernote export (.enex) ------------------------------------------------------

/**
 * Whether a file's first bytes are an Evernote export: XML whose root (or
 * document type) is `en-export`, after the XML declaration, a byte order mark,
 * comments and space.
 */
export function looksLikeEnex(head: Uint8Array | undefined): boolean {
  const text = archiveHeadText(head).replace(/^\ufeff/, '');
  const start = /^\s*(?:<\?xml[\s\S]*?\?>)?(?:\s*<!--[\s\S]*?-->)*\s*(?:<!DOCTYPE\s+([A-Za-z_][\w.:-]*)|<([A-Za-z_][\w.:-]*))/i.exec(text);
  return start !== null && (start[1] ?? start[2]) === 'en-export';
}

/**
 * Evernote's export: one `.enex` file (a notebook, or the notes chosen in
 * "Export notes"), or a folder of them. Each note's attachments are inside the
 * file, in base64, and become child items read on their own. A zip holding
 * .enex files is not read; choosing one says what is.
 */
export const EVERNOTE_ENEX_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'evernote-enex',
  label: 'Evernote export (.enex)',
  family: 'note',
  provider: 'evernote',
  chooseHint: 'an Evernote export (the .enex file, or a folder of them)',
  citationLabel: 'Evernote',
  probeNames: Object.freeze(['*.enex']),
  detect(probe: ArchiveProbe): readonly string[] | undefined {
    if (probe.chosen.kind === 'file') return looksLikeEnex(probe.chosen.head) ? [''] : undefined;
    const files = probe.children
      .filter((entry) => entry.kind === 'file' && !isJunkArchiveMember(entry.name) && looksLikeEnex(entry.head))
      .map((entry) => entry.relPath)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return files.length > 0 ? files : undefined;
  },
});

// --- Telegram Desktop export -----------------------------------------------------

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
/**
 * The top-level sections Telegram Desktop's "Export Telegram data" can write
 * (export_output_json.cpp `JsonWriter`), besides `about`.
 */
export const TELEGRAM_EXPORT_SECTIONS = Object.freeze([
  'personal_information', 'profile_pictures', 'stories', 'profile_music', 'contacts',
  'frequent_contacts', 'sessions', 'web_sessions', 'other_data', 'chats', 'left_chats',
] as const);
// A whole-account export opens with `about` and then its first section; a
// single-chat export opens with the chat's header (name, type, id) and then
// `messages`. The writer is fixed, so the first keys decide, whatever follows;
// every section is an object or a list.
const TELEGRAM_FULL_HEAD = new RegExp(
  String.raw`^\s*\{\s*(?:"about"\s*:\s*${JSON_STRING}\s*,\s*)?"(?:${TELEGRAM_EXPORT_SECTIONS.join('|')})"\s*:\s*[\[{]`,
);
const TELEGRAM_CHAT_HEAD = new RegExp(
  String.raw`^\s*\{\s*(?:"name"\s*:\s*(?:null|${JSON_STRING})\s*,\s*)?"type"\s*:\s*(?:null|${JSON_STRING})\s*,\s*"id"\s*:\s*-?\d+\s*,\s*"messages"\s*:\s*\[`,
);
const TELEGRAM_HTML_NAME = /^(?:messages\d*|export_results)\.html?$/i;

function isTelegramJsonHead(head: Uint8Array | undefined): boolean {
  if (!head || head.length === 0) return false;
  const text = new TextDecoder('utf-8').decode(head);
  return TELEGRAM_FULL_HEAD.test(text) || TELEGRAM_CHAT_HEAD.test(text);
}

/**
 * Telegram Desktop's JSON export: `result.json`, as the whole-account export
 * ("Export Telegram data") or one chat's ("Export chat history") writes it.
 * Chosen directly as a file, or as the folder that holds it. Telegram's HTML
 * form of the same export (`messages.html`) is recognised and turned away
 * with what to do instead.
 */
export const TELEGRAM_JSON_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'telegram_json',
  label: 'Telegram Desktop export (JSON)',
  family: 'chat',
  provider: 'telegram_export',
  chooseHint: 'a Telegram Desktop export (its result.json file, or the folder that holds it; export it as Machine-readable JSON)',
  citationLabel: 'Telegram',
  probeNames: ['result.json', 'messages.html', 'export_results.html'],
  unsupportedVariants: Object.freeze([
    Object.freeze({
      matches(probe: ArchiveProbe): boolean {
        if (probe.chosen.kind === 'file') return TELEGRAM_HTML_NAME.test(probe.chosen.name);
        return probe.children.some((entry) => entry.kind === 'file' && TELEGRAM_HTML_NAME.test(entry.name));
      },
      advice: 'This looks like a Telegram Desktop export in its HTML form, which Olympus cannot read. In Telegram Desktop, export again (Settings, Advanced, Export Telegram data, or Export chat history in a chat\'s menu) and set the format to Machine-readable JSON, or Both. Then choose the new result.json or the folder that holds it.',
    }),
  ]),
  detect(probe: ArchiveProbe): readonly string[] | undefined {
    if (probe.chosen.kind === 'file') return isTelegramJsonHead(probe.chosen.head) ? [''] : undefined;
    const inner = probe.children.find((entry) =>
      entry.kind === 'file' && entry.name.toLowerCase() === 'result.json' && isTelegramJsonHead(entry.head));
    return inner ? [inner.relPath] : undefined;
  },
});

export const ARCHIVE_FORMATS: readonly ArchiveFormatDefinition[] = Object.freeze([
  MBOX_ARCHIVE_FORMAT,
  WHATSAPP_ARCHIVE_FORMAT,
  REFLECT_JSON_ARCHIVE_FORMAT,
  REFLECT_MARKDOWN_ARCHIVE_FORMAT,
  ROAM_JSON_ARCHIVE_FORMAT,
  TELEGRAM_JSON_ARCHIVE_FORMAT,
  EVERNOTE_ENEX_ARCHIVE_FORMAT,
]);

export function getArchiveFormat(formatId: string): ArchiveFormatDefinition | undefined {
  return ARCHIVE_FORMATS.find((format) => format.id === formatId);
}

/** The format whose items carry this provider name, if any. */
export function archiveFormatForProvider(
  provider: string,
  formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS,
): ArchiveFormatDefinition | undefined {
  return formats.find((format) => format.provider === provider);
}

/**
 * The provider name on a family's stores when its formats do not share one:
 * a store set belongs to the family, not to whichever format came first.
 */
export const ARCHIVE_NEUTRAL_PROVIDER = 'archive';

/**
 * The provider a family's stores carry: the formats' own when they all share
 * it, else the neutral one. Items keep their own format's provider either
 * way; this only names the store set.
 */
export function archiveFamilyProvider(
  family: SourceFamily,
  formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS,
): string {
  const providers = new Set(archiveFormatsOfFamily(family, formats).map((format) => format.provider));
  const only = providers.size === 1 ? [...providers][0] : undefined;
  return only ?? ARCHIVE_NEUTRAL_PROVIDER;
}

/**
 * Whether a provider name is an archive's: a format's own, or the neutral one.
 */
export function isArchiveProvider(
  provider: string,
  formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS,
): boolean {
  return provider === ARCHIVE_NEUTRAL_PROVIDER || archiveFormatForProvider(provider, formats) !== undefined;
}

/** The formats of one family, in the order they are registered. */
export function archiveFormatsOfFamily(
  family: SourceFamily,
  formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS,
): ArchiveFormatDefinition[] {
  return formats.filter((format) => format.family === family);
}

/**
 * Every name pattern the formats ask the probe to look for, once each.
 */
export function archiveProbeNames(formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS): readonly string[] {
  return [...new Set(formats.flatMap((format) => [...(format.probeNames ?? []), ...(format.signatureNames ?? [])]))];
}

/**
 * Every signature name pattern the formats have, once each: the names the
 * probe looks for before any other.
 */
export function archiveSignatureNames(formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS): readonly string[] {
  return [...new Set(formats.flatMap((format) => format.signatureNames ?? []))];
}

/**
 * Whether a name matches one of a format's `probeNames`: `*` stands for any
 * run of characters (none included), `?` for any one, and case does not
 * matter. A name with folders in it also matches by its last part.
 */
export function archiveProbeNameMatches(name: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const full = name.toLowerCase();
  const slash = full.lastIndexOf('/');
  const last = slash >= 0 ? full.slice(slash + 1) : full;
  return patterns.some((pattern) => {
    const wanted = pattern.toLowerCase();
    return wildcardMatches(wanted, last) || (last !== full && wildcardMatches(wanted, full));
  });
}

function wildcardMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const wanted = pattern[p];
    if (wanted === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (wanted === '?' || wanted === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** The source families archive imports store, one store set per family. */
/** The corpus id of one tier store of one family's archives. */
export function archiveCorpusId(trustDomain: SourceTrustDomain, family: SourceFamily): string {
  return `${trustDomain}.archive.${family}`;
}

/** Whether a corpus id is an imported archive's, of any family: the prefix `archiveCorpusId` writes. */
export function isArchiveCorpusId(corpusId: string, trustDomain: string): boolean {
  return corpusId.startsWith(`${trustDomain}.archive.`);
}

export function archiveImportFamilies(formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS): SourceFamily[] {
  return [...new Set(formats.map((format) => format.family))];
}

/**
 * What the person is told when a folder or a zip had more to look through
 * than the probe may read, in either way: a read on past a file's first bytes
 * ran out of its allowance (some parts are very large), or there were more
 * files than the first look takes in (their first bytes were not read, or
 * they were not opened). A file or member left unchecked could be a second
 * export that would be dropped without a word, so a pick whose look ran out
 * of allowance is never imported, and one that found nothing says so.
 */
export const ARCHIVE_LOOK_INCOMPLETE_ADVICE = 'Olympus could not look through everything you chose to see which parts are exports, because there is a lot of it or some parts are very large. Choose just the export file, or a folder or zip that holds only the export.';

/**
 * How many files of a pick the look named but did not reach, and the record
 * counts (`files_not_looked_at`): files a format asked for by name past the
 * room for them, and members of a zip it asked for that were not read. A
 * format that tells its export from the first bytes alone is covered too, by
 * `othersNotLookedAt`, which only a refusal mentions.
 */
export function archiveFilesNotLookedAt(probe: ArchiveProbe): number {
  return (probe.notLookedAt ?? 0)
    + [probe.chosen, ...probe.children].reduce((sum, entry) => sum + (entry.membersNotLookedAt ?? 0), 0);
}

/**
 * Which format a probe is. No match says so and lists what is supported; two
 * matches are returned as such for the person to choose, never guessed.
 *
 * The first bytes decide when they can, and a file (or a zip's member) they
 * settle is never read further (the slower look reads on through a file, and
 * a long export would pay for it every time). Every other file or member of
 * the pick gets that look, so a second export whose first bytes do not say
 * what it is cannot hide beside one that does: both are found, and the
 * formats' own rules for two exports apply as they do when both are told by
 * their first bytes. A pick whose look ran out of allowance before it reached
 * every file or member is refused, never imported with one left out.
 */
export function detectArchiveFormat(
  probe: ArchiveProbe,
  formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS,
): ArchiveDetection {
  const onHeads = matchesOf(probeWithoutFurtherReads(probe), formats);
  const settled = new Set(onHeads.flatMap((match) => match.files));
  const matches = matchesOf(probeReadingPastHeadsExcept(probe, settled, formats), formats);
  const ranOut = probe.readsRanOut?.() === true;
  if (matches.length === 1 && !ranOut) return { kind: 'match', format: matches[0]!.format, files: matches[0]!.files };
  if (matches.length > 1) return { kind: 'ambiguous', formats: matches.map((match) => match.format.id) };
  const supported = formats.map((format) => format.label);
  // Nothing was taken: whatever the look did not reach, of any format, may be the export. One sentence says so, once.
  const incomplete = ranOut || archiveFilesNotLookedAt(probe) + (probe.othersNotLookedAt ?? 0) > 0;
  const advice = [unsupportedAdvice(probe, formats), incomplete ? ARCHIVE_LOOK_INCOMPLETE_ADVICE : undefined]
    .filter((said): said is string => said !== undefined)
    .join(' ');
  return advice ? { kind: 'none', supported, advice } : { kind: 'none', supported };
}

function matchesOf(
  probe: ArchiveProbe,
  formats: readonly ArchiveFormatDefinition[],
): Array<{ format: ArchiveFormatDefinition; files: readonly string[] }> {
  const matches: Array<{ format: ArchiveFormatDefinition; files: readonly string[] }> = [];
  for (const format of formats) {
    let files: readonly string[] | undefined;
    try {
      files = format.detect(probe);
    } catch {
      files = undefined;
    }
    if (files && files.length > 0) matches.push({ format, files });
  }
  return matches;
}

/** An entry as the probe first saw it: its names and first bytes, with no way to read on. */
function entryWithoutFurtherReads(entry: ArchiveProbeEntry): ArchiveProbeEntry {
  const { firstRecordKeys: _keys, listIsEmpty: _empty, members, ...rest } = entry;
  return { ...rest, ...(members ? { members: members.map(entryWithoutFurtherReads) } : {}) };
}

function probeWithoutFurtherReads(probe: ArchiveProbe): ArchiveProbe {
  return { chosen: entryWithoutFurtherReads(probe.chosen), children: probe.children.map(entryWithoutFurtherReads) };
}

/**
 * The probe with the way on past the first bytes kept only for what the first
 * bytes did not settle: an entry not in `settled` (by its `relPath`), and a
 * zip's member that no format takes for its own file on its first bytes (a
 * zip settled as a whole still has members to look through).
 */
function probeReadingPastHeadsExcept(
  probe: ArchiveProbe,
  settled: ReadonlySet<string>,
  formats: readonly ArchiveFormatDefinition[],
): ArchiveProbe {
  const keep = (entry: ArchiveProbeEntry): ArchiveProbeEntry => {
    const members = entry.members?.map((member) => (toldOnItsFirstBytes(member, formats) ? entryWithoutFurtherReads(member) : member));
    if (!settled.has(entry.relPath)) return members ? { ...entry, members } : entry;
    const { firstRecordKeys: _keys, listIsEmpty: _empty, members: _members, ...rest } = entry;
    return { ...rest, ...(members ? { members } : {}) };
  };
  return { ...probe, chosen: keep(probe.chosen), children: probe.children.map(keep) };
}

/** Whether some format takes this member for its own file on its first bytes alone. */
function toldOnItsFirstBytes(member: ArchiveProbeEntry, formats: readonly ArchiveFormatDefinition[]): boolean {
  if (member.kind !== 'file') return false;
  const alone: ArchiveProbeEntry = { ...entryWithoutFurtherReads(member), relPath: '' };
  return matchesOf({ chosen: alone, children: [] }, formats).length > 0;
}

function unsupportedAdvice(probe: ArchiveProbe, formats: readonly ArchiveFormatDefinition[]): string | undefined {
  for (const format of formats) {
    for (const variant of format.unsupportedVariants ?? []) {
      try {
        if (variant.matches(probe)) return variant.advice;
      } catch {
        // A variant that cannot tell is no advice.
      }
    }
  }
  return undefined;
}

// --- Connector factories ------------------------------------------------------

/** One file an archive import reads, relative to the archive's approved root. */
export interface ArchiveFileEntry {
  relPath: string;
  version: ScopeFileVersion;
  /**
   * A zip: how many members it held when the import was approved, and the
   * digest of its member table. A reader checks it before it reads a member.
   */
  members?: { count: number; sha256: string };
}

/**
 * Something the connector met that is not an item: a gap (a message too large
 * to read, one that would not parse, text whose character set nothing here
 * decodes, attachments named but not read) or a deliberate skip. `position`
 * orders findings through the archive, so a finding seen again after a resume
 * is counted once.
 */
export interface ArchiveImportFinding {
  kind: string;
  class: 'gap' | 'skipped';
  fileIndex: number;
  offset: number;
  count?: number;
  // A finding that tallies several occurrences of one kind in one file (a page's worth of notices, say) tells the
  // offset of each, `offset` being the first and `count` how many. The store counts only the occurrences past
  // what it counted before, so a replay whose pages are cut differently counts each once. Without it, all
  // `count` occurrences are taken to be at `offset`.
  at?: readonly number[];
}

/**
 * Finding kinds every format can use, whatever it imports. A format's own
 * kinds (mail's, say) live with its connector; these are the ones the spine
 * and the shared readers know, each with a sentence in the dashboard's words.
 */
export const ARCHIVE_COMMON_FINDINGS = {
  /** Pictures, audio, video or other files named in the archive that were not read. */
  mediaNotImported: 'media_not_imported',
  /** Old records only: an item used to be cut at a length. Nothing reports it now; an item is kept whole. */
  itemTruncated: 'item_truncated',
  // What the import took as given because the archive does not say, one kind for each thing taken, so the dashboard
  // says exactly what: no kind stands for "something was assumed".
  /** Times in the archive carry no time zone: they were read in this computer's zone. */
  timeZoneAssumed: 'time_zone_assumed',
  /** Dates in a file do not say which part is the day (they read the same either way): they were read day first. */
  dateOrderAssumed: 'date_order_assumed',
  /** A line shaped like the start of a new item was taken as one, though it may belong to the item above it. */
  itemStartAssumed: 'item_start_assumed',
  /** A zip too large to check its members against each other: they were taken not to share bytes. */
  zipOverlapUnchecked: 'zip_overlap_unchecked',
  /**
   * The fallback for an archive recorded before the specific kinds above: a record keeps what it was written
   * with, so the dashboard still reads it. Nothing reports this kind now.
   */
  assumption: 'assumption',
  /** A whole part of the archive the import does not read. */
  sectionNotImported: 'section_not_imported',
  /** A file inside the archive whose bytes did not check out, so what was read of it may be wrong. */
  fileDamaged: 'file_damaged',
  /** Skipped: items the listing produced that the archive's stores already held from an earlier file, so they were imported once. */
  itemRepeated: 'item_repeated',
  /** Skipped: files in a chosen folder or zip the first look did not reach, so any export among them was not imported. */
  filesNotLookedAt: 'files_not_looked_at',
  /** Skipped: files in a chosen folder that look like exports but were not taken, because their names do not say so. */
  filesUnconfirmed: 'files_unconfirmed',
} as const;

/**
 * What binding a media file can answer. A media file beside a chat export is
 * bound only under a chosen FOLDER: choosing a single file approves that file,
 * never the folder it sits in (docs/design/child-items.md, "Manifest").
 */
export type ArchiveMediaBindResult =
  | { ok: true; bindingId: string; sizeBytes: number }
  | { ok: false; reason: 'chosen_file' | 'missing' | 'not_regular' | 'unreadable' };

/**
 * A connector's way to media files the import's manifest does not hold (the
 * files a folder-chosen chat export refers to). The import records each one
 * it binds in an append-only table before the listing goes on, so the
 * child's locator can name the binding and a later read finds the same file
 * at the same version or settles as gone.
 */
export interface ArchiveMediaAccess {
  /**
   * Binds the file at `relPath` (relative to the chosen folder) and returns
   * the binding the child's locator names. Written durably before this
   * returns, so before the child row and the checkpoint that follow it.
   * Binding the same path again returns the same binding, never a new
   * version of it.
   */
  bind(relPath: string): ArchiveMediaBindResult;
  /**
   * Opens a bound file for bounded range reads, descriptor-relative, at the
   * version the binding recorded. A replaced, changed or missing file throws
   * a `ScopeSafeError` (`changed`, `not_found`); the caller closes the reader
   * and calls `assertCurrent()` after reading what it needs.
   */
  open(bindingId: string): ScopeFileReader;
  /**
   * The bytes of a bound file, up to `maxBytes` (a larger file throws
   * `too_large`; 64 MiB when no limit is named), checked to still be the
   * bound version after they were read. A file that can be larger is read in
   * ranges through `open`.
   */
  read(bindingId: string, options?: { maxBytes?: number }): Uint8Array;
}

export interface ArchiveConnectorInput {
  archiveId: string;
  connectorId: string;
  accountScope: string;
  format: ArchiveFormatDefinition;
  root: ScopeRoot;
  files: readonly ArchiveFileEntry[];
  /** Binds a resume point to exactly these files at exactly these versions. */
  manifestSha256: string;
  report(finding: ArchiveImportFinding): void;
  /** Read before each item: false stops the listing (the archive is being removed). */
  shouldContinue(): boolean;
  /**
   * Where the next page starts (a file of `files` and a byte offset in it),
   * told before each page goes out. Progress only: the resume point is the
   * page's cursor, never this.
   */
  reportPosition?(position: { fileIndex: number; offset: number }): void;
  /**
   * Where each item of the page about to go out is in the archive, in the
   * order of the page's items and in the coordinates findings use (`fileIndex`
   * and `offset`, strictly increasing over the archive's items). Told just
   * before the page goes out. With it the import counts the items the stores
   * already hold from another file once each, by position, however the same
   * items are cut into pages when a listing is replayed after a restart. A
   * connector that does not tell has such items counted by whole pages.
   */
  reportItemPositions?(positions: ReadonlyArray<{ fileIndex: number; offset: number }>): void;
  /** Bytes read per listing before it pauses with a resume point. */
  maxBytesPerListing?: number;
  pageSize?: number;
  /**
   * The means to bind and read media files under the chosen folder. Absent
   * where the archive keeps no binding table (a connector then lists media
   * it cannot read as left out).
   */
  media?: ArchiveMediaAccess;
}

export type ArchiveConnectorFactory = (input: ArchiveConnectorInput) => SourceConnector;

/**
 * Thrown by a connector when a file of the archive is not the version the
 * import started with, is gone, or the resume point does not belong to it.
 * The import stops and says so instead of reading different bytes.
 */
export class ArchiveImportStoppedError extends Error {
  readonly code: 'file_changed' | 'file_missing' | 'file_unreadable' | 'resume_point_invalid';
  readonly relPath: string | undefined;
  constructor(code: ArchiveImportStoppedError['code'], message: string, relPath?: string) {
    super(message);
    this.name = 'ArchiveImportStoppedError';
    this.code = code;
    this.relPath = relPath;
  }
}

const CONNECTOR_FACTORIES = new Map<string, ArchiveConnectorFactory>();

export function registerArchiveFormatConnector(formatId: string, factory: ArchiveConnectorFactory): void {
  if (!getArchiveFormat(formatId)) throw new Error(`No archive format ${formatId} is registered.`);
  CONNECTOR_FACTORIES.set(formatId, factory);
}

export function archiveFormatConnector(formatId: string): ArchiveConnectorFactory | undefined {
  return CONNECTOR_FACTORIES.get(formatId);
}
