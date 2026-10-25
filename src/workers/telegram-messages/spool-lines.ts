// Reading the Telegram capture spool a line at a time, in bounded chunks.
//
// The spool's cursors are `<file>:<line count>` (capture-spool-secrets.ts
// relies on that shape), so a reader resuming at line N has to find where
// line N starts. Two facts make a remembered byte offset safe to reuse: the
// helper only appends (and trims a torn tail back to its last newline), and a
// Secrets rewrite keeps every record at its own byte length. So an offset
// once found for a line stays that line's offset while the file is the same
// file. Offsets are remembered in this process only; a cold start counts
// newlines once, in chunks, without holding the file.

import { readSync, type Stats } from 'node:fs';

const CHUNK_BYTES = 1 << 20;
const MAX_HINT_FILES = 64;
const MAX_HINTS_PER_FILE = 16;

export interface SpoolLine {
  /** The line's text, without its newline; absent when it was longer than the bound and so never held. */
  text: string | undefined;
  /** The byte offset just past the line's newline. */
  end: number;
}

/**
 * The complete lines of an open file from byte `start`, read only up to
 * `size` (the size the caller saw when it opened the file, so a record
 * appended meanwhile waits for the next read). A line longer than
 * `maxLineBytes` is yielded without its text, and none of it is held.
 */
export function* spoolFileLines(fd: number, start: number, size: number, maxLineBytes: number): Generator<SpoolLine> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = start;
  let parts: Buffer[] = [];
  let held = 0;
  let oversize = false;
  while (position < size) {
    const read = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
    if (read <= 0) break;
    let from = 0;
    while (from < read) {
      const found = buffer.indexOf(0x0a, from);
      const newline = found >= 0 && found < read ? found : -1;
      const stop = newline < 0 ? read : newline;
      if (!oversize) {
        if (held + (stop - from) > maxLineBytes) {
          oversize = true;
          parts = [];
          held = 0;
        } else if (stop > from) {
          parts.push(Buffer.from(buffer.subarray(from, stop)));
          held += stop - from;
        }
      }
      if (newline < 0) break;
      yield { text: oversize ? undefined : Buffer.concat(parts, held).toString('utf8'), end: position + newline + 1 };
      parts = [];
      held = 0;
      oversize = false;
      from = newline + 1;
    }
    position += read;
  }
}

interface OffsetHint {
  dev: number;
  ino: number;
  line: number;
  offset: number;
}

const hints = new Map<string, OffsetHint[]>();

/** Remember where line `line` of the file at `path` starts. */
export function rememberSpoolOffset(path: string, stat: Stats, line: number, offset: number): void {
  if (line <= 0) return;
  const list = (hints.get(path) ?? []).filter((hint) => hint.line !== line && hint.dev === stat.dev && hint.ino === stat.ino);
  list.push({ dev: stat.dev, ino: stat.ino, line, offset });
  list.sort((a, b) => a.line - b.line);
  while (list.length > MAX_HINTS_PER_FILE) list.shift();
  hints.delete(path);
  hints.set(path, list);
  while (hints.size > MAX_HINT_FILES) hints.delete(hints.keys().next().value!);
}

/** Forget every remembered offset (tests: a cold process). */
export function forgetSpoolOffsets(): void {
  hints.clear();
}

/**
 * The byte offset where line `line` (0-based) of an open file starts, or
 * undefined when the file holds fewer complete lines than that. Starts from
 * the nearest remembered offset at or before the line that still sits just
 * after a newline of this same file, and counts newlines from there.
 */
export function spoolLineOffset(fd: number, path: string, stat: Stats, line: number): number | undefined {
  if (line <= 0) return 0;
  let fromLine = 0;
  let fromOffset = 0;
  const byte = Buffer.alloc(1);
  for (const hint of hints.get(path) ?? []) {
    if (hint.line > line || hint.dev !== stat.dev || hint.ino !== stat.ino || hint.offset > stat.size) continue;
    if (hint.offset > 0 && (readSync(fd, byte, 0, 1, hint.offset - 1) !== 1 || byte[0] !== 0x0a)) continue;
    if (hint.line >= fromLine) {
      fromLine = hint.line;
      fromOffset = hint.offset;
    }
  }
  if (fromLine === line) return fromOffset;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = fromOffset;
  let counted = fromLine;
  while (position < stat.size) {
    const read = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, stat.size - position), position);
    if (read <= 0) break;
    let from = 0;
    for (;;) {
      const found = buffer.indexOf(0x0a, from);
      if (found < 0 || found >= read) break;
      counted += 1;
      if (counted === line) {
        const offset = position + found + 1;
        rememberSpoolOffset(path, stat, line, offset);
        return offset;
      }
      from = found + 1;
    }
    position += read;
  }
  return undefined;
}
