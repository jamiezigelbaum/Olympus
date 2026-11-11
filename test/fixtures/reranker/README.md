The `*-reference.json` files contain expected ids and segment ids generated
with Python `tokenizers==0.22.1`, right truncation with `longest_first`, no
padding, and special tokens enabled. Each records the input tokenizer's SHA-256.
They cover English, accents and decomposed Unicode, German compounds, CJK,
Cyrillic, character-map rules, unknown characters, empty pairs, truncation of
either side and both sides, and a 512-token window.

`unigram.json` and `bpe.json` are small synthetic tokenizers. Both use a genuine
SentencePiece precompiled map, NFKC, Metaspace, and the XLM-R pair template.
The map rewrites `X` to `x`, deletes U+200B, composes `e` + U+0301, and rewrites
fullwidth A. These deliberately differ from a generic NFKC approximation.
The BPE model has ranked merge rules; the Unigram model has competing scored
pieces. Normal tests always compare both against their Python reference.

The large upstream tokenizers are not in this repository. Optional tests read
only local files; they never download a model. Set either or both variables:

```sh
RERANKER_TEST_MMARCO_TOKENIZER_JSON=/tmp/mmarco/tokenizer.json \
RERANKER_TEST_BPE_TOKENIZER_JSON=/tmp/hs/tokenizer.json \
bun run test:focus test/reranker-tokenizer.test.ts
```

The test names intentionally lack the `OLYMPUS_` prefix: the test preload
clears runtime settings for isolation. When no path is supplied, that real-file
suite skips. With a supplied path, a missing file or wrong checksum fails.

Upstream reference inputs, from [#921](https://github.com/jamiezigelbaum/Olympus/issues/921#issuecomment-6802284190):

| Reference | Repository | Revision | SHA-256 |
| --- | --- | --- | --- |
| mmarco | cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 | 1427fd652930e4ba29e8149678df786c240d8825 | 62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626 |
| hs | hindsight-ai/hs-rerank-1 | 927f5be31280298a51cf29af8a29cb111ed812c5 | 609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f |

To regenerate expected ids, install the reference Python package in a venv
under `/tmp`, then run `regenerate.py <name> <tokenizer-path>`. For example:

```sh
python3 -m venv /tmp/reranker-reference
/tmp/reranker-reference/bin/pip install tokenizers==0.22.1
/tmp/reranker-reference/bin/python test/fixtures/reranker/regenerate.py \
  unigram test/fixtures/reranker/unigram.json
```

Use `bpe`, `mmarco`, or `hs` as the name for the other references. The script
keeps the fixed inputs and regenerates only expected encodings and their hash.
