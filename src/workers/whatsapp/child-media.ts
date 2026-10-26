// Reading the bytes of a WhatsApp child item by its locator: a picture or
// video the bridge saved (`whatsapp-media-file:v1:<path>`, read only from the
// account's media folders), or a file an imported export carries
// (archive-import/input-media.ts). One reader for both, so the connector's
// `fetchItem` and the extraction source read children the same way.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { FileExtractionSourceError } from '../../core/file-extraction-source.ts';
import { parseArchiveInputMedia, readArchiveInputMedia, type ArchiveInputMediaDeps } from '../archive-import/input-media.ts';

export const WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX = 'whatsapp-media-file:v1:';
/** The most one read returns when the caller names no limit. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** The locator of a file the bridge saved: its path, which only this module reads. */
export function whatsAppMediaFileLocator(path: string): string {
  return `${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${path}`;
}

export type WhatsAppChildReader = (locator: string, options: { maxBytes?: number }) => Uint8Array;

/**
 * The reader of an account's children. A saved file is read only when it
 * really lives under one of `mediaRoots` (a spool line is data, and must
 * never be able to name another file); an export's file only while its
 * import serves it.
 */
export function createWhatsAppChildReader(options: {
  mediaRoots: readonly string[];
  /** Maps a path the bridge wrote under the account's old state folder to its account folder. */
  relocate?: (path: string) => string;
  /** The archive imports, when this engine has them (read at each call: they may open later). */
  archive?: () => ArchiveInputMediaDeps | undefined;
}): WhatsAppChildReader {
  const relocate = options.relocate ?? ((path: string) => path);
  return (locator, read) => {
    const maxBytes = read.maxBytes ?? DEFAULT_MAX_BYTES;
    if (parseArchiveInputMedia(locator)) {
      const deps = options.archive?.();
      if (!deps) throw new FileExtractionSourceError('source_item_not_found');
      return readArchiveInputMedia(locator, deps, { maxBytes });
    }
    if (!locator.startsWith(WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX)) throw new FileExtractionSourceError('source_item_not_found');
    const path = locator.slice(WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX.length);
    if (!isAbsolute(path)) throw new FileExtractionSourceError('source_permission_denied');
    // Opened once, never following a link at the end; the open file is then proved to be the real file inside an
    // approved folder (the same device and inode), and only that descriptor is read, within the bound. A path that
    // changes after the check changes nothing: what is read is what was checked.
    let fd: number;
    try {
      fd = openSync(relocate(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new FileExtractionSourceError('source_permission_denied');
      throw new FileExtractionSourceError('source_item_not_found');
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new FileExtractionSourceError('source_content_unavailable');
      let real: string;
      try {
        real = realpathSync(relocate(path));
      } catch {
        throw new FileExtractionSourceError('source_item_not_found');
      }
      const named = statSync(real);
      if (named.dev !== opened.dev || named.ino !== opened.ino || !insideAny(real, options.mediaRoots)) {
        throw new FileExtractionSourceError('source_permission_denied');
      }
      if (opened.size > maxBytes) throw new FileExtractionSourceError('source_too_large');
      return readBounded(fd, maxBytes);
    } finally {
      closeSync(fd);
    }
  };
}

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
