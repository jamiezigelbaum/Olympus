/**
 * How a file on this computer opens: shared by every source whose files are
 * here (Dropbox's synced folder, the local files source). The caller resolves
 * the path from the engine's own records and names the folders it may be in;
 * nothing here knows which source that is.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { extname, sep } from 'node:path';

/**
 * File types macOS `open` hands to a viewer or editor: documents, images,
 * audio and video. Anything else (an app, a script, a `.command`, a
 * `.webloc`, a workflow…) would be run or acted on by LaunchServices, so it
 * is revealed in Finder instead (review P-2, 2026-10-02).
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents and text
  'pdf', 'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'epub',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'pages', 'numbers', 'key',
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'webp',
  // Audio and video
  'mp3', 'm4a', 'aac', 'wav', 'aiff', 'aif', 'flac', 'mp4', 'm4v', 'mov',
]);

/**
 * The `open` arguments for a source's local file, re-checked when it is
 * opened (not only when its token was minted): the path must still be a
 * regular file, not a symlink, with no symlink on the way (its real path is
 * itself), inside an approved folder on this computer. A document opens; any
 * other type is revealed in Finder (`-R`). Undefined: refuse.
 */
export function localOpenArguments(path: string, roots: readonly string[]): string[] | undefined {
  if (!path.startsWith('/') || path.includes('\0')) return undefined;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) return undefined;
    if (realpathSync.native(path) !== path) return undefined;
  } catch {
    return undefined;
  }
  if (!roots.some((root) => path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) return undefined;
  const extension = extname(path).slice(1).toLowerCase();
  return OPENABLE_EXTENSIONS.has(extension) ? [path] : ['-R', path];
}
