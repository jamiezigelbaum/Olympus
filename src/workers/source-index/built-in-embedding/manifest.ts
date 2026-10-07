// The pinned bill of materials for the built-in embedding models: the model
// weights and tokenizer at an exact upstream revision, and the ONNX Runtime
// native binding that runs them. Every byte Olympus downloads for this lane is
// named here with its size and digest; nothing is fetched by "latest".
//
// Changing a model (id, revision, file, pooling, prefixes, dimension) changes
// what every stored built-in vector means. That is an owner-gated re-embed, not
// an edit: add a new spec with a new `modelId` instead of mutating one. A spec
// stays listed in BUILT_IN_EMBEDDING_MODELS for as long as an install may still
// hold vectors under its id; BUILT_IN_EMBEDDING_MODEL is the one new installs get.

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
  /** Runs on ONNX Runtime (the default) or Google's LiteRT-LM. */
  runtime?: 'onnx' | 'litert';
  /**
   * Tokens per model window, including the special tokens around it. A LiteRT
   * model reads a longer input as several windows and averages them itself.
   */
  maxTokens: number;
  /** `cls`/`mean` pool the `last_hidden_state` output here; `model` is pooled by the runtime. */
  pooling: 'cls' | 'mean' | 'model';
  queryPrefix: string;
  /**
   * Put before a document's text. A prefix containing `{title}` carries the
   * title itself (`none` when there is none); otherwise a title is its own
   * first line after the prefix.
   */
  documentPrefix: string;
  model: PinnedDownload;
  /** The WordPiece `vocab.txt` an ONNX model reads; a LiteRT model carries its own tokenizer. */
  vocabulary?: PinnedDownload;
  /**
   * A LiteRT model that also reads images: the vision encoder is enabled and
   * a document may carry a picture beside its text. Turning the encoder on
   * leaves text vectors unchanged (cosine 1.000000 CPU, 0.999998 GPU, M3), so
   * this is deliberately NOT part of the model's identity (configHash).
   */
  vision?: {
    /** Image tokens per picture; LiteRT-LM 0.18.0 supports 70 or 140. */
    tokensPerImage: 70 | 140;
  };
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
 * The new-install default from 2026-10-01 to EmbeddingGemma 2; installs that
 * embedded with it keep it until their owner approves the re-embed.
 */
