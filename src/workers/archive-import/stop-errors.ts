/**
 * How a read that failed on one file of an archive becomes the import
 * stopping with a reason the person is told.
 *
 * Every shared reader and every format's connector reads through the
 * scope-safe range reader, which refuses a file that changed, went missing or
 * cannot be read. The import then stops and says which file and why, rather
 * than carry on with different bytes.
 */
import { ArchiveImportStoppedError } from '../../core/archive-formats.ts';
import { ScopeSafeError } from '../../core/scope-safe-fs.ts';
import { JsonStreamError } from './json-stream.ts';

/**
 * A scope error from reading one file of the archive, as the import stopping;
 * anything else is returned as it is.
 */
export function archiveStopFromScopeError(error: unknown, relPath: string): unknown {
  if (!(error instanceof ScopeSafeError)) return error;
  if (error.code === 'not_found') {
    return new ArchiveImportStoppedError('file_missing', 'A file of this archive is no longer there.', relPath);
  }
  if (error.code === 'changed' || error.code === 'escape' || error.code === 'not_regular') {
    return new ArchiveImportStoppedError('file_changed', 'A file of this archive changed since the import started.', relPath);
  }
  return new ArchiveImportStoppedError('file_unreadable', 'A file of this archive could not be read.', relPath);
}

/**
 * Any failure of a shared reader on one file, as the import stopping: a scope
 * error as above, and a JSON stream that was told to go on from a place that
 * is not in the file as the resume point not belonging to it. A JSON file that
 * is damaged or cut short could not be read to the end, so it is the file that
 * could not be read. A format that would rather report such a file as a gap
 * and go on catches the reader's own error first; anything else is returned
 * as it is.
 */
export function archiveStopFromReaderError(error: unknown, relPath: string): unknown {
  if (error instanceof JsonStreamError) {
    return error.code === 'resume_invalid'
      ? new ArchiveImportStoppedError('resume_point_invalid', 'Nothing starts where this import was to resume.', relPath)
      : new ArchiveImportStoppedError('file_unreadable', 'A file of this archive could not be read.', relPath);
  }
  return archiveStopFromScopeError(error, relPath);
}
