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

/** One file or folder the probe looked at. */
export interface ArchiveProbeEntry {
  /** Relative to the chosen path; '' is the chosen path itself. */
  relPath: string;
  name: string;
  kind: 'file' | 'directory';
  /** The first ARCHIVE_PROBE_HEAD_BYTES bytes of a file (fewer when it is shorter). */
  head?: Uint8Array;
}

export interface ArchiveProbe {
  chosen: ArchiveProbeEntry;
  /** For a chosen folder, the entries directly inside it (at most ARCHIVE_PROBE_MAX_CHILDREN). */
  children: readonly ArchiveProbeEntry[];
}

export interface ArchiveFormatDefinition {
  id: string;
  label: string;
  family: SourceFamily;
  /** The provider name every item of this format carries. */
  provider: string;
  /** How an answer's citation names this format's items ("Imported mail"); absent: the family's word. */
  citationLabel?: string;
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
  citationLabel: 'Imported mail',
  detect(probe: ArchiveProbe): readonly string[] | undefined {
    if (probe.chosen.kind === 'file') return startsWithFromLine(probe.chosen.head) ? [''] : undefined;
    if (!probe.chosen.name.toLowerCase().endsWith('.mbox')) return undefined;
    const inner = probe.children.find((entry) =>
      entry.kind === 'file' && entry.name === 'mbox' && startsWithFromLine(entry.head));
    return inner ? [inner.relPath] : undefined;
  },
});

export const ARCHIVE_FORMATS: readonly ArchiveFormatDefinition[] = Object.freeze([MBOX_ARCHIVE_FORMAT]);

export function getArchiveFormat(formatId: string): ArchiveFormatDefinition | undefined {
  return ARCHIVE_FORMATS.find((format) => format.id === formatId);
}

/** The format whose items carry this provider name, if any. */
export function archiveFormatForProvider(provider: string): ArchiveFormatDefinition | undefined {
  return ARCHIVE_FORMATS.find((format) => format.provider === provider);
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

export function archiveImportFamilies(): SourceFamily[] {
  return [...new Set(ARCHIVE_FORMATS.map((format) => format.family))];
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