export const ARCTIC_EMBED_M_V1_5: BuiltInEmbeddingModelSpec = {
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

// EmbeddingGemma 2 (Google DeepMind, released 2026-10-06, Apache-2.0): a
// 740M-parameter multimodal embedder built on Gemma 4 (text, images, audio in
// one 768-dimension space; 8K-token context). This is Google's own LiteRT
// build: quantization-aware int4 text, int8 vision and mixed audio encoders in
// one `.litertlm` file with its tokenizer, run by LiteRT-LM (LITERT_RUNTIME_PACK).
// The ONNX conversion was measured and set aside on 2026-10-07: it embeds text
// only here, and this build carries the media encoders and decoders.
// Inputs up to 2,048 tokens run in one pass; LiteRT averages longer ones over
// several.
// Its identity (configHash) includes the LiteRT-LM version: a runtime bump,
// even a patch, can change the vectors, so it is an owner-approved re-embed
// like any other model change.
const EMBEDDINGGEMMA_2_REVISION = '24d962e906c7d332c6428e71c9676855024569e2';
const EMBEDDINGGEMMA_2_BASE = `https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/${EMBEDDINGGEMMA_2_REVISION}`;

/** EmbeddingGemma 2 on LiteRT-LM. */
export const EMBEDDINGGEMMA_2: BuiltInEmbeddingModelSpec = {
  modelId: 'embeddinggemma-2-litert-24d962e',
  repository: 'litert-community/embeddinggemma-2-740m-litert-lm',
  revision: EMBEDDINGGEMMA_2_REVISION,
  license: 'Apache-2.0',
  runtime: 'litert',
  dimension: 768,
  maxTokens: 2_048,
  pooling: 'model',
  queryPrefix: 'task: search result | query: ',
  documentPrefix: 'title: {title} | text: ',
  vision: { tokensPerImage: 140 },
  model: {
    name: 'embeddinggemma-2-740m.litertlm',
    url: `${EMBEDDINGGEMMA_2_BASE}/embeddinggemma-2-740m.litertlm`,
    bytes: 484_622_336,
    sha256: 'e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c',
  },
};

/** The model new installs embed with. */
export const BUILT_IN_EMBEDDING_MODEL: BuiltInEmbeddingModelSpec = EMBEDDINGGEMMA_2;

/**
 * The model an install configured only by environment
 * (`OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER=built-in`, no model named) runs.
 * It stays Arctic, the model that setting has meant since 2026-10-01: moving
 * it would re-embed such an install on upgrade, without the owner's approval
 * (see embedding-ledger.ts). Naming the model opts in to EmbeddingGemma 2.
 */
export const BUILT_IN_EMBEDDING_ENV_DEFAULT_MODEL: BuiltInEmbeddingModelSpec = ARCTIC_EMBED_M_V1_5;

/** Every model this build can load: the default, and older defaults installs may still hold vectors under. */
export const BUILT_IN_EMBEDDING_MODELS: readonly BuiltInEmbeddingModelSpec[] = [EMBEDDINGGEMMA_2, ARCTIC_EMBED_M_V1_5];

export function builtInEmbeddingModel(modelId: string): BuiltInEmbeddingModelSpec | undefined {
  return BUILT_IN_EMBEDDING_MODELS.find((model) => model.modelId === modelId);
}

/** Every file a model downloads, in install order. */
export function builtInEmbeddingModelFiles(model: BuiltInEmbeddingModelSpec): PinnedDownload[] {
  return [model.model, ...(model.vocabulary ? [model.vocabulary] : [])];
}

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

/** A LiteRT-LM release: one self-contained native library per platform, taken from Google's PyPI wheel. */
export interface LiteRtRuntimePackSpec {
  version: string;
  /** Keyed by `${process.platform}-${process.arch}`. */
  platforms: Readonly<Record<string, PinnedDownload & { library: string }>>;
}

const LITERT_WHEELS = 'https://files.pythonhosted.org/packages';

/**
 * LiteRT-LM 0.18.0 (Apache-2.0), from the `litert-lm-api` wheels. Each wheel
 * holds one library with the GPU accelerator linked in (WebGPU over Metal on
 * macOS, Vulkan on Linux); a machine without a usable GPU runs it on the CPU.
 */
export const LITERT_RUNTIME_PACK: LiteRtRuntimePackSpec = {
  version: '0.18.0',
  platforms: {
    'darwin-arm64': {
      name: 'litert_lm_api-0.18.0-py3-none-macosx_12_0_arm64.whl',
      url: `${LITERT_WHEELS}/cc/df/147e5fa60cf8964bdcbc022cbd38502f91ea415bf82bed2c9335fcf9be9d/litert_lm_api-0.18.0-py3-none-macosx_12_0_arm64.whl`,
      bytes: 21_430_649,
      sha256: '9fd0c55835e469a035c1b75cde4797b26292963c2c36d9fcdfceb965ffa08a37',
      library: 'litert_lm/liblitert-lm.dylib',
    },
    'linux-x64': {
      name: 'litert_lm_api-0.18.0-py3-none-manylinux_2_27_x86_64.whl',
      url: `${LITERT_WHEELS}/c9/8f/eb7a5203be1d48440c6b8d6e6382c3f744dd6d338fe400555718b4d695a1/litert_lm_api-0.18.0-py3-none-manylinux_2_27_x86_64.whl`,
      bytes: 47_051_760,
      sha256: 'b64e2cf6d7dcb90ff094b74af595cc5d53faa07e0889f967d15df8d3e696b53c',
      library: 'litert_lm/liblitert-lm.so',
    },
    'linux-arm64': {
      name: 'litert_lm_api-0.18.0-py3-none-manylinux_2_27_aarch64.whl',
      url: `${LITERT_WHEELS}/cf/f2/60707ac6860248e5f3601926c7cfe44794db350b60c1f14cb6e7e8874ae4/litert_lm_api-0.18.0-py3-none-manylinux_2_27_aarch64.whl`,
      bytes: 46_425_934,
      sha256: 'd066db0c2bcd832b2b9cf8532b5fff385f7cff8562a1b482f8da0b51f810c47c',
      library: 'litert_lm/liblitert-lm.so',
    },
  },
};
