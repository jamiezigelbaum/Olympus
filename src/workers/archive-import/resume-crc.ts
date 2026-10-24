/**
 * Keeping a zip member's checksum across a stop that lands part-way through a
 * record.
 *
 * A reader that stops at a record boundary gives the bytes it read past the
 * boundary back to the member (`unread`), which also puts the member's running
 * CRC-32 back there. That only reaches as far as the last chunk. A stop inside
 * a record longer than a chunk has read several chunks past the boundary, and
 * the take-back fails; a stored member entered at an offset with no checksum
 * for the bytes before it can never say its checksum matched, and a bad one
 * would pass for good. Two helpers close that, for any reader of any format:
 *
 * - `trackBoundaries` wraps the stream a reader pulls from and remembers, at
 *   each record boundary the reader tells it of, the chunk the boundary is in
 *   and the CRC-32 before that chunk, so the CRC at the boundary is one
 *   `crcAtBoundary()` away however many chunks were read after it. It holds
 *   references to chunks the stream handed out, copies nothing, and keeps only
 *   the latest boundary.
 * - `recoverZipMemberCrc` replays a member from its start to an offset and
 *   returns the CRC-32 there, for a resume point that carries none (written by
 *   an older pass, or lost). It reads the bytes once and holds one chunk.
 *
 * The caller treats a member whose end says `crcOk` other than true as damaged:
 * undefined means the read did not cover the whole member, which is never a pass.
 */
import { crc32Update, type ArchiveByteSource } from './byte-source.ts';
import { ZipFormatError, ZipMemberError, ZipMemberReader, type ZipArchive, type ZipEntry } from './zip-reader.ts';

export interface BoundaryTrackedSource extends ArchiveByteSource {
  /**
   * A record ends at `offset`, in this stream's own offsets. Call it when the
   * reader hands the record out: the offset is in the chunk read last, or the
   * boundary is forgotten (its CRC is then recovered by replaying).
   */
  markBoundary(offset: number): void;
  /**
   * The offset last marked, while it is still kept.
   */
  readonly boundary: number | undefined;
  /**
   * The CRC-32 of the stream's bytes before the offset last marked; undefined
   * when the stream keeps no CRC, or the boundary could not be kept.
   */
  crcAtBoundary(): number | undefined;
}

/**
 * `inner` as a stream that also remembers the CRC-32 at the last boundary
 * marked. `startCrc` is the CRC-32 of the bytes before the stream's first
 * byte, when the caller knows it (the stream was entered part-way, from a
 * resume point that carried it; 0 for a stream entered at its start): the
 * stream's own figure is not trusted before its first chunk, where a reader
 * that is still catching up to its start offset has not summed what it skipped.
 */
export function trackBoundaries(inner: ArchiveByteSource, startCrc?: number): BoundaryTrackedSource {
  let chunk: Uint8Array | undefined;
  let chunkStart = 0;
  let crcBeforeChunk: number | undefined;
  let first = true;
  let kept: { offset: number; crcBefore: number; prefix: Uint8Array } | undefined;
  return {
    get position(): number {
      return inner.position;
    },
    get crc32(): number | undefined {
      return inner.crc32;
    },
    get boundary(): number | undefined {
      return kept?.offset;
    },
    next(): Uint8Array | undefined {
      const crcBefore = first ? startCrc : inner.crc32;
      const pulled = inner.next();
      first = false;
      if (pulled) {
        chunk = pulled;
        chunkStart = inner.position - pulled.length;
        crcBeforeChunk = crcBefore;
      }
      return pulled;
    },
    unread(count: number): void {
      inner.unread(count);
      // What was given back is handed out again as the next chunk, from the new position.
      if (chunk && count > 0) chunk = chunk.subarray(0, Math.max(0, chunk.length - count));
    },
    markBoundary(offset: number): void {
      const within = offset - chunkStart;
      if (!chunk || crcBeforeChunk === undefined || within < 0 || within > chunk.length) {
        kept = undefined;
        return;
      }
      kept = { offset, crcBefore: crcBeforeChunk, prefix: chunk.subarray(0, within) };
    },
    crcAtBoundary(): number | undefined {
      return kept ? crc32Update(kept.crcBefore, kept.prefix) >>> 0 : undefined;
    },
  };
}

export type ZipCrcRecovery =
  | { kind: 'crc'; crc: number }
  /**
   * The member cannot be replayed to that offset (damaged, or shorter than the offset).
   */
  | { kind: 'unavailable' }
  /**
   * `shouldContinue` said to stop part-way.
   */
  | { kind: 'interrupted' };

/**
 * The CRC-32 of a zip member's bytes before `offset`, by reading it from its
 * start. `shouldContinue` is asked before each chunk.
 */
export function recoverZipMemberCrc(
  archive: ZipArchive,
  entry: ZipEntry,
  offset: number,
  shouldContinue: () => boolean,
): ZipCrcRecovery {
  if (offset === 0) return { kind: 'crc', crc: 0 };
  let reader: ZipMemberReader;
  try {
    reader = ZipMemberReader.open(archive, entry);
  } catch (error) {
    // Anything but a member that cannot be read (a changed file, say) is the caller's to see.
    if (error instanceof ZipMemberError || error instanceof ZipFormatError) return { kind: 'unavailable' };
    throw error;
  }
  try {
    for (;;) {
      if (!shouldContinue()) return { kind: 'interrupted' };
      const chunk = reader.next();
      if (!chunk) return { kind: 'unavailable' };
      if (reader.position >= offset) {
        reader.unread(reader.position - offset);
        const crc = reader.crc32;
        return crc === undefined ? { kind: 'unavailable' } : { kind: 'crc', crc };
      }
    }
  } catch (error) {
    if (error instanceof ZipMemberError || error instanceof ZipFormatError) return { kind: 'unavailable' };
    throw error;
  } finally {
    reader.close();
  }
}
