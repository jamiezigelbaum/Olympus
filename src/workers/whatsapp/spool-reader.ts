// Bounded, streaming reads of the WhatsApp capture spool.
//
// A spool file is read in fixed chunks from a byte offset, never whole, so
// memory stays bounded however large a day's file grows, and a record longer
// than the per-record bound is skipped (and counted) without being held. Byte
// offsets are stable: the bridge only appends, and clearing Secrets rewrites a
// record in place at its own length (connector-store/capture-spool-secrets.ts).
//
// The capture status receipt (capture-status.json beside the spool files) is
// the bridge's own word on whether it is connected and how many messages a
// full queue dropped (tools/whatsapp-bridge/capture_status.go).

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A spool record longer than this is skipped and counted, never parsed. */
export const WHATSAPP_SPOOL_MAX_RECORD_BYTES = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
/** How far back from the end of the spool the newest record is looked for. */
const NEWEST_RECORD_SCAN_BYTES = 4 * 1024 * 1024;
/** How much of a file's start its identity fingerprints. */
const HEAD_FINGERPRINT_BYTES = 4 * 1024;

export const WHATSAPP_CAPTURE_STATUS_FILE = 'capture-status.json';
const CAPTURE_STATUS_KIND = 'whatsapp_capture_status';
/** The receipt is a few hundred bytes; anything far larger is not the bridge's. */
const CAPTURE_STATUS_MAX_BYTES = 64 * 1024;

export type SpoolRecordRead =
  | { kind: 'line'; text: string; endOffset: number }
  /** A record over the per-record bound, skipped unread. `continued`: its start was skipped by an earlier pass, which counted it. */
  | { kind: 'oversized'; endOffset: number; continued?: true }
  /**
   * The read budget ran out. `offset` is where to go on: the start of the next
   * record, or, with `skipping`, a place inside an over-long record whose
   * rest is still to be skipped.
   */
  | { kind: 'paused'; offset: number; skipping?: true; firstSeen?: true };

/** `firstSeen`: the over-long record being skipped was found by this read, so this read counts it. */
function pauseAt(offset: number, skipping: boolean, continued: boolean): SpoolRecordRead {
  if (!skipping) return { kind: 'paused', offset };
  return continued ? { kind: 'paused', offset, skipping: true } : { kind: 'paused', offset, skipping: true, firstSeen: true };
}

/** How much one read may take; shared by every file a listing reads. */
export interface SpoolReadBudget {
  bytesLeft: number;
}

/**
 * The terminated records of one spool file from `startOffset`, each with the
 * offset just past its newline. A final fragment without a newline is a write
 * in progress and is not returned (one longer than the per-record bound is
 * skipped as it grows). A file that cannot be opened reads as empty (it
 * vanished between listing and reading).
 *
 * With a budget, every byte read is spent from it, and the read pauses once
 * it is spent: at the next record's start, or inside an over-long record
 * (which is never held, so a pause there loses nothing and the next read goes
 * on skipping it). A record within the bound is finished before a pause, so a
 * read takes at most its budget plus one record's bound.
 * `skipping` starts the read inside an over-long record an earlier read paused in.
 */
