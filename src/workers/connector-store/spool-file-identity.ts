/**
 * Which file a capture spool's file is: the identity a cursor or an index
 * binds to, so a file removed and put back (a spool folder deleted and
 * capture started again, a file restored from elsewhere) is never taken for
 * the one that was read.
 *
 * The identity is the file's device and inode, its birth time where the
 * platform keeps one, and a digest of its first line (at most 4 KiB) for the
 * platforms that reuse an inode at once and keep no birth time. It stays the
 * same while the file is only appended to: the first line never changes, and
 * the time of the last change is left out because every append changes it.
 * One case changes it in place: clearing a Secret from the first line
 * rewrites that line. A reader that meets a changed identity treats the file
 * as new, which costs one read of it again, and is safe wherever records are
 * applied under the intake rule. The digest is hashed, never kept as text.
 *
 * Nothing here names a source.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** How much of a file's start its identity fingerprints. */
export const SPOOL_IDENTITY_HEAD_BYTES = 4 * 1024;
const NEWLINE = 0x0a;

export interface SpoolFileIdentity {
  /** `<device>:<inode>:<birth ms or 0>:<first-line digest>`. */
  identity: string;
  size: number;
  ino?: number;
}

/** The file's identity and size, or undefined when it is not there. */
export function spoolFileIdentity(path: string): SpoolFileIdentity | undefined {
  try {
    const stats = statSync(path);
    const birth = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs) : 0;
    return {
      size: stats.size,
      ...(stats.ino > 0 ? { ino: stats.ino } : {}),
      identity: `${stats.dev}:${stats.ino}:${birth}:${firstLineDigest(path)}`,
    };
  } catch {
    return undefined;
  }
}

/** Whether the file at `path` is still the one whose identity was recorded. */
export function sameSpoolFile(recorded: string, path: string): boolean {
  return spoolFileIdentity(path)?.identity === recorded;
}

function firstLineDigest(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '-';
  }
  try {
    const head = Buffer.alloc(SPOOL_IDENTITY_HEAD_BYTES);
    const read = readSync(fd, head, 0, SPOOL_IDENTITY_HEAD_BYTES, 0);
    const newline = head.subarray(0, read).indexOf(NEWLINE);
    // Only a whole first line: a file still being written has none yet, and its fragment would change.
    if (newline < 0 && read < SPOOL_IDENTITY_HEAD_BYTES) return 'none';
    return createHash('sha256').update(head.subarray(0, newline < 0 ? read : newline + 1)).digest('hex').slice(0, 16);
  } finally {
    closeSync(fd);
  }
}
