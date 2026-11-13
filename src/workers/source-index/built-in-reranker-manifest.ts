// Pinned candidates from #921. The measured multilingual mMiniLMv2 int8 model
// is installed with the embedding model under <embedding root>/reranker/<modelId>.
// Its model.onnx and tokenizer.json total about 136 MB; scoring stays local.
import type { PinnedDownload } from './built-in-embedding/manifest.ts';

export interface BuiltInRerankerModelSpec {
  modelId: string;
  repository: string;
  revision: string;
  license: string;
  maxTokens: number;
  model: PinnedDownload;
  tokenizer: PinnedDownload;
}

function candidate(
  modelId: string, repository: string, revision: string,
  modelFile: string, modelBytes: number, modelSha256: string,
  tokenizerFile: string, tokenizerBytes: number, tokenizerSha256: string,
): BuiltInRerankerModelSpec {
  const base = `https://huggingface.co/${repository}/resolve/${revision}`;
  return {
    modelId, repository, revision, license: 'Apache-2.0', maxTokens: 512,
    model: { name: 'model.onnx', url: `${base}/${modelFile}`, bytes: modelBytes, sha256: modelSha256 },
    tokenizer: { name: tokenizerFile, url: `${base}/${tokenizerFile}`, bytes: tokenizerBytes, sha256: tokenizerSha256 },
  };
}

export const MS_MARCO_MINILM_L6_V2 = candidate(
  'ms-marco-MiniLM-L6-v2-fp32-233902d', 'cross-encoder/ms-marco-MiniLM-L6-v2',
  '233902d25c440f23af6f7d6e94d2946bac0bee0a', 'onnx/model.onnx', 91_011_230,
  '5d3e70fd0c9ff14b9b5169a51e957b7a9c74897afd0a35ce4bd318150c1d4d4a',
  'vocab.txt', 231_508, '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
);

// The arm64 and AVX512 int8 exports are byte-identical, and this file has
// also been verified on Sparta's AVX2-only x64 CPU. One pin for all platforms.
export const MMARCO_MMINILMV2_L12_H384_V1 = candidate(
  'mmarco-mMiniLMv2-L12-H384-v1-int8-1427fd6', 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
  '1427fd652930e4ba29e8149678df786c240d8825', 'onnx/model_qint8_arm64.onnx', 118_620_017,
  '1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4',
  'tokenizer.json', 17_082_660, '62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626',
);

export const BUILT_IN_RERANKER_MODELS: readonly BuiltInRerankerModelSpec[] = [
  MS_MARCO_MINILM_L6_V2, MMARCO_MMINILMV2_L12_H384_V1,
];
