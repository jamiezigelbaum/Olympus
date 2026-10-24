/**
 * The reading half of a notes archive connector, shared by every notes
 * format: it walks an archive's files (a JSON file, a zip holding JSON files,
 * or a zip of Markdown files), hands each record to the format's parser, and
 * pages the notes out with a resume point that survives a restart. A format
 * supplies only its `NoteSource`: where its notes are and how one record
 * becomes a `NoteOutcome` (`notes/note.ts`).
 *
 * - Reading: through the shared readers only (`json-stream.ts`, `zip-reader.ts`)
 *   over the scope-safe range reader. A JSON record is read whole up to
 *   NOTE_MAX_RECORD_BYTES; a bigger one is reported (`note_too_large`) with its
 *   place and passed over. A Markdown member is streamed, the first 4 MB of it
 *   kept. Nothing reads a whole file or a whole member.
 * - Findings: an empty note is skipped, a record that is no note, a record
 *   too big and a note (or part of one) of a kind Olympus has no rule for are
 *   gaps, a zip member whose checksum or size is wrong, or a JSON file cut
 *   short, is `file_damaged` (what was read before it stays), a JSON document
 *   without the list the format keeps its notes in, or a zip member that is
 *   not this format's, is `section_not_imported`, and a zip's other files are
 *   counted as not imported. Each finding is at the place of its note, so a
 *   page read again after a restart counts nothing twice.
 * - Bounds: the listing's byte budget is held while reading, at every record
 *   (and every Markdown member), not after a whole file; the first record of a
 *   listing is always read, so every listing makes progress. Whether the import
 *   is still wanted is asked before each record and again with each chunk read,
 *   so a single huge record or member does not outlast its cancellation.
 * - Resume point: `<prefix><manifest>:<file>:<member>:<offset>:<crc>:<json>`,
 *   the next note to read: a zip member (or -1), the byte offset after the
 *   last note read in it, the CRC-32 of the member before that offset, and the
 *   JSON stream's own resume point. A deflated member's inflater is parked in
 *   the continuation cache at the same time, so the next page does not inflate
 *   the member again. Any other manifest, or a point that is not in the
 *   archive, stops the import.
 * - Changes: each page goes out only while its file is still the version
 *   opened, under the descriptor and at its name.
 */
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../../core/contracts.ts';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_PROBE_HEAD_BYTES,
  ArchiveImportStoppedError,
  isJunkArchiveMember,
  type ArchiveConnectorInput,
  type ArchiveFileEntry,
} from '../../../core/archive-formats.ts';
import type { ScopeFileReader } from '../../../core/scope-safe-fs.ts';
import { fileByteSource, type ArchiveByteSource } from '../byte-source.ts';
import { archiveContinuations, type ContinuationKey } from '../continuation-cache.ts';
import {
  JSON_STREAM_ANY,
  JsonStreamError,
  JsonStreamReader,
  archiveStopFromReaderError,
  parseJsonResume,
  serializeJsonResume,
  type JsonPathSegment,
  type JsonResumePoint,
  type JsonStreamEvent,
} from '../json-stream.ts';
import {
  ZipArchive,
  ZipFormatError,
  ZipMemberError,
  ZipMemberReader,
  readZipMemberHead,
  stoppableZipSource,
  zipFindingOffset,
  type ZipEntry,
  type ZipMemberEnd,
} from '../zip-reader.ts';
import {
  NOTE_FINDINGS,
  NOTE_MAX_RECORD_BYTES,
  NOTE_MAX_TEXT_CHARS,
  buildNoteItem,
  noteClassificationSignals,
  type NoteOutcome,
  type NotePlace,
} from './note.ts';

export const NOTES_DEFAULT_PAGE_SIZE = 100;
export const NOTES_DEFAULT_MAX_BYTES_PER_LISTING = 256 * 1024 * 1024;
/** Records and findings read before a page goes out even when it holds few items, so findings never pile up unbounded. */
export const NOTES_MAX_UNITS_PER_PAGE = 5_000;
/** Bytes of a Markdown member kept: enough for NOTE_MAX_TEXT_CHARS characters of any text. */
const MARKDOWN_MAX_BYTES = NOTE_MAX_TEXT_CHARS * 4;
const ROOT_PEEK_BYTES = 1024;
/** The biggest value looked at when asking whether a document's list of notes is there; an empty list is far smaller. */
const LIST_PEEK_BYTES = 64 * 1024;

