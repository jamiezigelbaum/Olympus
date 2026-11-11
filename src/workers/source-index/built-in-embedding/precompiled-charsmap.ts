// SentencePiece's serialized Darts double-array trie. tokenizers.js 0.2.0's
// PrecompiledNormalizer uses a fixed NFKC approximation; interpreting the map
// preserves the pinned model's Unicode rules instead. Format and traversal:
// https://github.com/huggingface/spm_precompiled/blob/master/src/lib.rs
import { PrecompiledNormalizer } from '@huggingface/tokenizers';

export class CharsmapNormalizer extends PrecompiledNormalizer {
  private readonly trie: Uint32Array;
  private readonly replacements: Buffer;
  private readonly graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

  constructor(charsmap: string) {
    super({ type: 'Precompiled', precompiled_charsmap: charsmap });
    const data = Buffer.from(charsmap, 'base64');
    if (data.length < 8) throw new Error('Invalid precompiled character map.');
    const bytes = data.readUInt32LE(0);
    if (bytes < 4 || bytes % 4 || bytes + 4 >= data.length) throw new Error('Invalid precompiled character map.');
    this.trie = new Uint32Array(bytes / 4);
    for (let i = 0; i < this.trie.length; i += 1) this.trie[i] = data.readUInt32LE(4 + i * 4);
    this.replacements = data.subarray(4 + bytes);
  }

  private transform(text: string): string | undefined {
    const offset = (unit: number) => ((unit >>> 10) << ((unit & 0x200) >>> 6)) >>> 0;
    let node = offset(this.trie[0]!);
    for (const byte of Buffer.from(text, 'utf8')) {
      if (byte === 0) break;
      node = (node ^ byte) >>> 0;
      const unit = this.trie[node];
      if (unit === undefined || ((unit & 0x800000ff) >>> 0) !== byte) return undefined;
      node = (node ^ offset(unit)) >>> 0;
      if (unit & 0x100) {
        const leaf = this.trie[node];
        if (leaf === undefined) throw new Error('Invalid precompiled character map leaf.');
        const start = leaf & 0x7fffffff;
        const end = this.replacements.indexOf(0, start);
        if (end < 0) throw new Error('Invalid precompiled character map replacement.');
        return this.replacements.toString('utf8', start, end);
      }
    }
    return undefined;
  }

  override normalize(text: string): string {
    let result = '';
    // Match Python tokenizers/spm_precompiled: try a short grapheme first,
    // otherwise transform its individual Unicode scalars. NFKC, if present
    // as a separate normalizer in the file, is applied by the library.
    for (const { segment } of this.graphemes.segment(text)) {
      const mapped = Buffer.byteLength(segment) < 6 ? this.transform(segment) : undefined;
      result += mapped ?? Array.from(segment, (char) => this.transform(char) ?? char).join('');
    }
    return result;
  }
}
