/**
 * Which keys the first record of a JSON list has, read past the probe's first
 * bytes when those did not reach them.
 *
 * Detection looks at the first ARCHIVE_PROBE_HEAD_BYTES of a file. A list whose
 * first record writes a long text before the keys that say what it is leaves
 * that look inconclusive, and a bigger look only moves the line. This reads on
 * through the shared JSON reader instead, to the end of the first record, and
 * keeps nothing but its key names:
 *
 * - Values are never built past a small bound: the reader is given
 *   RECORD_PROBE_MAX_VALUE_BYTES as the most it builds for one field, so a
 *   longer value is skipped in place and comes out as `oversize` with its path,
 *   and only the keys of the record are kept. The bound is also the longest
 *   run of digits or letters the reader accepts, so it is far above anything
 *   real. Memory is the keys (at most RECORD_PROBE_MAX_KEYS of them, each at
 *   most JSON_STREAM_MAX_KEY_CHARS long), one field of at most that bound, and
 *   one chunk of the source, however long the record is.
 * - Work: the reader feeds its tokenizer a slice at a time, so a pass is bounded
 *   to the first record and the first field of the record after it (what ends
 *   the first), never the list. Nothing here refuses a record for its size: the
 *   scan goes on to the end of the first record (or stops sooner when `enough`
 *   says the keys so far decide), and a scan that does not decide is a file
 *   that is not told by it, not one that is refused.
 * - Scope: the caller names the list by the keys from the document's root
 *   (`[]` is the root itself, `['items']` the list under a key), so this learns
 *   no format's shapes. A list whose first element is not a record has no keys.
 */
import {
  JSON_STREAM_ANY,
  JsonStreamError,
  JsonStreamReader,
  type JsonPathSegment,
} from './json-stream.ts';
import type { ArchiveByteSource } from './byte-source.ts';

/**
 * Key names kept from one record; a record with more is read on without keeping them.
 */
export const RECORD_PROBE_MAX_KEYS = 256;
/**
 * The most the reader builds of any one field; a longer one is skipped in place.
 */
export const RECORD_PROBE_MAX_VALUE_BYTES = 16 * 1024;
/**
 * The most bytes of one document the looks at it read in all (64 MiB). Reading
 * is in whole chunks, so the last chunk may run past it by up to one.
 */
export const RECORD_PROBE_MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * The most bytes the looks at all the files of one folder read in all (256 MiB),
 * on top of each document's own allowance. Reading is in whole chunks, so the
 * last may run past it by up to one.
 */
export const RECORD_PROBE_MAX_FOLDER_SCAN_BYTES = 256 * 1024 * 1024;

/**
 * What is left of a scan allowance. The looks at one document (its first
 * record's keys, whether its list is empty) draw on one of these, and on a
 * folder's too when the document is one of a folder's files.
 */
export interface RecordProbeBudget {
  left: number;
  /**
   * A read was refused because this allowance was spent while the document
   * still had more to read. Set by the looks, read by whoever must say that
   * something was not looked through.
   */
  ranOut?: boolean;
}

export function recordProbeBudget(bytes: number = RECORD_PROBE_MAX_SCAN_BYTES): RecordProbeBudget {
  return { left: bytes };
}

interface CappedSource {
  source: ArchiveByteSource;
  /**
   * The allowance ran out with more of the document still to read.
   */
  capped(): boolean;
}

function capped(inner: ArchiveByteSource, budgets: RecordProbeBudget | readonly RecordProbeBudget[]): CappedSource {
  const drawn = Array.isArray(budgets) ? (budgets as readonly RecordProbeBudget[]) : [budgets as RecordProbeBudget];
  let refused = false;
  return {
    source: {
      get position(): number {
        return inner.position;
      },
      next(): Uint8Array | undefined {
        const chunk = inner.next();
        if (chunk === undefined) return undefined;
        // The first allowance spent is the one refused against: a document's own comes before its folder's.
        const spent = drawn.find((budget) => budget.left <= 0);
        if (spent) {
          spent.ranOut = true;
          refused = true;
          return undefined;
        }
        for (const budget of drawn) budget.left -= chunk.length;
        return chunk;
      },
      unread: (count) => inner.unread(count),
    },
    capped: () => refused,
  };
}

/**
 * The keys of the first record of the list at `list` in a JSON document read
 * from its start, in the order they are written; undefined when the document
 * is not whole JSON, holds no such record, or is not read to the point that
 * says (the allowance ran out). `enough` is asked after each new key with the
 * keys so far: true ends the scan there.
 */
export function probeFirstRecordKeys(
  source: ArchiveByteSource,
  list: readonly string[],
  enough?: (keys: ReadonlySet<string>) => boolean,
  budget: RecordProbeBudget | readonly RecordProbeBudget[] = recordProbeBudget(),
): ReadonlySet<string> | undefined {
  const keys = new Set<string>();
  let found = false;
  const limited = capped(source, budget);
  try {
    // Every field of every record in the list: the first record's come first, and the second's fields end the scan.
    const reader = new JsonStreamReader(limited.source, { itemPaths: [[...list, JSON_STREAM_ANY]], maxItemBytes: RECORD_PROBE_MAX_VALUE_BYTES });
    for (;;) {
      const event = reader.next();
      if (!event) break;
      const record: JsonPathSegment | undefined = event.path[list.length];
      const key = event.path[list.length + 1];
      if (typeof record !== 'number' || typeof key !== 'string') continue;
      // The first record of a list is its element 0; anything later is the next record.
      if (record !== 0) break;
      found = true;
      if (keys.size < RECORD_PROBE_MAX_KEYS) keys.add(key);
      if (enough?.(keys)) break;
    }
  } catch (error) {
    // Not whole JSON, or the source gave out: the keys read so far are all there is, and only if the record was reached.
    if (!(error instanceof JsonStreamError)) throw error;
  }
  return found && !limited.capped() ? keys : undefined;
}

/**
 * Whether the value at `list` (a path of keys from the document's root, at
 * least one) is a list with nothing in it. False for anything else, for a
 * list too long to be empty, and for a document not read to the point that
 * says (the allowance ran out, or it is not whole JSON).
 */
export function probeListIsEmpty(
  source: ArchiveByteSource,
  list: readonly string[],
  budget: RecordProbeBudget | readonly RecordProbeBudget[] = recordProbeBudget(),
): boolean {
  if (list.length === 0) return false;
  const limited = capped(source, budget);
  try {
    // The values under the list's parent are the items; the one at `list` is handed out whole when it is small.
    const reader = new JsonStreamReader(limited.source, { itemPaths: [list.slice(0, -1)], maxItemBytes: RECORD_PROBE_MAX_VALUE_BYTES });
    for (;;) {
      const event = reader.next();
      if (!event) break;
      if (event.path.length === list.length && event.path.every((part, at) => part === list[at])) {
        return !limited.capped() && event.kind === 'item' && Array.isArray(event.value) && event.value.length === 0;
      }
    }
  } catch (error) {
    if (!(error instanceof JsonStreamError)) throw error;
  }
  return false;
}
