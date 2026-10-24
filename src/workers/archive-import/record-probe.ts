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
 * The keys of the first record of the list at `list` in a JSON document read
 * from its start, in the order they are written; undefined when the document
 * is not whole JSON or holds no such record. `enough` is asked after each new
 * key with the keys so far: true ends the scan there.
 */
export function probeFirstRecordKeys(
  source: ArchiveByteSource,
  list: readonly string[],
  enough?: (keys: ReadonlySet<string>) => boolean,
): ReadonlySet<string> | undefined {
  const keys = new Set<string>();
  let found = false;
  try {
    // Every field of every record in the list: the first record's come first, and the second's fields end the scan.
    const reader = new JsonStreamReader(source, { itemPaths: [[...list, JSON_STREAM_ANY]], maxItemBytes: RECORD_PROBE_MAX_VALUE_BYTES });
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
  return found ? keys : undefined;
}
