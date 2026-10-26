/**
 * The Evernote archive connector: one note per `<note>` of an Evernote export
 * (`.enex`, one file or a folder of them), and each of its attachments
 * (`<resource>`) as a child item, listed by name and read later, on its own
 * (docs/design/child-items.md).
 *
 * - Reading: through the shared XML reader (`xml-stream.ts`) over the
 *   scope-safe range reader, a note at a time, never a whole file. An
 *   attachment's base64 is never held while listing: the reader says where it
 *   is in the file, and that place is the child's locator.
 * - A note: its title, tags, created and updated times, and its body (ENML)
 *   as plain lines (`enml.ts`), built like every notes format's item
 *   (`notes/note.ts`). Encrypted text is never read and is counted as content
 *   Olympus could not read.
 * - An attachment: named by its file name (else its type), with its type; its
 *   bytes are read by `fetchItem` from the locator, which names the manifest,
 *   the file and the byte range, so a read of other files is refused. Each is
 *   judged on its own, takes no floor from its note, and is held until judged
 *   like every item of an archive.
 * - Findings: an empty note is skipped, a note past NOTE_MAX_RECORD_BYTES
 *   (its attachments' bytes not counted) is `note_too_large`, encrypted text
 *   is `note_content_unsupported`, an attachment whose bytes are not in the
 *   file (or not in base64) is `media_not_imported`, a file that is not an
 *   Evernote export is `section_not_imported`, and damaged XML is
 *   `file_damaged` (what was whole before it stays). Each is at the place of
 *   its note, so a page read again after a restart counts nothing twice.
 * - Resume point: `enex1:<manifest>:<file>:<offset>:<from>`, the byte offset
 *   of the next note to read and how many of its items already went out (a
 *   note with many attachments is cut across pages inside it).
 */
import { createHash } from 'node:crypto';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_PROBE_HEAD_BYTES,
  ArchiveImportStoppedError,
  looksLikeEnex,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../../core/contracts.ts';
import { childProviderItemId } from '../../../core/child-item-id.ts';
import { FileExtractionSourceError } from '../../../core/file-extraction-source.ts';
import type { ScopeFileReader } from '../../../core/scope-safe-fs.ts';
import { fileByteSource, type ArchiveByteSource } from '../byte-source.ts';
import { archiveStopFromScopeError } from '../stop-errors.ts';
import { XmlStreamError, XmlStreamReader, xmlChild, xmlChildren, xmlText, type XmlElement } from '../xml-stream.ts';
import { NOTE_FINDINGS, NOTE_MAX_RECORD_BYTES, buildNoteItem, cleanTags, noteClassificationSignals } from '../notes/note.ts';
import { enmlToText } from './enml.ts';

export const EVERNOTE_CURSOR_PREFIX = 'enex1:';
export const EVERNOTE_DEFAULT_PAGE_SIZE = 100;
export const EVERNOTE_DEFAULT_MAX_BYTES_PER_LISTING = 256 * 1024 * 1024;
/** Notes and findings read before a page goes out even when it holds few items. */
const EVERNOTE_MAX_UNITS_PER_PAGE = 5_000;
/** An attachment is read in slices of this many bytes of base64. */
const FETCH_SLICE_BYTES = 1024 * 1024;
const RECORD_PATH = ['en-export', 'note'] as const;

interface Cursor {
  file: number;
  /** The byte offset of the next note (0: the start of the file). */
  offset: number;
  /** How many of that note's items already went out. */
  from: number;
  done: boolean;
}

interface Segment {
  items: RawItem[];
  positions: Array<{ fileIndex: number; offset: number }>;
  next: Cursor;
  consumed: number;
  bytes: number;
  stopped: boolean;
  budgetHit: boolean;
}