/** Where a format's notes are, and how one becomes a `NoteOutcome`. */
export type NoteSource =
  | {
    kind: 'json';
    /**
     * The item paths of a JSON document whose root is an array or an object;
     * undefined when this format reads no such document. Each path names a
     * list: a document whose path is missing or holds anything but a list is
     * not read (`section_not_imported`), never taken for one with no notes.
     */
    itemPaths(root: 'array' | 'object'): readonly (readonly JsonPathSegment[])[] | undefined;
    /**
     * Whether a JSON document, from its first ARCHIVE_PROBE_HEAD_BYTES bytes,
     * is this format's. Asked of each JSON member of a zip, so a member that is
     * some other file is left alone and reported, not read as this format.
     */
    accepts(head: Uint8Array | undefined): boolean;
    parse(record: unknown): NoteOutcome;
  }
  | {
    kind: 'markdown';
    /** Whether a zip member (never a folder or a hidden file) is a note. */
    isNote(name: string): boolean;
    parse(text: string, fileName: string): NoteOutcome;
  };

export interface NoteArchiveSpec {
  /** The start of this format's resume points, "reflect1:". */
  cursorPrefix: string;
  source: NoteSource;
}

interface Cursor {
  file: number;
  /** The zip member the next note is in (or the next member to look at); -1 at the start of a file. */
  member: number;
  /** The byte offset in that member (or the plain file) after the last note read. */
  offset: number;
  /** The CRC-32 of the member's bytes before `offset`, when known. */
  crc?: number;
  resume?: JsonResumePoint;
  done: boolean;
}

interface Segment {
  items: RawItem[];
  next: Cursor;
  /** Records and findings read, to bound a page. */
  consumed: number;
  bytes: number;
  stopped: boolean;
  /** The listing's byte budget ran out here: `next` is the record or member not yet read, and the listing ends after this page. */
  budgetHit: boolean;
  /** Where the next page starts, for progress. */
  position?: { fileIndex: number; offset: number };
}

interface Limits {
  items: number;
  units: number;
  /** Bytes this listing may still read. */
  bytes: number;
  /** The listing has already read something, so a segment may stop at once when the budget is spent; else it reads one record first. */
  started: boolean;
}

/** The import was told to stop while a record or member was being read: what was whole before it stays, this one is read again. */
class ReadInterrupted extends Error {}

/** One JSON document: a plain file, or a member of a zip. */
interface JsonUnit {
  member: number;
  /** A finding's position for an offset in the document. */
  posOf(offset: number): number;
  /** Progress, in the file's own bytes, for an offset in the document. */
  progressOf(offset: number): number;
  head(): Uint8Array | undefined;
  open(offset: number, crc: number | undefined): ArchiveByteSource;
  /** After the last note read: give back what was read past it; the member's CRC there. */
  checkpoint(endOffset: number): { crc?: number };
  end(): ZipMemberEnd | undefined;
  close(): void;
}

function rootKindOf(head: Uint8Array | undefined): 'array' | 'object' | undefined {
  if (!head) return undefined;
  let at = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (at < head.length && (head[at] === 0x20 || head[at] === 0x09 || head[at] === 0x0a || head[at] === 0x0d)) at += 1;
  if (head[at] === 0x5b) return 'array';
  if (head[at] === 0x7b) return 'object';
  return undefined;
}

