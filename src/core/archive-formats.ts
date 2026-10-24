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
import type { ScopeFileVersion, ScopeRoot } from './scope-safe-fs.ts';
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

export const ARCHIVE_FORMATS: readonly ArchiveFormatDefinition[] = Object.freeze([MBOX_ARCHIVE_FORMAT, WHATSAPP_ARCHIVE_FORMAT, TELEGRAM_JSON_ARCHIVE_FORMAT]);

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
 * Which format a probe is. No match says so and lists what is supported; two
 * matches are returned as such for the person to choose, never guessed.
 */
export function detectArchiveFormat(
  probe: ArchiveProbe,
  formats: readonly ArchiveFormatDefinition[] = ARCHIVE_FORMATS,
): ArchiveDetection {
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
  if (matches.length === 1) return { kind: 'match', format: matches[0]!.format, files: matches[0]!.files };
  if (matches.length === 0) {
    const supported = formats.map((format) => format.label);
    const advice = unsupportedAdvice(probe, formats);
    return advice ? { kind: 'none', supported, advice } : { kind: 'none', supported };
  }
  return { kind: 'ambiguous', formats: matches.map((match) => match.format.id) };
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
}

/**
 * Finding kinds every format can use, whatever it imports. A format's own
 * kinds (mail's, say) live with its connector; these are the ones the spine
 * and the shared readers know, each with a sentence in the dashboard's words.
 */
export const ARCHIVE_COMMON_FINDINGS = {
  /** Pictures, audio, video or other files named in the archive that were not read. */
  mediaNotImported: 'media_not_imported',
  /** An item longer than the import keeps: the start of it is kept. */
  itemTruncated: 'item_truncated',
  /** Something the import had to take as given because the archive does not say. */
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
