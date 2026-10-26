/**
 * One MIME part of one message of an imported mbox, read again later by the
 * extraction factory from the locator its child row keeps
 * (`mbox-part1:<archive>:<file>:<offset>:<part>`, gmail-input.ts).
 *
 * Bytes are read only from the import's own approved files, through the
 * scope-safe reader: the folder must be the one approved and every file the
 * version imported, or the read settles as a version that is gone. An import
 * being removed, or one that is not an input of the source asking, is not
 * served. The part's decoded size is bounded before it is decoded, so a size
 * stated wrongly cannot overrun memory.
 */
import { FileExtractionSourceError } from '../../../core/file-extraction-source.ts';
import { ScopeRoot, ScopeSafeError } from '../../../core/scope-safe-fs.ts';
import { archiveFileEntries, verifyArchiveManifest } from '../manifest.ts';
import type { ArchiveImportStateStore } from '../state.ts';
import { parseMboxPartLocator } from './gmail-input.ts';
import { MimePartTooLargeError, mimePartBytes } from './mime-parts.ts';
import { MBOX_DEFAULT_MAX_MESSAGE_BYTES, MboxFormatError, MboxSplitter } from './split.ts';

/** Whether an import still serves reads for a source: recorded, joined to that source, not being removed. */
export function importServesSource(state: ArchiveImportStateStore, archiveId: string, sourceId: string): boolean {
  try {
    const record = state.get(archiveId);
    return record !== undefined && record.status !== 'removing' && record.target?.source_id === sourceId;
  } catch {
    return false;
  }
}

export function readMboxPart(input: {
  state: ArchiveImportStateStore;
  /** The source the reading lane belongs to: only its imports are read. */
  sourceId: string;
  locator: string;
  maxBytes?: number;
}): { bytes: Uint8Array; mimeType: string } {
  const where = parseMboxPartLocator(input.locator);
  if (!where) throw new FileExtractionSourceError('source_content_unavailable');
  if (!importServesSource(input.state, where.archiveId, input.sourceId)) throw new FileExtractionSourceError('source_item_not_found');
  const record = input.state.get(where.archiveId)!;
  const file = archiveFileEntries(record.files)[where.fileIndex];
  if (!file) throw new FileExtractionSourceError('source_version_gone');
  let root: ScopeRoot;
  try {
    root = ScopeRoot.open(record.root_path);
  } catch (error) {
    throw new FileExtractionSourceError(error instanceof ScopeSafeError && error.code === 'not_found' ? 'source_content_unavailable' : 'source_unavailable');
  }
  try {
    if (root.identity.dev !== record.root_identity.dev || root.identity.ino !== record.root_identity.ino) {
      throw new FileExtractionSourceError('source_version_gone');
    }
    const check = verifyArchiveManifest(root, record.files, { memberTables: false });
    if (!check.ok) throw new FileExtractionSourceError(check.code === 'file_unreadable' ? 'source_unavailable' : 'source_version_gone');
    let reader;
    try {
      reader = root.openFile(file.relPath, { expected: file.version });
    } catch {
      throw new FileExtractionSourceError('source_version_gone');
    }
    try {
      let span;
      try {
        span = new MboxSplitter(reader, { start: where.offset, maxMessageBytes: MBOX_DEFAULT_MAX_MESSAGE_BYTES }).next();
      } catch (error) {
        if (error instanceof MboxFormatError) throw new FileExtractionSourceError('source_version_gone');
        throw error;
      }
      if (!span) throw new FileExtractionSourceError('source_version_gone');
      // A message over the splitter's bound is not held in memory: its parts keep their names only.
      if (!span.raw) throw new FileExtractionSourceError('source_too_large');
      let part;
      try {
        part = mimePartBytes(span.raw, where.partId, input.maxBytes);
      } catch (error) {
        if (error instanceof MimePartTooLargeError) throw new FileExtractionSourceError('source_too_large');
        throw error;
      }
      if (!part) throw new FileExtractionSourceError('source_version_gone');
      // Asked again: the read may have waited behind a removal.
      if (!importServesSource(input.state, where.archiveId, input.sourceId)) throw new FileExtractionSourceError('source_item_not_found');
      return part;
    } finally {
      reader.close();
    }
  } finally {
    root.close();
  }
}
