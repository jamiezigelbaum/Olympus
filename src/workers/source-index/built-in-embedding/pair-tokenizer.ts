export interface TokenEncoding {
  ids: number[];
  /** True when the text had more tokens than fit and was cut. */
  truncated: boolean;
}

/** The pair encoding consumed by an ONNX cross-encoder. */
export interface PairEncoding extends TokenEncoding {
  /** Segment id per token, as declared by the model's pair template. */
  typeIds: number[];
}

export interface PairTokenizer {
  readonly padId: number;
  encodePair(first: string, second: string, maxLength: number): PairEncoding;
  /**
   * The same pair as one encoding per window of `second`, so a text longer
   * than the model's window is read whole. The first window is exactly
   * `encodePair`; a text that fits gives that one encoding.
   */
  encodePairWindows(first: string, second: string, maxLength: number, overlap: number): PairEncoding[];
}

/** Right truncation. WordPiece retains its B-first tie policy; JSON models
 * follow Python tokenizers (the originally longer side keeps an odd token). */
export function truncatePair<T>(
  a: T[], b: T[], room: number, tiePolicy: 'wordpiece' | 'huggingface' = 'wordpiece',
): { a: T[]; b: T[]; truncated: boolean } {
  let keepA = a.length;
  let keepB = b.length;
  room = Math.max(0, room);
  while (keepA + keepB > room) {
    if (keepB > keepA || (keepB === keepA && (tiePolicy === 'wordpiece' || a.length > b.length))) keepB -= 1;
    else keepA -= 1;
  }
  return { a: a.slice(0, keepA), b: b.slice(0, keepB), truncated: keepA < a.length || keepB < b.length };
}

/**
 * Every window of `b` beside the same (cut) `a`. The first window is what
 * `truncatePair` keeps; each next one starts `overlap` tokens before the last
 * one ended, and the final window ends at the end of `b`, so no window is a
 * short tail and no token of `b` goes unread.
 */
export function pairWindows<T>(
  a: T[], b: T[], room: number, overlap: number, tiePolicy: 'wordpiece' | 'huggingface' = 'wordpiece',
): { a: T[]; windows: T[][]; truncated: boolean } {
  const first = truncatePair(a, b, room, tiePolicy);
  const size = first.b.length;
  if (size === 0 || size >= b.length) return { a: first.a, windows: [first.b], truncated: first.truncated };
  const step = Math.max(1, size - Math.max(0, Math.min(Math.floor(overlap), size - 1)));
  const windows: T[][] = [];
  for (let start = 0; ; start += step) {
    if (start + size >= b.length) {
      windows.push(b.slice(b.length - size));
      break;
    }
    windows.push(b.slice(start, start + size));
  }
  return { a: first.a, windows, truncated: first.a.length < a.length };
}
