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
