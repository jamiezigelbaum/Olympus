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
  /** Tokens per model window, including the special tokens around it. */
  maxTokens: number;
  /**
   * `cls`/`mean` pool the `last_hidden_state` output here; `model` takes the
   * graph's own pooled and projected `sentence_embedding` output.
   */
  pooling: 'cls' | 'mean' | 'model';
  queryPrefix: string;
  /**
   * Put before a document's text. A prefix containing `{title}` carries the
   * title itself (`none` when there is none); otherwise a title is its own
   * first line after the prefix.
   */
  documentPrefix: string;
  /** How `vocabulary` is read: a WordPiece `vocab.txt` (the default) or a SentencePiece `tokenizer.model`. */
  tokenizer?: 'wordpiece' | 'sentencepiece';
  model: PinnedDownload;
  /** The ONNX external-data file the model graph names, when its weights live outside it. */
  modelData?: PinnedDownload;
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

// EmbeddingGemma 2 (Google DeepMind, released 2026-10-06, Apache-2.0): the
// text path of a 740M-parameter multimodal embedder built on Gemma 4. 768
// dimensions (Matryoshka-trained down to 128), 8K-token context, Gemma's
// 262,144-piece SentencePiece tokenizer. The ONNX conversion's graph pools and
// projects to `sentence_embedding` itself. Windows are 2,048 tokens rather
// than the full 8K context: a document still reads as up to 8 windows (16K
// tokens), and a window that fits one padded batch keeps peak memory where
// MAX_BATCH_TOKENS puts it.
//
// The block between the PINNED markers is written by
// `bun scripts/pin-built-in-embedding.ts --write`, which resolves the
// revision and reads every file's size and SHA-256 from Hugging Face. Until it
// has run, the values read UNPINNED and test/built-in-embedding.test.ts fails,
// so this default cannot ship half-pinned.
// BEGIN PINNED embeddinggemma-2
const EMBEDDINGGEMMA_2_PIN = {
  modelId: 'embeddinggemma-2-onnx-UNPINNED',
  repository: 'onnx-community/embeddinggemma-2-ONNX',
  revision: 'UNPINNED',
  model: { name: 'model.onnx', path: 'onnx/model.onnx', bytes: 0, sha256: 'UNPINNED' },
  modelData: undefined as { name: string; path: string; bytes: number; sha256: string } | undefined,
  vocabulary: { name: 'tokenizer.model', path: 'tokenizer.model', bytes: 0, sha256: 'UNPINNED' },
};
// END PINNED embeddinggemma-2

function pinnedFile(
  repository: string,
  revision: string,
  file: { name: string; path: string; bytes: number; sha256: string },
): PinnedDownload {
  return {
    name: file.name,
    url: `https://huggingface.co/${repository}/resolve/${revision}/${file.path}`,
    bytes: file.bytes,
    sha256: file.sha256,
  };
}

/** EmbeddingGemma 2, ONNX text encoder. */
export const EMBEDDINGGEMMA_2: BuiltInEmbeddingModelSpec = {
  modelId: EMBEDDINGGEMMA_2_PIN.modelId,
  repository: EMBEDDINGGEMMA_2_PIN.repository,
  revision: EMBEDDINGGEMMA_2_PIN.revision,
  license: 'Apache-2.0',
  dimension: 768,
  maxTokens: 2_048,
  pooling: 'model',
  tokenizer: 'sentencepiece',
  queryPrefix: 'task: search result | query: ',
  documentPrefix: 'title: {title} | text: ',
  model: pinnedFile(EMBEDDINGGEMMA_2_PIN.repository, EMBEDDINGGEMMA_2_PIN.revision, EMBEDDINGGEMMA_2_PIN.model),
  ...(EMBEDDINGGEMMA_2_PIN.modelData
    ? { modelData: pinnedFile(EMBEDDINGGEMMA_2_PIN.repository, EMBEDDINGGEMMA_2_PIN.revision, EMBEDDINGGEMMA_2_PIN.modelData) }
    : {}),
  vocabulary: pinnedFile(EMBEDDINGGEMMA_2_PIN.repository, EMBEDDINGGEMMA_2_PIN.revision, EMBEDDINGGEMMA_2_PIN.vocabulary),
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
  return [model.model, ...(model.modelData ? [model.modelData] : []), model.vocabulary];
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
