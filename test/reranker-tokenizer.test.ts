import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonPairTokenizer } from '../src/workers/source-index/built-in-embedding/json-tokenizer.ts';
import { WordPieceTokenizer } from '../src/workers/source-index/built-in-embedding/wordpiece.ts';
import { CharsmapNormalizer } from '../src/workers/source-index/built-in-embedding/precompiled-charsmap.ts';
import { truncatePair } from '../src/workers/source-index/built-in-embedding/pair-tokenizer.ts';
import unigramReference from './fixtures/reranker/unigram-reference.json';
import bpeReference from './fixtures/reranker/bpe-reference.json';
import mmarcoReference from './fixtures/reranker/mmarco-reference.json';
import hsReference from './fixtures/reranker/hs-reference.json';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/reranker', name), 'utf8');

function parity(name: string, path: string | undefined, reference: typeof unigramReference) {
  describe(name, () => {
    if (!path) {
      test.skip('set the local tokenizer path to compare the pinned file with Python', () => {});
      return;
    }
    const json = readFileSync(path, 'utf8');
    const tokenizer = new JsonPairTokenizer(json);
    test('uses the exact tokenizer file the Python reference was generated from', () => {
      expect(createHash('sha256').update(json).digest('hex')).toBe(reference.tokenizerSha256);
    });
    for (const { name, first, second, maxLength, ids, typeIds, truncated } of reference.cases) {
      test(name, () => {
        expect(tokenizer.encodePair(first, second, maxLength)).toEqual({ ids, typeIds, truncated });
      });
    }
  });
}

parity('synthetic Unigram, precompiled map + NFKC + Metaspace + XLM-R pair', join(import.meta.dir, 'fixtures/reranker/unigram.json'), unigramReference);
parity('synthetic ranked BPE with the same normalization and pair template', join(import.meta.dir, 'fixtures/reranker/bpe.json'), bpeReference);
// Use test-only names: the safety preload intentionally clears OLYMPUS_*.
parity('pinned mmarco XLM-R Unigram', process.env.RERANKER_TEST_MMARCO_TOKENIZER_JSON, mmarcoReference);
parity('pinned hs-rerank-1 Gemma BPE', process.env.RERANKER_TEST_BPE_TOKENIZER_JSON, hsReference);

describe('tokenizer configuration and pair boundaries', () => {
  test('reads the supplied character map instead of substituting generic NFKC', () => {
    const data = JSON.parse(fixture('unigram.json'));
    const normalizer = new CharsmapNormalizer(data.normalizer.normalizers[0].precompiled_charsmap);
    expect(normalizer.normalize('X\u200bＡ e\u0301')).toBe('xA é');
    expect(normalizer.normalize('東京 🫠')).toBe('東京 🫠');
  });

  test('rejects invalid map headers and tokenizer types', () => {
    for (const map of ['', 'AAAAAA==', 'BAAAAA==']) {
      expect(() => new CharsmapNormalizer(map)).toThrow('Invalid precompiled');
    }
    const data = JSON.parse(fixture('unigram.json'));
    expect(() => new JsonPairTokenizer(JSON.stringify({ ...data, model: { type: 'Unsupported' } }))).toThrow('Unigram or BPE');
    expect(() => new JsonPairTokenizer(JSON.stringify({ ...data, post_processor: null }))).toThrow('post_processor');
  });

  test('uses the declared padding id and post_processor segment ids', () => {
    const data = JSON.parse(fixture('bpe.json'));
    data.padding = { pad_id: 42 };
    data.post_processor.pair = [
      { SpecialToken: { id: '<s>', type_id: 2 } },
      { Sequence: { id: 'B', type_id: 3 } },
      { SpecialToken: { id: '</s>', type_id: 3 } },
      { Sequence: { id: 'A', type_id: 4 } },
      { SpecialToken: { id: '</s>', type_id: 4 } },
    ];
    const tokenizer = new JsonPairTokenizer(JSON.stringify(data));
    expect(tokenizer.padId).toBe(42);
    expect(tokenizer.encodePair('hello', 'invoice', 5)).toEqual({
      ids: [0, data.model.vocab['▁invoice'], 2, data.model.vocab['▁hello'], 2],
      typeIds: [2, 3, 3, 4, 4], truncated: false,
    });
  });

  test('counts all four XLM-R specials, including on an empty pair', () => {
    const tokenizer = new JsonPairTokenizer(fixture('unigram.json'));
    expect(tokenizer.encodePair('hello', 'world', 4)).toEqual({ ids: [0, 2, 2, 2], typeIds: [0, 0, 0, 0], truncated: true });
    expect(tokenizer.encodePair('', '', 4)).toEqual({ ids: [0, 2, 2, 2], typeIds: [0, 0, 0, 0], truncated: false });
    expect(() => tokenizer.encodePair('hello', 'world', 3)).toThrow('pair template');
  });

  test('longest-first truncation preserves WordPiece ties and matches Python ties for JSON', () => {
    expect(truncatePair([1, 2, 3], [4, 5, 6], 3)).toMatchObject({ a: [1, 2], b: [4] });
    expect(truncatePair([1, 2, 3], [4, 5, 6], 3, 'huggingface')).toMatchObject({ a: [1], b: [4, 5] });
    expect(truncatePair([1, 2, 3, 4], [5, 6, 7], 3, 'huggingface')).toMatchObject({ a: [1, 2], b: [5] });
  });

  test('WordPiece normalization, subwords, pair specials and truncation stay unchanged', () => {
    const tokenizer = new WordPieceTokenizer('[PAD]\n[UNK]\n[CLS]\n[SEP]\ncafe\ninvoice\n##s\n,\ntotal\n?\n你\n好\na\nb');
    expect(tokenizer.tokenize('Café invoices, total? 你好')).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(tokenizer.encodePair('Café invoices', '你好', 16)).toEqual({
      ids: [2, 4, 5, 6, 3, 10, 11, 3], typeIds: [0, 0, 0, 0, 0, 1, 1, 1], truncated: false,
    });
    expect(tokenizer.encodePair('a a a', 'b b b', 6)).toEqual({
      ids: [2, 12, 12, 3, 13, 3], typeIds: [0, 0, 0, 0, 1, 1], truncated: true,
    });
  });
});