export function* spoolRecords(
  path: string,
  startOffset = 0,
  maxRecordBytes = WHATSAPP_SPOOL_MAX_RECORD_BYTES,
  budget?: SpoolReadBudget,
  skipping = false,
  chunkBytes = CHUNK_BYTES,
): Generator<SpoolRecordRead> {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return;
  }
  try {
    const size = Math.max(1, Math.min(CHUNK_BYTES, chunkBytes));
    const chunk = Buffer.allocUnsafe(size);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let oversized = skipping;
    let continued = skipping;
    let position = startOffset;
    for (;;) {
      // A pause between records, or inside one being skipped; never inside one being held.
      if (budget && budget.bytesLeft <= 0 && pendingBytes === 0) {
        yield pauseAt(position, oversized, continued);
        return;
      }
      const want = budget && oversized ? Math.max(1, Math.min(size, budget.bytesLeft)) : size;
      const read = readSync(fd, chunk, 0, want, position);
      if (read === 0) {
        // An over-long fragment at the end is never read again: the next read goes on past it.
        if (oversized) yield pauseAt(position, true, continued);
        return;
      }
      if (budget) budget.bytesLeft -= read;
      let cursor = 0;
      while (cursor < read) {
        const found = chunk.indexOf(NEWLINE, cursor);
        const end = found === -1 || found >= read ? -1 : found;
        const segment = chunk.subarray(cursor, end === -1 ? read : end);
        if (!oversized) {
          if (pendingBytes + segment.length > maxRecordBytes) {
            oversized = true;
            pending = [];
            pendingBytes = 0;
          } else if (end === -1 || pending.length > 0) {
            // The chunk buffer is reused, so a partial record is copied.
            pending.push(Buffer.from(segment));
            pendingBytes += segment.length;
          }
        }
        if (end === -1) break;
        const endOffset = position + end + 1;
        if (oversized) {
          yield continued ? { kind: 'oversized', endOffset, continued: true } : { kind: 'oversized', endOffset };
        } else {
          const bytes = pending.length > 0 ? Buffer.concat(pending, pendingBytes) : segment;
          const text = bytes.toString('utf8');
          yield { kind: 'line', text: text.endsWith('\r') ? text.slice(0, -1) : text, endOffset };
        }
        pending = [];
        pendingBytes = 0;
        oversized = false;
        continued = false;
        cursor = end + 1;
        // Spent between two records of one chunk: pause at the next one's start.
        if (budget && budget.bytesLeft <= 0 && cursor < read) {
          yield { kind: 'paused', offset: position + cursor };
          return;
        }
      }
      position += read;
    }
  } finally {
    closeSync(fd);
  }
}

/** The terminated lines of a spool file, oversized records left out. */
export function* spoolFileLines(path: string, startOffset = 0): Generator<string> {
  for (const record of spoolRecords(path, startOffset)) {
    if (record.kind === 'line') yield record.text;
  }
}

/**
 * The byte offset just past the first `lines` terminated lines of a file, or
 * undefined when the file holds fewer than that (it was replaced or cut
 * short since the count was taken). Counts newlines only: nothing is parsed.
 */
export function offsetAfterLines(path: string, lines: number): number | undefined {
  if (lines <= 0) return 0;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    let seen = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, CHUNK_BYTES, position);
      if (read === 0) return undefined;
      let cursor = 0;
      for (;;) {
        const found = chunk.indexOf(NEWLINE, cursor);
        if (found === -1 || found >= read) break;
        seen += 1;
        if (seen === lines) return position + found + 1;
        cursor = found + 1;
      }
      position += read;
    }
  } finally {
    closeSync(fd);
  }
}

/** Whether `offset` is the start of a record in this file: its start, or just past a newline. */
export function isRecordBoundary(path: string, offset: number): boolean {
  if (offset === 0) return true;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const byte = Buffer.alloc(1);
    return readSync(fd, byte, 0, 1, offset - 1) === 1 && byte[0] === NEWLINE;
  } finally {
    closeSync(fd);
  }
}

/**
 * A file's size and its identity: its device, inode and birth time where the
 * platform reports them, and a digest of its first line (at most 4 KiB), so
 * a file put in another's place is told apart even when the platform reuses
 * the inode and keeps no birth time. Only the first line is fingerprinted:
 * the bridge appends, so it never changes as the file grows, and the time of
 * the last change is left out for the same reason. Clearing a Secret from the
 * first line changes it, which reads as a replacement and costs one rebuild.
 * The digest is hashed, never kept as text. Undefined when the file is not there.
 */
export function spoolFileIdentity(path: string): { size: number; ino?: number; identity: string } | undefined {
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

function firstLineDigest(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '-';
  }
  try {
    const head = Buffer.alloc(HEAD_FINGERPRINT_BYTES);
    const read = readSync(fd, head, 0, HEAD_FINGERPRINT_BYTES, 0);
    const newline = head.subarray(0, read).indexOf(NEWLINE);
    // Only a whole first line: a file still being written has none yet, and its fragment would change.
    if (newline < 0 && read < HEAD_FINGERPRINT_BYTES) return 'none';
    return createHash('sha256').update(head.subarray(0, newline < 0 ? read : newline + 1)).digest('hex').slice(0, 16);
  } finally {
    closeSync(fd);
  }
}