export function createNoteArchiveConnector(input: ArchiveConnectorInput, spec: NoteArchiveSpec): SourceConnector {
  const pageSizeDefault = Math.max(1, input.pageSize ?? NOTES_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, input.maxBytesPerListing ?? NOTES_DEFAULT_MAX_BYTES_PER_LISTING);
  const tag = input.manifestSha256.slice(0, 16);
  const prefix = `${spec.cursorPrefix}${tag}:`;
  const source = spec.source;

  const DONE: Cursor = { file: input.files.length, member: -1, offset: 0, done: true };
  const startOfFile = (file: number): Cursor => (file >= input.files.length ? DONE : { file, member: -1, offset: 0, done: false });

  // --- Resume points ----------------------------------------------------------

  const invalid = (message: string): ArchiveImportStoppedError => new ArchiveImportStoppedError('resume_point_invalid', message);

  const encode = (cursor: Cursor): string => {
    if (cursor.done) return `${prefix}done`;
    const resume = cursor.resume ? Buffer.from(serializeJsonResume(cursor.resume)).toString('base64url') : '';
    return `${prefix}${cursor.file}:${cursor.member}:${cursor.offset}:${cursor.crc ?? ''}:${resume}`;
  };

  const decode = (text: string | undefined): Cursor => {
    if (!text) return startOfFile(0);
    if (!text.startsWith(prefix)) throw invalid('The resume point belongs to other files than this archive\'s.');
    const rest = text.slice(prefix.length);
    if (rest === 'done') return DONE;
    const parts = rest.split(':');
    if (parts.length !== 5) throw invalid('The resume point is not a position in this archive.');
    const [fileText, memberText, offsetText, crcText, resumeText] = parts as [string, string, string, string, string];
    const file = Number(fileText);
    const member = Number(memberText);
    const offset = Number(offsetText);
    const crc = crcText === '' ? undefined : Number(crcText);
    if (!Number.isSafeInteger(file) || file < 0 || file >= input.files.length
      || !Number.isSafeInteger(member) || member < -1
      || !Number.isSafeInteger(offset) || offset < 0
      || (crc !== undefined && (!Number.isSafeInteger(crc) || crc < 0 || crc > 0xffffffff))) {
      throw invalid('The resume point is not a position in this archive.');
    }
    let resume: JsonResumePoint | undefined;
    if (resumeText !== '') {
      resume = parseJsonResume(Buffer.from(resumeText, 'base64url').toString('utf8'));
      if (!resume || resume.offset !== offset) throw invalid('The resume point is not a position in this archive.');
    }
    // A position past the start of a document names the JSON stream's own point; markdown members are entered at their start.
    if ((offset > 0) !== (resume !== undefined)) throw invalid('The resume point is not a position in this archive.');
    return { file, member, offset, ...(crc !== undefined ? { crc } : {}), ...(resume ? { resume } : {}), done: false };
  };

  const stoppedFrom = (error: unknown, relPath: string): unknown => archiveStopFromReaderError(error, relPath);

  // --- Reading one file -------------------------------------------------------

  const report = (kind: string, findingClass: 'gap' | 'skipped', fileIndex: number, offset: number, count?: number): void => {
    input.report({ kind, class: findingClass, fileIndex, offset, ...(count !== undefined ? { count } : {}) });
  };

  const takeNote = (segment: Segment, outcome: NoteOutcome, place: NotePlace, offset: number, savedAt: string, cut = false): void => {
    segment.consumed += 1;
    if (outcome.kind === 'empty') {
      report(NOTE_FINDINGS.empty, 'skipped', place.fileIndex, offset);
      return;
    }
    if (outcome.kind === 'unreadable') {
      report(NOTE_FINDINGS.unreadable, 'gap', place.fileIndex, offset);
      return;
    }
    if (outcome.kind === 'unsupported') {
      report(NOTE_FINDINGS.unsupported, 'gap', place.fileIndex, offset);
      return;
    }
    const built = buildNoteItem(input, outcome.note, place, savedAt);
    segment.items.push(built.item);
    if (outcome.note.unsupported) report(NOTE_FINDINGS.unsupported, 'gap', place.fileIndex, offset);
    if (built.truncated || cut) report(ARCHIVE_COMMON_FINDINGS.itemTruncated, 'gap', place.fileIndex, offset);
    if (built.dateAssumed) report(NOTE_FINDINGS.dateAssumed, 'gap', place.fileIndex, offset);
  };

  const plainUnit = (reader: ScopeFileReader): JsonUnit => ({
    member: -1,
    posOf: (offset) => offset,
    progressOf: (offset) => offset,
    head: () => reader.readAt(0, ROOT_PEEK_BYTES),
    open: (offset) => fileByteSource(reader, { start: offset }),
    checkpoint: () => ({}),
    end: () => undefined,
    close: () => undefined,
  });

  const zipUnit = (archive: ZipArchive, entry: ZipEntry, fileIndex: number): JsonUnit => {
    let reader: ZipMemberReader | undefined;
    const key: ContinuationKey = { archiveId: input.archiveId, manifestTag: tag, fileIndex, memberIndex: entry.index };
    return {
      member: entry.index,
      posOf: (offset) => zipFindingOffset(entry.index, offset),
      progressOf: (offset) => entry.localHeaderOffset + Math.floor(entry.compressedSize * Math.min(1, offset / Math.max(1, entry.uncompressedSize))),
      head: () => readZipMemberHead(archive, entry, ROOT_PEEK_BYTES),
      open(offset, crc) {
        const continuation = offset > 0 ? archiveContinuations.take(key, offset) : undefined;
        reader = ZipMemberReader.open(archive, entry, {
          start: offset,
          ...(crc !== undefined ? { startCrc: crc } : {}),
          ...(continuation ? { continuation } : {}),
        });
        return reader;
      },
      checkpoint(endOffset) {
        const member = reader;
        if (!member) return {};
        try {
          const back = member.position - endOffset;
          if (back > 0) member.unread(back);
        } catch {
          // Cannot give the bytes back: the next page enters here without a checksum, or inflates again.
          member.close();
          return {};
        }
        const crc = member.crc32;
        const continuation = member.suspend();
        if (continuation) archiveContinuations.put(key, continuation);
        return crc !== undefined ? { crc } : {};
      },
      end: () => reader?.end,
      close: () => reader?.close(),
    };
  };

  /** The bytes of a document, asking at each chunk whether the import is still wanted. */
  const watched = (inner: ArchiveByteSource): ArchiveByteSource => ({
    get position() { return inner.position; },
    get crc32() { return inner.crc32; },
    next() {
      if (!input.shouldContinue()) throw new ReadInterrupted();
      return inner.next();
    },
    unread: (count) => inner.unread(count),
  });

  /**
   * A document that held no notes: whether the list they would have been in
   * is there, empty (a recognised export with nothing in it), or not (some
   * other document, or the list is a different kind of value).
   */
  const listIsThere = (
    unit: JsonUnit,
    paths: readonly (readonly JsonPathSegment[])[],
    relPath: string,
  ): boolean | 'interrupted' => {
    for (const path of paths) {
      // The root itself is the list (its kind was checked), or the path is not a name to look for.
      if (path.length === 0 || path.some((part) => typeof part !== 'string' || part === JSON_STREAM_ANY)) return true;
      let bytes: ArchiveByteSource;
      try {
        bytes = watched(unit.open(0, undefined));
      } catch (error) {
        if (error instanceof ZipMemberError) return true;
        throw stoppedFrom(error, relPath);
      }
      let found = false;
      try {
        const scan = new JsonStreamReader(bytes, { itemPaths: [path.slice(0, -1)], maxItemBytes: LIST_PEEK_BYTES });
        for (;;) {
          const event = scan.next();
          if (!event) break;
          if (event.path.length === path.length && event.path.every((part, at) => part === path[at])) {
            // A list that held a note would have been read as one: here it is empty, or it is no list.
            found = event.kind === 'item' && Array.isArray(event.value);
            break;
          }
        }
      } catch (error) {
        unit.close();
        if (error instanceof ReadInterrupted) return 'interrupted';
        if (error instanceof ArchiveImportStoppedError) throw error;
        // Cut short or damaged: the pass that read it first has said so.
        if (error instanceof ZipMemberError || error instanceof JsonStreamError) return true;
        throw stoppedFrom(error, relPath);
      }
      unit.close();
      if (found) return true;
    }
    return false;
  };

  /**
   * One JSON document, from `cursor` until the page is full, the document
   * ends or the import is told to stop. 'ended': the whole document was read
   * (or could not be); 'paused': `segment.next` is where to go on.
   */
  const readJsonUnit = (
    unit: JsonUnit,
    unitCursor: Cursor,
    fileIndex: number,
    relPath: string,
    limits: Limits,
    segment: Segment,
    savedAt: string,
  ): 'ended' | 'paused' => {
    if (source.kind !== 'json') return 'ended';
    const damaged = (offset: number): void => report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', fileIndex, unit.posOf(offset));
    const notRead = (): void => report(ARCHIVE_COMMON_FINDINGS.sectionNotImported, 'gap', fileIndex, unit.posOf(0));
    let root: 'array' | 'object' | undefined;
    if (unitCursor.resume) {
      root = unitCursor.resume.levels[0]?.kind;
    } else {
      try {
        root = rootKindOf(unit.head());
      } catch (error) {
        throw stoppedFrom(error, relPath);
      }
      if (!root) {
        damaged(0);
        return 'ended';
      }
    }
    const itemPaths = root ? source.itemPaths(root) : undefined;
    if (!itemPaths) {
      // A JSON document of a shape this format does not read.
      notRead();
      return 'ended';
    }
    let bytes: ArchiveByteSource;
    try {
      bytes = watched(unit.open(unitCursor.offset, unitCursor.crc));
    } catch (error) {
      if (error instanceof ZipMemberError) {
        if (unitCursor.offset > 0) throw invalid('Nothing starts where this import was to resume.');
        damaged(0);
        return 'ended';
      }
      throw stoppedFrom(error, relPath);
    }
    let reader: JsonStreamReader;
    try {
      reader = new JsonStreamReader(bytes, {
        itemPaths,
        maxItemBytes: NOTE_MAX_RECORD_BYTES,
        ...(unitCursor.resume ? { resume: unitCursor.resume } : {}),
      });
    } catch (error) {
      unit.close();
      throw stoppedFrom(error, relPath);
    }
    let last: JsonStreamEvent | undefined;
    const pause = (): 'paused' => {
      if (!last) {
        unit.close();
        segment.next = unitCursor;
        segment.position = { fileIndex, offset: unit.progressOf(unitCursor.offset) };
        return 'paused';
      }
      segment.bytes += last.end - unitCursor.offset;
      const { crc } = unit.checkpoint(last.end);
      segment.next = {
        file: fileIndex,
        member: unit.member,
        offset: last.end,
        ...(crc !== undefined ? { crc } : {}),
        resume: last.resume,
        done: false,
      };
      segment.position = { fileIndex, offset: unit.progressOf(last.end) };
      return 'paused';
    };
    for (;;) {
      if (!input.shouldContinue()) {
        segment.stopped = true;
        return pause();
      }
      if (segment.items.length >= limits.items || segment.consumed >= limits.units) return pause();
      // The budget is held at every record. The first record of a listing is always read, so a listing always moves on.
      const spent = segment.bytes + (last ? last.end - unitCursor.offset : 0);
      if (spent >= limits.bytes && (last !== undefined || segment.consumed > 0 || limits.started)) {
        segment.budgetHit = true;
        return pause();
      }
      let event: JsonStreamEvent | undefined;
      try {
        event = reader.next();
      } catch (error) {
        if (error instanceof ReadInterrupted) {
          // Told to stop part-way through a record: it is read again from the last whole one.
          segment.stopped = true;
          return pause();
        }
        unit.close();
        if (error instanceof ArchiveImportStoppedError) throw error;
        if (error instanceof ZipMemberError || (error instanceof JsonStreamError && error.code !== 'resume_invalid')) {
          // The rest of this document could not be read: what came before it stays.
          segment.bytes += (last?.end ?? unitCursor.offset) - unitCursor.offset;
          damaged(last?.end ?? unitCursor.offset);
          return 'ended';
        }
        throw stoppedFrom(error, relPath);
      }
      if (!event) {
        unit.close();
        const readTo = Math.max(last?.end ?? unitCursor.offset, reader.position);
        const end = unit.end();
        if (end && (end.crcOk === false || !end.sizeOk)) {
          segment.bytes += readTo - unitCursor.offset;
          damaged(end.bytes);
          return 'ended';
        }
        if (!last && !unitCursor.resume) {
          // No notes at all: an export with none, or a document that has no list of them.
          const there = listIsThere(unit, itemPaths, relPath);
          if (there === 'interrupted') {
            segment.stopped = true;
            return pause();
          }
          if (!there) notRead();
        }
        segment.bytes += readTo - unitCursor.offset;
        return 'ended';
      }
      last = event;
      const offset = unit.posOf(event.start);
      if (event.resume.levels[event.resume.levels.length - 1]?.kind !== 'array') {
        // Where the notes should be is a value of another kind: nothing here is read as a note.
        unit.close();
        segment.bytes += event.end - unitCursor.offset;
        notRead();
        return 'ended';
      }
      if (event.kind === 'oversize') {
        segment.consumed += 1;
        report(NOTE_FINDINGS.tooLarge, 'gap', fileIndex, offset);
        continue;
      }
      const index = event.path[event.path.length - 1];
      const place: NotePlace = { fileIndex, member: unit.member, ordinal: typeof index === 'number' ? index : event.start };
      takeNote(segment, source.parse(event.value), place, offset, savedAt);
    }
  };

  /**
   * The text of a Markdown member (the first MARKDOWN_MAX_BYTES of it), why it
   * has none (undefined), or that the import was told to stop while it was
   * being read ('stopped'). The whole member is read, so its checksum is checked.
   */
  const readMarkdownMember = (
    archive: ZipArchive,
    entry: ZipEntry,
  ): { text: string; cut: boolean; end: ZipMemberEnd | undefined } | undefined | 'stopped' => {
    let member: ZipMemberReader;
    try {
      member = ZipMemberReader.open(archive, entry);
    } catch (error) {
      if (error instanceof ZipMemberError) return undefined;
      throw error;
    }
    const parts: Uint8Array[] = [];
    let kept = 0;
    let cut = false;
    try {
      for (;;) {
        if (!input.shouldContinue()) return 'stopped';
        const chunk = member.next();
        if (!chunk) break;
        if (kept < MARKDOWN_MAX_BYTES) {
          const take = chunk.subarray(0, MARKDOWN_MAX_BYTES - kept);
          parts.push(take);
          kept += take.length;
          if (take.length < chunk.length) cut = true;
        } else {
          cut = true;
        }
      }
    } catch (error) {
      if (error instanceof ZipMemberError) return undefined;
      throw error;
    } finally {
      member.close();
    }
    const joined = new Uint8Array(kept);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return { text: new TextDecoder('utf-8').decode(joined), cut, end: member.end };
  };

  const readMarkdownZip = (
    archive: ZipArchive,
    fileIndex: number,
    cursor: Cursor,
    limits: Limits,
    segment: Segment,
    savedAt: string,
  ): void => {
    if (source.kind !== 'markdown') return;
    const from = Math.max(0, cursor.member);
    for (const entry of archive.entries()) {
      if (entry.index < from || entry.isDirectory || isJunkArchiveMember(entry.name) || !source.isNote(entry.name)) continue;
      const here: Cursor = { file: fileIndex, member: entry.index, offset: 0, done: false };
      if (!input.shouldContinue()) {
        segment.stopped = true;
        segment.next = here;
        return;
      }
      if (segment.items.length >= limits.items || segment.consumed >= limits.units) {
        segment.next = here;
        segment.position = { fileIndex, offset: entry.localHeaderOffset };
        return;
      }
      // The budget is held at every member (by its declared size); the first member of a listing is always read.
      if (segment.bytes + entry.uncompressedSize > limits.bytes && (segment.consumed > 0 || limits.started)) {
        segment.budgetHit = true;
        segment.next = here;
        segment.position = { fileIndex, offset: entry.localHeaderOffset };
        return;
      }
      const offset = zipFindingOffset(entry.index, 0);
      const fileName = entry.name.slice(entry.name.lastIndexOf('/') + 1);
      const read = readMarkdownMember(archive, entry);
      if (read === 'stopped') {
        // Told to stop part-way through a member: it is read again from its start.
        segment.stopped = true;
        segment.next = here;
        segment.position = { fileIndex, offset: entry.localHeaderOffset };
        return;
      }
      segment.bytes += entry.uncompressedSize;
      if (!read) {
        segment.consumed += 1;
        report(NOTE_FINDINGS.unreadable, 'gap', fileIndex, offset);
      } else {
        const place: NotePlace = { fileIndex, member: entry.index, ordinal: entry.index };
        takeNote(segment, source.parse(read.text, fileName), place, offset, savedAt, read.cut);
        if (read.end && (read.end.crcOk === false || !read.end.sizeOk)) {
          report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', fileIndex, zipFindingOffset(entry.index, entry.uncompressedSize));
        }
      }
      segment.next = { file: fileIndex, member: entry.index + 1, offset: 0, done: false };
      segment.position = { fileIndex, offset: entry.localHeaderOffset };
    }
    segment.next = startOfFile(fileIndex + 1);
    finishZip(archive, fileIndex);
  };

  const readJsonZip = (
    archive: ZipArchive,
    file: ArchiveFileEntry,
    fileIndex: number,
    cursor: Cursor,
    limits: Limits,
    segment: Segment,
    savedAt: string,
  ): void => {
    if (source.kind !== 'json') return;
    const from = Math.max(0, cursor.member);
    let foundResume = cursor.offset === 0;
    for (const entry of archive.entries()) {
      if (entry.index < from || entry.isDirectory || isJunkArchiveMember(entry.name) || !/\.json$/i.test(entry.name)) continue;
      const resuming = entry.index === cursor.member && cursor.offset > 0;
      if (resuming) foundResume = true;
      const unitCursor: Cursor = resuming ? cursor : { file: fileIndex, member: entry.index, offset: 0, done: false };
      if (!resuming) {
        if (!input.shouldContinue()) {
          segment.stopped = true;
          segment.next = unitCursor;
          return;
        }
        if (segment.bytes >= limits.bytes && (segment.consumed > 0 || limits.started)) {
          segment.budgetHit = true;
          segment.next = unitCursor;
          segment.position = { fileIndex, offset: entry.localHeaderOffset };
          return;
        }
        // A JSON file in the zip is read as this format only when it shows this format's hand; any other is reported, not guessed at.
        const head = readZipMemberHead(archive, entry, ARCHIVE_PROBE_HEAD_BYTES);
        if (head && head.length > 0 && !source.accepts(head)) {
          segment.consumed += 1;
          report(ARCHIVE_COMMON_FINDINGS.sectionNotImported, 'gap', fileIndex, zipFindingOffset(entry.index, 0));
          segment.next = { file: fileIndex, member: entry.index + 1, offset: 0, done: false };
          segment.position = { fileIndex, offset: entry.localHeaderOffset + entry.compressedSize };
          continue;
        }
      }
      const unit = zipUnit(archive, entry, fileIndex);
      const result = readJsonUnit(unit, unitCursor, fileIndex, file.relPath, limits, segment, savedAt);
      if (result === 'paused') return;
      segment.next = { file: fileIndex, member: entry.index + 1, offset: 0, done: false };
      segment.position = { fileIndex, offset: entry.localHeaderOffset + entry.compressedSize };
    }
    // A resume point inside a member that is not there is not this archive's.
    if (!foundResume) throw invalid('Nothing starts where this import was to resume.');
    segment.next = startOfFile(fileIndex + 1);
    finishZip(archive, fileIndex);
  };

  /** The zip is read to its end: what else it holds is counted, once, after every note's place. */
  const finishZip = (archive: ZipArchive, fileIndex: number): void => {
    let other = 0;
    for (const entry of archive.entries()) {
      if (entry.isDirectory || isJunkArchiveMember(entry.name)) continue;
      const read = source.kind === 'json' ? /\.json$/i.test(entry.name) : source.isNote(entry.name);
      if (!read) other += 1;
    }
    if (other > 0) report(ARCHIVE_COMMON_FINDINGS.mediaNotImported, 'gap', fileIndex, zipFindingOffset(archive.entryCount, 0), other);
  };

  const readSegment = (cursor: Cursor, limits: Limits): Segment => {
    const file = input.files[cursor.file]!;
    const segment: Segment = { items: [], next: cursor, consumed: 0, bytes: 0, stopped: false, budgetHit: false };
    let reader: ScopeFileReader;
    try {
      reader = input.root.openFile(file.relPath, { expected: file.version });
    } catch (error) {
      throw stoppedFrom(error, file.relPath);
    }
    try {
      const savedAt = new Date(Number.isFinite(file.version.mtimeMs) ? file.version.mtimeMs : 0).toISOString();
      let head: Uint8Array;
      try {
        head = reader.readAt(0, 4);
      } catch (error) {
        throw stoppedFrom(error, file.relPath);
      }
      if (ZipArchive.looksLikeZip(head)) {
        let archive: ZipArchive;
        try {
          archive = ZipArchive.open(stoppableZipSource(reader, file.relPath));
        } catch (error) {
          if (!(error instanceof ZipFormatError)) throw stoppedFrom(error, file.relPath);
          report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', cursor.file, 0);
          segment.next = startOfFile(cursor.file + 1);
          return segment;
        }
        try {
          if (source.kind === 'json') readJsonZip(archive, file, cursor.file, cursor, limits, segment, savedAt);
          else readMarkdownZip(archive, cursor.file, cursor, limits, segment, savedAt);
        } catch (error) {
          if (error instanceof ZipFormatError) {
            // The zip's directory itself gave out part-way: what was read stays.
            report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', cursor.file, zipFindingOffset(archive.entryCount, 0));
            segment.next = startOfFile(cursor.file + 1);
          } else {
            throw stoppedFrom(error, file.relPath);
          }
        }
      } else if (source.kind === 'json') {
        const result = readJsonUnit(plainUnit(reader), cursor, cursor.file, file.relPath, limits, segment, savedAt);
        if (result === 'ended') segment.next = startOfFile(cursor.file + 1);
      } else {
        // Markdown notes come in a zip; a file that is not one holds none.
        report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', cursor.file, 0);
        segment.next = startOfFile(cursor.file + 1);
      }
      // Before anything read goes out: the file is still the version opened, at its name too.
      try {
        reader.assertCurrent();
      } catch (error) {
        throw stoppedFrom(error, file.relPath);
      }
      return segment;
    } finally {
      reader.close();
    }
  };

  return {
    id: input.connectorId,
    family: input.format.family,
    async authenticate(): Promise<void> {
      // No account: the approved files are the whole grant.
    },
    listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        let cursor = decode(options?.cursor);
        if (cursor.done) {
          yield { items: [], nextCursor: encode(DONE), done: true };
          return;
        }
        const limit = options?.limit !== undefined && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
        let emitted = 0;
        let bytesRead = 0;
        let page: RawItem[] = [];
        let units = 0;
        let pending = false;
        let position: { fileIndex: number; offset: number } | undefined;
        for (;;) {
          const room = Math.max(1, Math.min(pageSizeDefault, limit - emitted) - page.length);
          const segment = readSegment(cursor, {
            items: room,
            units: Math.max(1, NOTES_MAX_UNITS_PER_PAGE - units),
            bytes: Math.max(1, byteBudget - bytesRead),
            started: bytesRead > 0 || emitted > 0 || page.length > 0 || units > 0,
          });
          page.push(...segment.items);
          cursor = segment.next;
          units += segment.consumed;
          bytesRead += segment.bytes;
          if (segment.consumed > 0 || segment.items.length > 0) pending = true;
          if (segment.position) position = segment.position;
          if (segment.stopped) {
            if (pending) {
              if (position) input.reportPosition?.(position);
              yield { items: page, nextCursor: encode(cursor), done: false };
            }
            return;
          }
          if (cursor.done) {
            yield { items: page, nextCursor: encode(DONE), done: true };
            return;
          }
          const spentBudget = segment.budgetHit || bytesRead >= byteBudget;
          const full = page.length >= Math.min(pageSizeDefault, limit - emitted);
          if (full || spentBudget || units >= NOTES_MAX_UNITS_PER_PAGE) {
            if (position) input.reportPosition?.(position);
            yield { items: page, nextCursor: encode(cursor), done: false };
            emitted += page.length;
            page = [];
            units = 0;
            pending = false;
            if (emitted >= limit || spentBudget) return;
          }
        }
      })();
    },
    async fetchItem(): Promise<RawItem> {
      throw new Error('An imported note is read only while its archive is listed.');
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      return noteClassificationSignals(item);
    },
  };
}
