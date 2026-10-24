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
import { isWhatsAppChatMemberName, looksLikeWhatsAppChat } from './whatsapp-export-grammar.ts';

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
}

export interface ArchiveProbe {
  chosen: ArchiveProbeEntry;
  /**
   * For a chosen folder, the entries directly inside it: the first
   * ARCHIVE_PROBE_MAX_CHILDREN, then up to ARCHIVE_PROBE_MAX_NAMED more whose
   * names a format asks for (`probeNames`).
   */
  children: readonly ArchiveProbeEntry[];
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
   * The files to read, relative to the chosen path and in reading order, when
   * the probe is this format; undefined when it is not.
   */
  detect(probe: ArchiveProbe): readonly string[] | undefined;
}

export type ArchiveDetection =
  | { kind: 'match'; format: ArchiveFormatDefinition; files: readonly string[] }
  | { kind: 'none'; supported: readonly string[] }
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

/**
 * A WhatsApp chat export: the text file of "Export Chat" (`_chat.txt` from an
 * iPhone, `WhatsApp Chat with <name>.txt` from an Android phone, or any .txt
 * that starts with a message line), or the zip WhatsApp shares, which holds
 * that text file and the chat's media. A chosen folder imports every export in
 * it. One format covers all of these, so a folder that mixes text files and zips
 * is not ambiguous.
 */
export const WHATSAPP_ARCHIVE_FORMAT: ArchiveFormatDefinition = Object.freeze({
  id: 'whatsapp_chat',
  label: 'WhatsApp chat export',
  family: 'chat',
  provider: 'whatsapp_export',
  chooseHint: 'a WhatsApp chat export (the .zip or the text file from Export Chat, or a folder of them)',
  citationLabel: 'WhatsApp',
  probeNames: Object.freeze(['_chat.txt', '*whatsapp*.txt', '*whatsapp*.zip']),
  detect(probe: ArchiveProbe): readonly string[] | undefined {
    const isChat = (entry: ArchiveProbeEntry): boolean => {
      if (entry.kind !== 'file') return false;
      if (entry.members) {
        return entry.members.some((member) =>
          member.kind === 'file' && isWhatsAppChatMemberName(member.relPath) && looksLikeWhatsAppChat(member.head));
      }
      return entry.name.toLowerCase().endsWith('.txt') && looksLikeWhatsAppChat(entry.head);
    };
    if (probe.chosen.kind === 'file') return isChat(probe.chosen) ? [''] : undefined;
    const found = probe.children.filter(isChat).map((entry) => entry.relPath).sort();
    return found.length > 0 ? found : undefined;
  },
});

export const ARCHIVE_FORMATS: readonly ArchiveFormatDefinition[] = Object.freeze([MBOX_ARCHIVE_FORMAT, WHATSAPP_ARCHIVE_FORMAT]);

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
  return [...new Set(formats.flatMap((format) => format.probeNames ?? []))];
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
  if (matches.length === 0) return { kind: 'none', supported: formats.map((format) => format.label) };
  return { kind: 'ambiguous', formats: matches.map((match) => match.format.id) };
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
