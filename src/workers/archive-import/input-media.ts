/**
 * The media of an archive that is one input of a source
 * (docs/design/archive-live-one-dataset.md, section 5): a photo or file the
 * export carries becomes a child item in the source's own stores, listed by
 * name with a locator, and its bytes are read later through here.
 *
 * Imports under Archives keep their own reader (extraction-source.ts), whose
 * account scope is the archive. An input's child lives in the source's
 * account instead, so its locator names the archive itself. Nothing here
 * names a source or a format.
 *
 * - A locator names the archive and either a media binding (a file beside the
 *   export in the chosen folder, bound before the child was listed:
 *   media-bindings.ts) or a member of one of the export's zip files by its
 *   place in the zip's directory. Never a path or a member name.
 * - Bytes are served only while the import's record is there and is an input
 *   of a source; a record that is gone or being removed serves nothing.
 * - Reads are bounded and go through the scope-safe module at the version the
 *   import recorded: a file that changed since is `source_version_gone`.
 */

import { FileExtractionSourceError } from '../../core/file-extraction-source.ts';
import { ScopeRoot, ScopeSafeError, SCOPE_FILE_MAX_RANGE_BYTES, type ScopeFileReader } from '../../core/scope-safe-fs.ts';
import { archiveMediaAccess, ARCHIVE_MEDIA_DEFAULT_READ_BYTES, type ArchiveMediaBindings } from './media-bindings.ts';
import type { ArchiveImportRecord, ArchiveImportStateStore } from './state.ts';
import { ZipArchive, ZipFormatError, ZipMemberError, ZipMemberReader } from './zip-reader.ts';

const PREFIX = 'archive-input-media:v1:';
const ARCHIVE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BINDING_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** A file beside the export, by its binding. */
export interface ArchiveInputMediaRef {
  archiveId: string;
  bindingId: string;
}

/** A member of one of the export's zip files, by the file's place in the manifest and the member's in the zip. */
export interface ArchiveInputZipMediaRef {
  archiveId: string;
  fileIndex: number;
  memberIndex: number;
}

export type ArchiveInputMediaLocator =
  | ({ kind: 'binding' } & ArchiveInputMediaRef)
  | ({ kind: 'zip' } & ArchiveInputZipMediaRef);

export function archiveInputMediaLocator(ref: ArchiveInputMediaRef): string {
  if (!ARCHIVE_ID.test(ref.archiveId) || !BINDING_ID.test(ref.bindingId)) throw new Error('An archive media locator needs a plain archive and binding id.');
  return `${PREFIX}${ref.archiveId}:b:${ref.bindingId}`;
}

export function archiveInputZipMediaLocator(ref: ArchiveInputZipMediaRef): string {
  if (!ARCHIVE_ID.test(ref.archiveId) || !Number.isSafeInteger(ref.fileIndex) || ref.fileIndex < 0
    || !Number.isSafeInteger(ref.memberIndex) || ref.memberIndex < 0) {
    throw new Error('An archive zip media locator needs a plain archive id and two places.');
  }
  return `${PREFIX}${ref.archiveId}:z:${ref.fileIndex}:${ref.memberIndex}`;
}

/** The binding a locator names, or undefined for any other locator (a zip member's included). */
export function parseArchiveInputMediaLocator(locator: string): ArchiveInputMediaRef | undefined {
  const parsed = parseArchiveInputMedia(locator);
  return parsed?.kind === 'binding' ? { archiveId: parsed.archiveId, bindingId: parsed.bindingId } : undefined;
}

export function parseArchiveInputMedia(locator: string): ArchiveInputMediaLocator | undefined {
  if (!locator.startsWith(PREFIX)) return undefined;
  const parts = locator.slice(PREFIX.length).split(':');
  const [archiveId, kind] = parts;
  if (archiveId === undefined || !ARCHIVE_ID.test(archiveId)) return undefined;
  if (kind === 'b' && parts.length === 3 && BINDING_ID.test(parts[2]!)) return { kind: 'binding', archiveId, bindingId: parts[2]! };
  if (kind === 'z' && parts.length === 4 && /^\d{1,9}$/u.test(parts[2]!) && /^\d{1,9}$/u.test(parts[3]!)) {
    return { kind: 'zip', archiveId, fileIndex: Number(parts[2]), memberIndex: Number(parts[3]) };
  }
  return undefined;
}

export interface ArchiveInputMediaDeps {
  state: ArchiveImportStateStore;
  bindings?: ArchiveMediaBindings;
}

/** Whether the archive a locator names still serves its media: recorded, an input of a source, and not being removed. */
export function archiveInputMediaServed(deps: Pick<ArchiveInputMediaDeps, 'state'>, archiveId: string): boolean {
  return servedRecord(deps.state, archiveId) !== undefined;
}

