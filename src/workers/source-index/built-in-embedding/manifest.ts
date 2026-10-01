// The pinned bill of materials for the built-in embedding model: the model
// weights and vocabulary at an exact upstream revision, and the ONNX Runtime
// native binding that runs them. Every byte Olympus downloads for this lane is
// named here with its size and digest; nothing is fetched by "latest".
//
// Changing the model (id, revision, file, pooling, prefixes, dimension) changes
// what every stored built-in vector means. That is an owner-gated re-embed, not
// an edit: add a new spec with a new `modelId` instead of mutating this one.

export interface PinnedDownload {
  /** File name inside the asset directory. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface BuiltInEmbeddingModelSpec {
  /** The identity Olympus stores vectors under: model, revision and quantization. */
  modelId: string;
  /** Upstream repository and the exact commit the files are pinned at. */
  repository: string;
  revision: string;
  license: string;
  dimension: number;
  /** Model context, including [CLS] and [SEP]. */
  maxTokens: number;
  pooling: 'cls' | 'mean';
  queryPrefix: string;
  documentPrefix: string;
  model: PinnedDownload;
  vocabulary: PinnedDownload;
}

export interface PinnedNpmPackage {
  name: string;
  version: string;
  url: string;
  bytes: number;
  /** npm `dist.integrity`. */
  integrity: string;
}

export interface OnnxRuntimePackSpec {
  version: string;
  runtime: PinnedNpmPackage;
  common: PinnedNpmPackage;
  /** `${process.platform}-${process.arch}` values the runtime ships a binding for. */
  platforms: readonly string[];
}

const ARCTIC_M_REVISION = 'e58a8f756156a1293d763f17e3aae643474e9b8a';
const ARCTIC_M_BASE = `https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5/resolve/${ARCTIC_M_REVISION}`;

/**
 * Snowflake Arctic Embed M v1.5, int8-quantized ONNX (Apache-2.0).
 * 109M parameters, 768 dimensions, CLS pooling, 512-token context.
 */
export const BUILT_IN_EMBEDDING_MODEL: BuiltInEmbeddingModelSpec = {
  modelId: 'arctic-embed-m-v1.5-int8-e58a8f7',
  repository: 'Snowflake/snowflake-arctic-embed-m-v1.5',
  revision: ARCTIC_M_REVISION,
  license: 'Apache-2.0',
  dimension: 768,
  maxTokens: 512,
  pooling: 'cls',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
  model: {
    name: 'model_quantized.onnx',
    url: `${ARCTIC_M_BASE}/onnx/model_quantized.onnx`,
    bytes: 110_145_162,
    sha256: 'a18f437b2466863901a0bdc14904cf93246f5ecce0b656fc773bc2b7b2f84f6e',
  },
  vocabulary: {
    name: 'vocab.txt',
    url: `${ARCTIC_M_BASE}/vocab.txt`,
    bytes: 231_508,
    sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  },
};

export const ONNX_RUNTIME_PACK: OnnxRuntimePackSpec = {
  version: '1.30.0',
  runtime: {
    name: 'onnxruntime-node',
    version: '1.30.0',
    url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz',
    bytes: 113_507_888,
    integrity: 'sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==',
  },
  common: {
    name: 'onnxruntime-common',
    version: '1.30.0',
    url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.30.0.tgz',
    bytes: 66_795,
    integrity: 'sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==',
  },
  platforms: ['darwin-arm64', 'linux-x64', 'linux-arm64'],
};
