/** First 256 float32 dimensions, L2-normalized, signed int8 + LE float32 scale. */
export function encodeVectorDigest(vector: ArrayLike<number>): Uint8Array {
  const size = Math.min(256, vector.length);
  const bytes = new Uint8Array(size + 4);
  let norm = 0;
  let max = 0;
  for (let i = 0; i < size; i++) {
    const value = Number.isFinite(vector[i]) ? vector[i]! : 0;
    norm += value * value;
    max = Math.max(max, Math.abs(value));
  }
  const scale = norm > 0 ? max / Math.sqrt(norm) / 127 : 0;
  new DataView(bytes.buffer).setFloat32(0, scale, true);
  const signed = new Int8Array(bytes.buffer, 4);
  for (let i = 0; i < size; i++) signed[i] = max > 0 ? Math.round((vector[i] || 0) / max * 127) : 0;
  return bytes;
}

/** Dot product of the two normalized, quantized vectors; no float array copies. */
export function scoreVectorDigest(query: Uint8Array, document: Uint8Array): number {
  if (query.length !== document.length || query.length < 4) return -Infinity;
  const q = new Int8Array(query.buffer, query.byteOffset + 4, query.length - 4);
  const d = new Int8Array(document.buffer, document.byteOffset + 4, document.length - 4);
  let dot = 0;
  for (let i = 0; i < q.length; i++) dot += q[i]! * d[i]!;
  return dot * new DataView(query.buffer, query.byteOffset, 4).getFloat32(0, true)
    * new DataView(document.buffer, document.byteOffset, 4).getFloat32(0, true);
}

/** Parallel numeric arrays avoid one object per vector and a full O(N log N) sort. */
export class VectorDigestHeap {
  private readonly pks: number[] = [];
  private readonly scores: number[] = [];
  get length(): number { return this.pks.length; }
  append(pk: number, score: number): void { this.pks.push(pk); this.scores.push(score); }
  private better(a: number, b: number): boolean {
    return this.scores[a]! > this.scores[b]!
      || (this.scores[a] === this.scores[b] && this.pks[a]! < this.pks[b]!);
  }
  private swap(a: number, b: number): void {
    [this.pks[a], this.pks[b]] = [this.pks[b]!, this.pks[a]!];
    [this.scores[a], this.scores[b]] = [this.scores[b]!, this.scores[a]!];
  }
  siftDown(index: number): void {
    while (2 * index + 1 < this.length) {
      let child = 2 * index + 1;
      if (child + 1 < this.length && this.better(child + 1, child)) child++;
      if (!this.better(child, index)) return;
      this.swap(index, child);
      index = child;
    }
  }
  pop(): number {
    const pk = this.pks[0]!;
    const last = this.length - 1;
    this.swap(0, last);
    this.pks.pop(); this.scores.pop();
    if (this.length) this.siftDown(0);
    return pk;
  }
}