function servedRecord(state: ArchiveImportStateStore, archiveId: string): ArchiveImportRecord | undefined {
  let record: ArchiveImportRecord | undefined;
  try {
    record = state.get(archiveId);
  } catch {
    return undefined;
  }
  if (!record || record.status === 'removing' || record.target === undefined) return undefined;
  return record;
}

/**
 * The bytes a locator names, up to `maxBytes` (64 MiB when none is named).
 * Throws `FileExtractionSourceError`: `source_item_not_found` (no such
 * archive, or it no longer serves), `source_version_gone` (the file changed
 * or went), `source_too_large`, `source_content_unavailable` (a member that
 * cannot be read: encrypted, damaged, another method).
 */
export function readArchiveInputMedia(
  locator: string,
  deps: ArchiveInputMediaDeps,
  options: { maxBytes?: number } = {},
): Uint8Array {
  const parsed = parseArchiveInputMedia(locator);
  if (!parsed) throw new FileExtractionSourceError('source_item_not_found');
  const record = servedRecord(deps.state, parsed.archiveId);
  if (!record) throw new FileExtractionSourceError('source_item_not_found');
  const maxBytes = options.maxBytes ?? ARCHIVE_MEDIA_DEFAULT_READ_BYTES;
  let root: ScopeRoot;
  try {
    root = ScopeRoot.open(record.root_path);
  } catch {
    throw new FileExtractionSourceError('source_version_gone');
  }
  try {
    return parsed.kind === 'binding'
      ? readBinding(deps, record, root, parsed.bindingId, maxBytes)
      : readZipMember(record, root, parsed, maxBytes);
  } catch (error) {
    if (error instanceof FileExtractionSourceError) throw error;
    if (error instanceof ScopeSafeError) {
      if (error.code === 'too_large') throw new FileExtractionSourceError('source_too_large');
      throw new FileExtractionSourceError('source_version_gone');
    }
    if (error instanceof ZipMemberError || error instanceof ZipFormatError) {
      throw new FileExtractionSourceError('source_content_unavailable');
    }
    throw error;
  } finally {
    root.close();
  }
}

function readBinding(deps: ArchiveInputMediaDeps, record: ArchiveImportRecord, root: ScopeRoot, bindingId: string, maxBytes: number): Uint8Array {
  if (!deps.bindings) throw new FileExtractionSourceError('source_item_not_found');
  const access = archiveMediaAccess({ bindings: deps.bindings, archiveId: record.archive_id, root, chosenRelPath: record.chosen_rel_path });
  return access.read(bindingId, { maxBytes });
}

function readZipMember(record: ArchiveImportRecord, root: ScopeRoot, ref: ArchiveInputZipMediaRef, maxBytes: number): Uint8Array {
  const file = record.files[ref.fileIndex];
  if (!file) throw new FileExtractionSourceError('source_item_not_found');
  let reader: ScopeFileReader | undefined;
  try {
    reader = root.openFile(file.rel_path, {
      expected: { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtime_ms },
    });
    const zip = ZipArchive.open(reader);
    // The directory recorded when the import began: a zip whose members changed under it serves nothing.
    if (file.members) {
      const table = zip.memberTable();
      if (table.count !== file.members.count || table.sha256 !== file.members.sha256) {
        throw new FileExtractionSourceError('source_version_gone');
      }
    }
    let entry;
    for (const candidate of zip.entries()) {
      if (candidate.index === ref.memberIndex) {
        entry = candidate;
        break;
      }
    }
    if (!entry || entry.isDirectory) throw new FileExtractionSourceError('source_item_not_found');
    if (entry.uncompressedSize > maxBytes) throw new FileExtractionSourceError('source_too_large');
    const member = ZipMemberReader.open(zip, entry);
    try {
      const out = new Uint8Array(entry.uncompressedSize);
      let at = 0;
      for (let chunk = member.next(); chunk !== undefined; chunk = member.next()) {
        if (at + chunk.length > out.length) throw new FileExtractionSourceError('source_content_unavailable');
        out.set(chunk, at);
        at += chunk.length;
      }
      const end = member.end;
      if (at !== out.length || !end || !end.sizeOk || end.crcOk === false) {
        throw new FileExtractionSourceError('source_content_unavailable');
      }
      reader.assertCurrent?.();
      return out;
    } finally {
      member.close();
    }
  } finally {
    reader?.close();
  }
}

/** The most one read of a bound file returns; larger media are read in ranges by their reader. */
export const ARCHIVE_INPUT_MEDIA_RANGE_BYTES = SCOPE_FILE_MAX_RANGE_BYTES;
