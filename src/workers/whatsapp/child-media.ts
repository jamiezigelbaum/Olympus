// Reading the bytes of a WhatsApp child item by its locator: a picture or
// video the bridge saved (`whatsapp-media-file:v1:<path>`, read only from the
// account's media folders), or a file an imported export carries
// (archive-import/input-media.ts). One reader for both, so the connector's
// `fetchItem` and the extraction source read children the same way.

import { readFileSync, realpathSync, statSync } from 'node:fs';
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
    let real: string;
    try {
      real = realpathSync(relocate(path));
    } catch {
      throw new FileExtractionSourceError('source_item_not_found');
    }
    const inside = options.mediaRoots.some((root) => {
      let base: string;
      try {
        base = realpathSync(resolve(root));
      } catch {
        return false;
      }
      const from = relative(base, real);
      return from !== '' && !from.startsWith('..') && !isAbsolute(from);
    });
    if (!inside) throw new FileExtractionSourceError('source_permission_denied');
    const stats = statSync(real);
    if (!stats.isFile()) throw new FileExtractionSourceError('source_content_unavailable');
    if (stats.size > maxBytes) throw new FileExtractionSourceError('source_too_large');
    return readFileSync(real);
  };
}
