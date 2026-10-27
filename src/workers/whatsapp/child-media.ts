// Reading the bytes of a WhatsApp child item by its locator: a picture or
// video the bridge saved (`whatsapp-media-file:v1:<path>`, read only from the
// account's media folders), or a file an imported export carries
// (archive-import/input-media.ts). One reader for both, so the connector's
// `fetchItem` and the extraction source read children the same way.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { FileExtractionSourceError } from '../../core/file-extraction-source.ts';
import { copyArchiveInputMediaToFile, parseArchiveInputMedia, readArchiveInputMedia, writeFully, type ArchiveInputMediaDeps } from '../archive-import/input-media.ts';

export const WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX = 'whatsapp-media-file:v1:';
/** The most one read returns when the caller names no limit. */

/** The locator of a file the bridge saved: its path, which only this module reads. */
export function whatsAppMediaFileLocator(path: string): string {
  return `${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${path}`;
}

export interface WhatsAppChildReader {
  /** The child's bytes in memory, within the caller's bound. */
  (locator: string, options: { maxBytes?: number }): Uint8Array;
  /**
   * The child's bytes copied to `dest` (a new file, owner-only) in bounded
   * chunks, never held whole in memory: a long video is read this way. Returns
   * the number of bytes written.
   */
  toFile(locator: string, options: { maxBytes?: number }, dest: string): number;
}

/**
 * The reader of an account's children. A saved file is read only when it
 * really lives under one of `mediaRoots` (a spool line is data, and must
 * never be able to name another file); an export's file only while its
 * import serves it. Every piece of media is kept and read whole (owner,
 * 2026-10-26): a bound comes only from the caller.
 */
export function createWhatsAppChildReader(options: {
  mediaRoots: readonly string[];
  /** Maps a path the bridge wrote under the account's old state folder to its account folder. */
  relocate?: (path: string) => string;
  /** The archive imports, when this engine has them (read at each call: they may open later). */
  archive?: () => ArchiveInputMediaDeps | undefined;
}): WhatsAppChildReader {
  const relocate = options.relocate ?? ((path: string) => path);
  const archiveBytes = (locator: string, maxBytes: number | undefined): Uint8Array | undefined => {
    if (!parseArchiveInputMedia(locator)) return undefined;
    const deps = options.archive?.();
    if (!deps) throw new FileExtractionSourceError('source_item_not_found');
    return readArchiveInputMedia(locator, deps, maxBytes !== undefined ? { maxBytes } : {});
  };
  const savedPath = (locator: string): string => {
    if (!locator.startsWith(WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX)) throw new FileExtractionSourceError('source_item_not_found');
    const path = locator.slice(WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX.length);
    if (!isAbsolute(path)) throw new FileExtractionSourceError('source_permission_denied');
    return relocate(path);
  };
  const read = ((locator: string, bound: { maxBytes?: number }): Uint8Array => {
    const archived = archiveBytes(locator, bound.maxBytes);
    if (archived) return archived;
    return withConfinedFile(savedPath(locator), options.mediaRoots, bound.maxBytes, (fd, size) => readBounded(fd, size));
  }) as WhatsAppChildReader;
  read.toFile = (locator, bound, dest) => {
    if (parseArchiveInputMedia(locator)) {
      // An export's file, streamed by the archive reader: no cap but the caller's.
      const deps = options.archive?.();
      if (!deps) throw new FileExtractionSourceError('source_item_not_found');
      return copyArchiveInputMediaToFile(locator, deps, bound.maxBytes !== undefined ? { maxBytes: bound.maxBytes } : {}, dest);
    }
    return withConfinedFile(savedPath(locator), options.mediaRoots, bound.maxBytes, (fd, size) => copyBounded(fd, size, dest));
  };
  return read;
}

/**
 * Opens a saved file once, never following a link at the end, proves the open
 * file is the real file inside an approved folder (the same device and
 * inode), and hands only that descriptor on, with the size it may read: never
 * more than the file held when it was checked (a saved file is never appended
 * to), nor than the caller's bound. A path that changes after the check
 * changes nothing: what is read is what was checked. The same check serves
 * any media file the bridge saved, a voice note included.
 */
export function withConfinedFile<T>(path: string, roots: readonly string[], maxBytes: number | undefined, use: (fd: number, size: number) => T): T {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new FileExtractionSourceError('source_permission_denied');
    throw new FileExtractionSourceError('source_item_not_found');
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new FileExtractionSourceError('source_content_unavailable');
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new FileExtractionSourceError('source_item_not_found');
    }
    const named = statSync(real);
    if (named.dev !== opened.dev || named.ino !== opened.ino || !insideAny(real, roots)) {
      throw new FileExtractionSourceError('source_permission_denied');
    }
    if (maxBytes !== undefined && opened.size > maxBytes) throw new FileExtractionSourceError('source_too_large');
    return use(fd, Math.min(opened.size, maxBytes ?? opened.size));
  } finally {
    closeSync(fd);
  }
}

/** Copies up to `maxBytes` of an open file to a new file at `dest`, a chunk at a time; returns the bytes written. */
function copyBounded(fd: number, maxBytes: number, dest: string): number {
  const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, maxBytes + 1));
  let total = 0;
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new FileExtractionSourceError('source_too_large');
      writeFully(out, chunk.subarray(0, read));
    }
  } catch (error) {
    closeSync(out);
    rmSync(dest, { force: true });
    throw error;
  }
  closeSync(out);
  return total;
}

/** How much one step of a copy holds. */
const COPY_CHUNK_BYTES = 1024 * 1024;

function insideAny(real: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    let base: string;
    try {
      base = realpathSync(resolve(root));
    } catch {
      return false;
    }
    const from = relative(base, real);
    return from !== '' && !from.startsWith('..') && !isAbsolute(from);
  });
}

/** Up to `maxBytes` from an open file; a file that grew past the bound since it was checked is too large. */
function readBounded(fd: number, maxBytes: number): Uint8Array {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes + 1));
  for (;;) {
    const read = readSync(fd, chunk, 0, chunk.length, total);
    if (read === 0) break;
    total += read;
    if (total > maxBytes) throw new FileExtractionSourceError('source_too_large');
    chunks.push(Buffer.from(chunk.subarray(0, read)));
  }
  return Buffer.concat(chunks, total);
}
