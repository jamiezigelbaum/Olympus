/**
 * Telegram Desktop writes a control character in a message (a form feed, a
 * backspace, a stray escape code) as `\x` and two hex digits. That is not a
 * JSON escape (export_output_json.cpp `SerializeString`, in every release
 * since the JSON export began), so a strict JSON reader refuses the whole file
 * at the first such message, however far into a multi-gigabyte export it is.
 *
 * This wraps a byte source and rewrites each such escape, in place, into the
 * same number of bytes of plain spaces: a control character carries no text,
 * and keeping the length means every byte offset the reader reports (the
 * resume points in a cursor) is still an offset in the file.
 *
 * A backslash only starts an escape when an even number of backslashes have
 * not just cancelled it, so `\\x41` (a backslash, then the letters x41) is
 * left alone. The rewrite looks only at escapes, wherever they sit: outside a
 * string a backslash is not valid JSON in the first place.
 */
import type { ArchiveByteSource } from '../byte-source.ts';

const BACKSLASH = 0x5c;
const LOWER_X = 0x78;
const SPACE = 0x20;
/** `\`, `x`, and two hex digits. */
const ESCAPE_LENGTH = 4;

function isHex(byte: number | undefined): boolean {
  return byte !== undefined && ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66));
}

/**
 * The bytes of `source` with Telegram's `\xNN` escapes made into spaces.
 * Same length, same offsets. Starts outside any escape, which is where a
 * file's start and a resume point (just after an item) both are.
 */
export function telegramJsonSource(source: ArchiveByteSource): ArchiveByteSource {
  // Bytes of an escape that a chunk ended in the middle of, held until the next chunk.
  let carry: Uint8Array = new Uint8Array(0);
  let position = source.position;
  let last: Uint8Array = new Uint8Array(0);
  let held = 0;
  let pending: Uint8Array | undefined;
  let ended = false;

  const rewrite = (input: Uint8Array): { out: Uint8Array; hold: number } => {
    let out = input;
    let copied = false;
    let escaped = false;
    let hold = input.length;
    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
      if (escaped) {
        escaped = false;
        if (byte !== LOWER_X) continue;
        const first = input[index + 1];
        const second = input[index + 2];
        if (first === undefined || second === undefined) {
          // The chunk ends inside this escape (or on its backslash): the rest comes with the next one.
          hold = index - 1;
          break;
        }
        if (isHex(first) && isHex(second)) {
          if (!copied) {
            out = input.slice();
            copied = true;
          }
          out.fill(SPACE, index - 1, index - 1 + ESCAPE_LENGTH);
          index += 2;
        }
      } else if (byte === BACKSLASH) {
        escaped = true;
      }
    }
    // A backslash that ends the chunk may begin an escape the next chunk finishes.
    if (hold === input.length && escaped) hold = input.length - 1;
    return { out, hold };
  };

  return {
    get position(): number {
      return position;
    },
    next(): Uint8Array | undefined {
      if (pending) {
        const chunk = pending;
        pending = undefined;
        last = chunk;
        held = chunk.length;
        position += chunk.length;
        return chunk;
      }
      for (;;) {
        let input: Uint8Array;
        if (ended) {
          if (carry.length === 0) return undefined;
          // The file ended inside an escape: not valid JSON, whatever is done to it. Hand it on as it is.
          input = carry;
          carry = new Uint8Array(0);
          last = input;
          held = input.length;
          position += input.length;
          return input;
        }
        const chunk = source.next();
        if (chunk === undefined) {
          ended = true;
          continue;
        }
        if (carry.length > 0) {
          const joined = new Uint8Array(carry.length + chunk.length);
          joined.set(carry);
          joined.set(chunk, carry.length);
          input = joined;
        } else {
          input = chunk;
        }
        const { out, hold } = rewrite(input);
        carry = hold < input.length ? input.slice(hold) : new Uint8Array(0);
        const given = hold < input.length ? out.subarray(0, hold) : out;
        if (given.length === 0) continue;
        last = given;
        held = given.length;
        position += given.length;
        return given;
      }
    },
    unread(count: number): void {
      if (!Number.isInteger(count) || count < 0 || count > held) throw new RangeError('unread past the last chunk');
      if (count === 0) return;
      held -= count;
      position -= count;
      pending = last.subarray(held);
    },
  };
}