/** The import was told to stop while a note was being read: what was whole before it stays. */
class ReadInterrupted extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** ENEX's time (`20230101T120000Z`) as ISO; undefined for anything else. */
export function enexTime(value: string | undefined): string | undefined {
  const match = /^\s*(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\s*$/.exec(value ?? '');
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const textOf = (element: XmlElement | undefined): string => (element ? xmlText(element).trim() : '');

const BASE64 = (() => {
  const table = new Int16Array(256).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  return table;
})();

/**
 * Base64 from `start` to `end` of a file, decoded a slice at a time, space
 * skipped, stopping after `cap` bytes. Anything that is not base64 refuses
 * the read.
 */
export function decodeBase64Range(reader: ScopeFileReader, start: number, end: number, cap: number): Uint8Array {
  const out: Uint8Array[] = [];
  let total = 0;
  let pending: Uint8Array = new Uint8Array(Math.min(cap, 64 * 1024) + 3);
  let used = 0;
  const push = (byte: number): boolean => {
    if (used === pending.length) {
      out.push(pending.subarray(0, used));
      pending = new Uint8Array(Math.min(Math.max(64 * 1024, pending.length * 2), 16 * 1024 * 1024));
      used = 0;
    }
    pending[used++] = byte;
    total += 1;
    return total >= cap;
  };
  let quad = 0;
  let count = 0;
  let padded = false;
  outer: for (let at = start; at < end; at += FETCH_SLICE_BYTES) {
    const slice = reader.readAt(at, Math.min(FETCH_SLICE_BYTES, end - at));
    for (let index = 0; index < slice.length; index += 1) {
      const byte = slice[index]!;
      if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) continue;
      if (byte === 0x3d) {
        padded = true;
        continue;
      }
      const value = BASE64[byte]!;
      if (value < 0 || padded) throw new FileExtractionSourceError('source_content_unavailable');
      quad = (quad << 6) | value;
      count += 1;
      if (count === 4) {
        if (push((quad >> 16) & 0xff) || push((quad >> 8) & 0xff) || push(quad & 0xff)) break outer;
        quad = 0;
        count = 0;
      }
    }
  }
  if (total < cap) {
    if (count === 2) push((quad >> 4) & 0xff);
    else if (count === 3) {
      if (!push((quad >> 10) & 0xff)) push((quad >> 2) & 0xff);
    } else if (count === 1) throw new FileExtractionSourceError('source_content_unavailable');
  }
  out.push(pending.subarray(0, used));
  const bytes = new Uint8Array(Math.min(total, cap));
  let at = 0;
  for (const part of out) {
    const take = Math.min(part.length, bytes.length - at);
    bytes.set(part.subarray(0, take), at);
    at += take;
    if (at >= bytes.length) break;
  }
  return bytes;
}

export function createEvernoteArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  const pageSizeDefault = Math.max(1, input.pageSize ?? EVERNOTE_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, input.maxBytesPerListing ?? EVERNOTE_DEFAULT_MAX_BYTES_PER_LISTING);
  const tag = input.manifestSha256.slice(0, 16);
  const prefix = `${EVERNOTE_CURSOR_PREFIX}${tag}:`;
  const DONE: Cursor = { file: input.files.length, offset: 0, from: 0, done: true };
  const startOfFile = (file: number): Cursor => (file >= input.files.length ? DONE : { file, offset: 0, from: 0, done: false });

  const invalid = (message: string): ArchiveImportStoppedError => new ArchiveImportStoppedError('resume_point_invalid', message);

  const encode = (cursor: Cursor): string => (cursor.done ? `${prefix}done` : `${prefix}${cursor.file}:${cursor.offset}:${cursor.from}`);

  const decode = (text: string | undefined): Cursor => {
    if (!text) return startOfFile(0);
    if (!text.startsWith(prefix)) throw invalid('The resume point belongs to other files than this archive\'s.');
    const rest = text.slice(prefix.length);
    if (rest === 'done') return DONE;
    const parts = rest.split(':').map(Number);
    const [file, offset, from] = parts as [number, number, number];
    if (parts.length !== 3 || !parts.every((part) => Number.isSafeInteger(part) && part >= 0) || file >= input.files.length
      || offset > input.files[file]!.version.size) {
      throw invalid('The resume point is not a position in this archive.');
    }
    return { file, offset, from, done: false };
  };

  const report = (kind: string, findingClass: 'gap' | 'skipped', fileIndex: number, offset: number, count?: number): void => {
    input.report({ kind, class: findingClass, fileIndex, offset, ...(count !== undefined ? { count } : {}) });
  };

  /** A note and its attachments, parent first; the place of each for counting; findings reported at the note's place. */
  const buildNote = (note: XmlElement, fileIndex: number, start: number, savedAt: string): { items: RawItem[]; positions: number[] } => {
    const title = textOf(xmlChild(note, 'title'));
    const contentElement = xmlChild(note, 'content');
    const body = contentElement ? enmlToText(xmlText(contentElement)) : { text: '', unsupported: 0, media: 0 };
    const resources = xmlChildren(note, 'resource');
    // Like a page with no text in any block (Reflect, Roam): a title alone is not something written.
    if (body.text === '' && resources.length === 0) {
      report(NOTE_FINDINGS.empty, 'skipped', fileIndex, start);
      return { items: [], positions: [] };
    }
    const createdAt = enexTime(textOf(xmlChild(note, 'created')));
    const updatedAt = enexTime(textOf(xmlChild(note, 'updated')));
    const built = buildNoteItem(input, {
      title,
      body: body.text,
      tags: cleanTags(xmlChildren(note, 'tag').map((element) => textOf(element))),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(body.unsupported > 0 ? { unsupported: body.unsupported } : {}),
    }, { fileIndex, member: -1, ordinal: start }, savedAt);
    if (body.unsupported > 0) report(NOTE_FINDINGS.unsupported, 'gap', fileIndex, start);
    if (built.dateAssumed) report(NOTE_FINDINGS.dateAssumed, 'gap', fileIndex, start);
    const parent = built.item;
    const items: RawItem[] = [parent];
    const positions = [start];
    resources.forEach((resource, index) => {
      const data = xmlChild(resource, 'data');
      const mime = textOf(xmlChild(resource, 'mime')) || 'application/octet-stream';
      const attributes = xmlChild(resource, 'resource-attributes');
      const fileName = textOf(attributes ? xmlChild(attributes, 'file-name') : undefined);
      const name = (fileName || `Attachment ${index + 1} (${mime})`).slice(0, 500);
      const ranges = data?.ranges ?? [];
      const encoding = (data?.attributes['encoding'] ?? 'base64').toLowerCase();
      const readable = data !== undefined && encoding === 'base64' && data.rangeEntities !== true && ranges.length === 1;
      const range = readable ? ranges[0]! : undefined;
      // Evernote's own reading of the attachment (`<recognition>`) is not used yet: it waits for
      // RawItem.providerText (docs/design/child-items.md, "Text the provider supplies").
      const locator = range
        ? `${prefix}${fileIndex}:${range.start}:${range.end}:${Buffer.from(mime).toString('base64url')}`
        : `${prefix}none`;
      // The child's id is its parent's and its place among the note's resources (child-item-id.ts).
      const providerItemId = childProviderItemId(parent.identity.providerItemId, `resource-${index}`);
      const authoredAt = parent.metadata['authoredAt'];
      items.push({
        identity: {
          family: input.format.family,
          provider: input.format.provider,
          accountScope: input.accountScope,
          providerItemId,
          localItemId: `${input.accountScope}:${providerItemId}`,
          sourceVersion: sha256(`${locator}\u0000${name}`).slice(0, 32),
          parent: { providerItemId: parent.identity.providerItemId, localItemId: parent.identity.localItemId },
        },
        mimeType: mime,
        content: { kind: 'metadata_only' },
        metadata: Object.freeze({
          title: name,
          name,
          mimeType: mime,
          ...(typeof authoredAt === 'string' ? { authoredAt } : {}),
        }),
        fetchedAt: new Date().toISOString(),
        deferredBytes: { locator, available: readable },
      });
      positions.push(start + 1 + index);
      if (!readable) report(ARCHIVE_COMMON_FINDINGS.mediaNotImported, 'gap', fileIndex, start + 1 + index);
    });
    return { items, positions };
  };

  const readSegment = (cursor: Cursor, room: number, bytesLeft: number, started: boolean): Segment => {
    const file = input.files[cursor.file]!;
    const segment: Segment = { items: [], positions: [], next: cursor, consumed: 0, bytes: 0, stopped: false, budgetHit: false };
    let reader: ScopeFileReader;
    try {
      reader = input.root.openFile(file.relPath, { expected: file.version });
    } catch (error) {
      throw archiveStopFromScopeError(error, file.relPath);
    }
    try {
      const savedAt = new Date(Number.isFinite(file.version.mtimeMs) ? file.version.mtimeMs : 0).toISOString();
      if (cursor.offset === 0) {
        let head: Uint8Array;
        try {
          head = reader.readAt(0, ARCHIVE_PROBE_HEAD_BYTES);
        } catch (error) {
          throw archiveStopFromScopeError(error, file.relPath);
        }
        if (!looksLikeEnex(head)) {
          report(ARCHIVE_COMMON_FINDINGS.sectionNotImported, 'gap', cursor.file, 0);
          segment.next = startOfFile(cursor.file + 1);
          return segment;
        }
      }
      const inner = fileByteSource(reader, { start: cursor.offset });
      const watched: ArchiveByteSource = {
        get position() { return inner.position; },
        next() {
          if (!input.shouldContinue()) throw new ReadInterrupted();
          return inner.next();
        },
        unread: (count) => inner.unread(count),
      };
      const xml = new XmlStreamReader(watched, {
        recordPaths: [RECORD_PATH],
        // An attachment's bytes are read later, from their place in the file; Evernote's reading of it is not held.
        rangeElements: ['data', 'recognition'],
        maxRecordBytes: NOTE_MAX_RECORD_BYTES,
        ...(cursor.offset > 0 ? { open: [RECORD_PATH[0]] } : {}),
      });
      for (;;) {
        if (segment.items.length >= room || segment.consumed >= EVERNOTE_MAX_UNITS_PER_PAGE) break;
        if (segment.bytes >= bytesLeft && (segment.consumed > 0 || started)) {
          segment.budgetHit = true;
          break;
        }
        let event;
        try {
          event = xml.next();
        } catch (error) {
          if (error instanceof ReadInterrupted) {
            segment.stopped = true;
            break;
          }
          if (error instanceof XmlStreamError) {
            report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', cursor.file, error.offset);
            segment.next = startOfFile(cursor.file + 1);
            break;
          }
          throw archiveStopFromScopeError(error, file.relPath);
        } finally {
          segment.bytes = inner.position - cursor.offset;
        }
        if (!event) {
          // A file that held no root at all is no export after all.
          if (xml.rootName === undefined) report(ARCHIVE_COMMON_FINDINGS.fileDamaged, 'gap', cursor.file, 0);
          segment.next = startOfFile(cursor.file + 1);
          break;
        }
        if (cursor.offset > 0 && event.start < cursor.offset) throw invalid('Nothing starts where this import was to resume.');
        segment.consumed += 1;
        if (event.kind === 'oversize') {
          report(NOTE_FINDINGS.tooLarge, 'gap', cursor.file, event.start);
          segment.next = { file: cursor.file, offset: event.end, from: 0, done: false };
          continue;
        }
        const built = buildNote(event.element, cursor.file, event.start, savedAt);
        const skip = event.start === cursor.offset ? Math.min(cursor.from, built.items.length) : 0;
        const left = built.items.length - skip;
        const take = Math.min(left, room - segment.items.length);
        segment.items.push(...built.items.slice(skip, skip + take));
        segment.positions.push(...built.positions.slice(skip, skip + take).map((offset) => ({ fileIndex: cursor.file, offset })));
        if (take < left) {
          segment.next = { file: cursor.file, offset: event.start, from: skip + take, done: false };
          break;
        }
        segment.next = { file: cursor.file, offset: event.end, from: 0, done: false };
      }
      // Before anything read goes out: the file is still the version opened, at its name too.
      try {
        reader.assertCurrent();
      } catch (error) {
        throw archiveStopFromScopeError(error, file.relPath);
      }
      return segment;
    } finally {
      reader.close();
    }
  };

  /** An attachment's bytes, from its locator: at most `cap`. */
  const readAttachment = (localItemId: string, options: SourceConnectorFetchOptions | undefined, cap: number): RawItem => {
    const locator = options?.deferredBytes?.locator;
    if (!locator) throw new FileExtractionSourceError('source_item_not_found');
    const match = /^enex1:([0-9a-f]{16}):(\d+):(\d+):(\d+):([A-Za-z0-9_-]*)$/.exec(locator);
    if (!match || match[1] !== tag) throw new FileExtractionSourceError('source_version_gone');
    const fileIndex = Number(match[2]);
    const start = Number(match[3]);
    const end = Number(match[4]);
    const file = input.files[fileIndex];
    if (!file || !(start < end) || end > file.version.size) throw new FileExtractionSourceError('source_version_gone');
    const mime = Buffer.from(match[5]!, 'base64url').toString('utf8') || 'application/octet-stream';
    const reader = input.root.openFile(file.relPath, { expected: file.version });
    try {
      const bytes = decodeBase64Range(reader, start, end, cap);
      reader.assertCurrent();
      const scopePrefix = `${input.accountScope}:`;
      const providerItemId = localItemId.startsWith(scopePrefix) ? localItemId.slice(scopePrefix.length) : localItemId;
      return {
        identity: {
          family: input.format.family,
          provider: input.format.provider,
          accountScope: input.accountScope,
          providerItemId,
          localItemId,
        },
        mimeType: mime,
        content: { kind: 'bytes', mimeType: mime, bytes },
        metadata: Object.freeze({}),
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      reader.close();
    }
  };

  const connector: SourceConnector & {
    fetchItemWithin(localItemId: string, options: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string } }): Promise<RawItem>;
  } = {
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
        let positions: Array<{ fileIndex: number; offset: number }> = [];
        let units = 0;
        let pending = false;
        const send = (done: boolean): SourceConnectorListPage => {
          input.reportPosition?.({ fileIndex: Math.min(cursor.file, input.files.length - 1), offset: cursor.done ? input.files[input.files.length - 1]?.version.size ?? 0 : cursor.offset });
          input.reportItemPositions?.(positions);
          return done ? { items: page, nextCursor: encode(DONE), done: true } : { items: page, nextCursor: encode(cursor), done: false };
        };
        for (;;) {
          const room = Math.max(1, Math.min(pageSizeDefault, limit - emitted) - page.length);
          const segment = readSegment(cursor, room, Math.max(1, byteBudget - bytesRead), bytesRead > 0 || emitted > 0 || page.length > 0 || units > 0);
          page.push(...segment.items);
          positions.push(...segment.positions);
          cursor = segment.next;
          units += segment.consumed;
          bytesRead += segment.bytes;
          if (segment.consumed > 0 || segment.items.length > 0) pending = true;
          if (segment.stopped) {
            if (pending) yield send(false);
            return;
          }
          if (cursor.done) {
            yield send(true);
            return;
          }
          const spentBudget = segment.budgetHit || bytesRead >= byteBudget;
          const full = page.length >= Math.min(pageSizeDefault, limit - emitted);
          if (full || spentBudget || units >= EVERNOTE_MAX_UNITS_PER_PAGE) {
            yield send(false);
            emitted += page.length;
            page = [];
            positions = [];
            units = 0;
            pending = false;
            if (emitted >= limit || spentBudget) return;
          }
        }
      })();
    },
    async fetchItem(localItemId: string, options?: SourceConnectorFetchOptions): Promise<RawItem> {
      return readAttachment(localItemId, options, Number.MAX_SAFE_INTEGER);
    },
    async fetchItemWithin(localItemId, options): Promise<RawItem> {
      // At most one byte past the ceiling, so the caller can tell "over the limit" from "exactly the limit".
      const cap = options.maxBytes !== undefined ? options.maxBytes + 1 : Number.MAX_SAFE_INTEGER;
      return readAttachment(localItemId, options.deferredBytes ? { deferredBytes: options.deferredBytes } : undefined, cap);
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      return noteClassificationSignals(item);
    },
  };
  return connector;
}

/** Registers the Evernote connector with the format registry. Idempotent. */
export function registerEvernoteArchiveConnector(): void {
  registerArchiveFormatConnector('evernote-enex', createEvernoteArchiveConnector);
}
