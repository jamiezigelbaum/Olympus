// Tokenizer-only, bundled pure JS; no transformers.js, native addon, network
// access, tokenizer_config.json or runtime model download is needed.
import { Tokenizer, PrecompiledNormalizer, SequenceNormalizer, type Normalizer } from '@huggingface/tokenizers';
import { CharsmapNormalizer } from './precompiled-charsmap.ts';
import { truncatePair, type PairEncoding, type PairTokenizer } from './pair-tokenizer.ts';

function exactCharsmaps(normalizer: Normalizer | null): Normalizer | null {
  if (normalizer instanceof PrecompiledNormalizer) return new CharsmapNormalizer(normalizer.charsmap);
  if (normalizer instanceof SequenceNormalizer) normalizer.normalizers = normalizer.normalizers.map(exactCharsmaps);
  return normalizer;
}

export class JsonPairTokenizer implements PairTokenizer {
  private readonly tokenizer: Tokenizer;
  private readonly specialCount: number;
  readonly padId: number;

  constructor(json: string) {
    const data = JSON.parse(json);
    if (data.model?.type !== 'Unigram' && data.model?.type !== 'BPE') {
      throw new Error('The reranker tokenizer.json must use Unigram or BPE.');
    }
    if (!data.post_processor) throw new Error('The reranker tokenizer.json needs a pair post_processor.');
    this.tokenizer = new Tokenizer(data, {});
    this.tokenizer.normalizer = exactCharsmaps(this.tokenizer.normalizer);
    const pad = data.padding?.pad_id
      ?? this.tokenizer.token_to_id('<pad>')
      ?? this.tokenizer.token_to_id('[PAD]');
    if (!Number.isSafeInteger(pad) || pad < 0) throw new Error('The reranker tokenizer.json is missing a padding token.');
    this.padId = pad;
    this.specialCount = this.postProcess([], []).ids.length;
  }

  private postProcess(a: string[], b: string[]): { ids: number[]; typeIds: number[] } {
    const output = this.tokenizer.post_processor!.post_process(a, b, true);
    const tokens = [...output.tokens, ...(output.tokens_pair ?? [])];
    const ids = tokens.map((token) => {
      const id = this.tokenizer.token_to_id(token) ?? this.tokenizer.model?.unk_token_id;
      if (id === undefined) throw new Error('The reranker pair template contains a token outside its vocabulary.');
      return id;
    });
    return { ids, typeIds: output.token_type_ids ?? ids.map(() => 0) };
  }

  encodePair(first: string, second: string, maxLength: number): PairEncoding {
    if (!Number.isSafeInteger(maxLength) || maxLength < this.specialCount) {
      throw new Error('The reranker token window cannot hold its pair template.');
    }
    const { a, b, truncated } = truncatePair(
      this.tokenizer.tokenize(first), this.tokenizer.tokenize(second), maxLength - this.specialCount, 'huggingface',
    );
    return { ...this.postProcess(a, b), truncated };
  }
}
