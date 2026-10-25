/**
 * The private folder where a source writes an item for a file reader
 * (`FileExtractionSource.fetchFile`). Source-neutral: nothing here names a
 * source, and the runner owns every file in it.
 *
 * Doc comments here are always multi-line blocks.
 */

import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file left in the spool this long is the leftover of a crash (a read
 * removes its own file when it ends), and is removed at start.
 */
export const EXTRACTION_SPOOL_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Creates the folder owner-only if it is not there, and removes stale files.
 * Never throws: a spool that cannot be prepared only means file readers get
 * bytes instead, as before.
 */
export function prepareExtractionSpool(dir: string, now: () => number = Date.now): string | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (now() - statSync(path).mtimeMs > EXTRACTION_SPOOL_STALE_MS) rmSync(path, { recursive: true, force: true });
      } catch {
        // Tried again at the next start.
      }
    }
    return dir;
  } catch {
    return undefined;
  }
}
