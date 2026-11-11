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