/**
 * The newest record the spool holds, found by reading back from the end of
 * its last files, at most a few megabytes in all: the pull reads this on every
 * run, so it must never cost a pass over the whole spool. `pick` returns what
 * it wants from a line, or undefined to keep looking.
 */
export function newestSpoolRecord<T>(
  spoolDir: string,
  files: readonly string[],
  pick: (line: string) => T | undefined,
): T | undefined {
  let budget = NEWEST_RECORD_SCAN_BYTES;
  for (let index = files.length - 1; index >= 0 && budget > 0; index -= 1) {
    const path = join(spoolDir, files[index]!);
    const size = spoolFileIdentity(path)?.size ?? 0;
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      continue;
    }
    try {
      // Walk back chunk by chunk; `carry` is the start of the record that the
      // previous (later) chunk began in the middle of.
      let end = size;
      let carry = Buffer.alloc(0);
      let trailingFragment = true;
      while (end > 0 && budget > 0) {
        const length = Math.min(CHUNK_BYTES, end, budget);
        const start = end - length;
        const chunk = Buffer.allocUnsafe(length);
        const read = readSync(fd, chunk, 0, length, start);
        budget -= read;
        const window = Buffer.concat([chunk.subarray(0, read), carry]);
        const parts: Buffer[] = [];
        let cursor = window.length;
        for (let at = window.length - 1; at >= 0; at -= 1) {
          if (window[at] !== NEWLINE) continue;
          parts.push(window.subarray(at + 1, cursor));
          cursor = at;
        }
        // Whatever precedes the first newline in this window may continue in
        // the earlier chunk, unless this window starts the file.
        carry = Buffer.from(window.subarray(0, cursor));
        if (start === 0) parts.push(carry);
        for (const part of parts) {
          // The part after the file's last newline is a write in progress.
          if (trailingFragment) {
            trailingFragment = false;
            continue;
          }
          if (part.length > WHATSAPP_SPOOL_MAX_RECORD_BYTES) continue;
          const text = part.toString('utf8');
          const found = pick(text.endsWith('\r') ? text.slice(0, -1) : text);
          if (found !== undefined) return found;
        }
        if (carry.length > WHATSAPP_SPOOL_MAX_RECORD_BYTES) carry = Buffer.alloc(0);
        end = start;
      }
    } finally {
      closeSync(fd);
    }
  }
  return undefined;
}

export interface WhatsAppCaptureStatusReceipt {
  connected: boolean;
  /** When the bridge last wrote the receipt (ISO). */
  updatedAt?: string;
  /** The last time the bridge knew it was connected (ISO). */
  connectedThrough?: string;
  /** Messages a full spool queue dropped, over the life of the state folder. */
  droppedMessages: number;
  lastDroppedAt?: string;
}

/**
 * The bridge's capture status receipt, or undefined when there is none (an
 * older bridge, or capture never started) or it cannot be read. Only its
 * counts and times are read.
 */
export function readWhatsAppCaptureStatus(spoolDir: string): WhatsAppCaptureStatusReceipt | undefined {
  const path = join(spoolDir, WHATSAPP_CAPTURE_STATUS_FILE);
  let parsed: unknown;
  try {
    if (statSync(path).size > CAPTURE_STATUS_MAX_BYTES) return undefined;
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['kind'] !== CAPTURE_STATUS_KIND) return undefined;
  const dropped = record['dropped_messages'];
  const connectedThrough = isoTime(record['connected_through']);
  const lastDroppedAt = isoTime(record['last_dropped_at']);
  const updatedAt = isoTime(record['updated_at']);
  return {
    connected: record['connected'] === true,
    ...(updatedAt ? { updatedAt } : {}),
    droppedMessages: typeof dropped === 'number' && Number.isSafeInteger(dropped) && dropped > 0 ? dropped : 0,
    ...(connectedThrough ? { connectedThrough } : {}),
    ...(lastDroppedAt ? { lastDroppedAt } : {}),
  };
}

function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}
