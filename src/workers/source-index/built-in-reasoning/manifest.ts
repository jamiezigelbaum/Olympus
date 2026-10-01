// The pinned bill of materials for Olympus's built-in private reasoning model:
// small instruction-tuned LLMs as 4-bit GGUF files at exact upstream
// revisions, and the official llama.cpp `llama-server` release that runs them.
// Every byte Olympus downloads for this lane is named here with its size and
// SHA-256; nothing is fetched by "latest".
//
// Sources (verified 2026-10-01 against the Hugging Face model cards and the
// GitHub release API; see docs/design/private-model-benchmark.md):
// - Qwen3.5 2B / 4B / 9B: Apache-2.0 (Qwen/Qwen3.5-*), released 2026-02-27/28.
//   GGUF quantizations from unsloth/Qwen3.5-*-GGUF (Apache-2.0, same license).
// - llama.cpp b11320: MIT (ggml-org/llama.cpp), released 2026-10-01.

export interface PinnedReasoningFile {
  /** File name inside the model directory. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export type BuiltInReasoningSizeClass = 'small' | 'standard' | 'large';

export interface BuiltInReasoningModelSpec {
  /** Stable identity: family, size, quantization and the upstream revision. */
  modelId: string;
  /** Short name people see: "Qwen3.5 4B". */
  displayName: string;
  sizeClass: BuiltInReasoningSizeClass;
  /** Upstream weights repository and license. */
  baseRepository: string;
  license: string;
  /** GGUF repository and the exact commit the file is pinned at. */
  repository: string;
  revision: string;
  file: PinnedReasoningFile;
  /** Physical memory the machine needs before this model is auto-picked. */
  minimumMemoryBytes: number;
  /** Context the server is started with (prompt plus answer). */
  contextTokens: number;
}

export interface PinnedRuntimeArchive {
  /** `${process.platform}-${process.arch}`. */
  platform: string;
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Whether the build offloads to the GPU (Metal on Apple silicon). */
  gpu: boolean;
}

export interface LlamaServerRuntimeSpec {
  /** llama.cpp release tag. */
  release: string;
  license: string;
  archives: readonly PinnedRuntimeArchive[];
}

const GIB = 1024 ** 3;

function unslothQwen(size: '2B' | '4B' | '9B', revision: string, bytes: number, sha256: string): PinnedReasoningFile {
  const name = `Qwen3.5-${size}-Q4_K_M.gguf`;
  return {
    name,
    url: `https://huggingface.co/unsloth/Qwen3.5-${size}-GGUF/resolve/${revision}/${name}`,
    bytes,
    sha256,
  };
}

const QWEN35_2B_REVISION = 'f6d5376be1edb4d416d56da11e5397a961aca8ae';
const QWEN35_4B_REVISION = 'e87f176479d0855a907a41277aca2f8ee7a09523';
const QWEN35_9B_REVISION = '3885219b6810b007914f3a7950a8d1b469d598a5';

/** Qwen3.5 2B, Q4_K_M: the 8 GB-Mac class. */
export const QWEN35_2B: BuiltInReasoningModelSpec = {
  modelId: 'qwen3.5-2b-q4_k_m-f6d5376',
  displayName: 'Qwen3.5 2B',
  sizeClass: 'small',
  baseRepository: 'Qwen/Qwen3.5-2B',
  license: 'Apache-2.0',
  repository: 'unsloth/Qwen3.5-2B-GGUF',
  revision: QWEN35_2B_REVISION,
  file: unslothQwen('2B', QWEN35_2B_REVISION, 1_280_835_840, 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223'),
  minimumMemoryBytes: 7 * GIB,
  contextTokens: 12_288,
};

/** Qwen3.5 4B, Q4_K_M: the default on 16 GB and larger Macs. */
export const QWEN35_4B: BuiltInReasoningModelSpec = {
  modelId: 'qwen3.5-4b-q4_k_m-e87f176',
  displayName: 'Qwen3.5 4B',
  sizeClass: 'standard',
  baseRepository: 'Qwen/Qwen3.5-4B',
  license: 'Apache-2.0',
  repository: 'unsloth/Qwen3.5-4B-GGUF',
  revision: QWEN35_4B_REVISION,
  file: unslothQwen('4B', QWEN35_4B_REVISION, 2_740_937_888, '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4'),
  minimumMemoryBytes: 15 * GIB,
  contextTokens: 12_288,
};

/** Qwen3.5 9B, Q4_K_M: the opt-in upgrade (OLYMPUS_BUILT_IN_ANALYST_MODEL=large). */
export const QWEN35_9B: BuiltInReasoningModelSpec = {
  modelId: 'qwen3.5-9b-q4_k_m-3885219',
  displayName: 'Qwen3.5 9B',
  sizeClass: 'large',
  baseRepository: 'Qwen/Qwen3.5-9B',
  license: 'Apache-2.0',
  repository: 'unsloth/Qwen3.5-9B-GGUF',
  revision: QWEN35_9B_REVISION,
  file: unslothQwen('9B', QWEN35_9B_REVISION, 5_680_522_464, '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'),
  minimumMemoryBytes: 15 * GIB,
  contextTokens: 12_288,
};

export const BUILT_IN_REASONING_MODELS: readonly BuiltInReasoningModelSpec[] = [QWEN35_2B, QWEN35_4B, QWEN35_9B];

const LLAMA_CPP_RELEASE = 'b11320';
const LLAMA_CPP_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE}`;

export const LLAMA_SERVER_RUNTIME: LlamaServerRuntimeSpec = {
  release: LLAMA_CPP_RELEASE,
  license: 'MIT',
  archives: [
    {
      platform: 'darwin-arm64',
      name: `llama-${LLAMA_CPP_RELEASE}-bin-macos-arm64.tar.gz`,
      url: `${LLAMA_CPP_BASE}/llama-${LLAMA_CPP_RELEASE}-bin-macos-arm64.tar.gz`,
      bytes: 11_827_796,
      sha256: 'f6f337fc7d2ff9260f53177cf4fe6bbf6b0f7faa75a49fb224aaf66885a5c956',
      gpu: true,
    },
    {
      platform: 'linux-x64',
      name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-x64.tar.gz`,
      url: `${LLAMA_CPP_BASE}/llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-x64.tar.gz`,
      bytes: 17_544_875,
      sha256: 'ef1856938dc1434138ce53688791eb0d2d64cf46e309a0942a12bba3366c0919',
      gpu: false,
    },
    {
      platform: 'linux-arm64',
      name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-arm64.tar.gz`,
      url: `${LLAMA_CPP_BASE}/llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-arm64.tar.gz`,
      bytes: 13_590_823,
      sha256: '88589b963d8e2ffd2d4df2f542ed7e301fb636b637c99081f5d58646aee20a9a',
      gpu: false,
    },
  ],
};

/** The size the owner asked for, or `auto` (pick by this machine's memory). */
export type BuiltInReasoningModelChoice = 'auto' | BuiltInReasoningSizeClass | string;

/**
 * Picks the model for a machine with `totalMemoryBytes` of RAM: 16 GB and up
 * gets the standard (4B) model, 8 GB gets the small (2B) one, and less than
 * that gets none. `large` (9B) is never auto-picked; it is an explicit upgrade
 * and still needs 16 GB. A model id names one model exactly.
 */
export function pickBuiltInReasoningModel(
  totalMemoryBytes: number,
  choice: BuiltInReasoningModelChoice = 'auto',
  models: readonly BuiltInReasoningModelSpec[] = BUILT_IN_REASONING_MODELS,
): BuiltInReasoningModelSpec | undefined {
  const wanted = choice.trim().toLowerCase() || 'auto';
  const exact = models.find((model) => model.modelId === wanted);
  if (exact) return totalMemoryBytes >= exact.minimumMemoryBytes ? exact : undefined;
  if (wanted === 'small' || wanted === 'standard' || wanted === 'large') {
    const sized = models.find((model) => model.sizeClass === wanted);
    return sized && totalMemoryBytes >= sized.minimumMemoryBytes ? sized : undefined;
  }
  if (wanted !== 'auto') return undefined;
  const standard = models.find((model) => model.sizeClass === 'standard');
  if (standard && totalMemoryBytes >= standard.minimumMemoryBytes) return standard;
  const small = models.find((model) => model.sizeClass === 'small');
  if (small && totalMemoryBytes >= small.minimumMemoryBytes) return small;
  return undefined;
}

export function runtimeArchiveFor(
  platform: string,
  runtime: LlamaServerRuntimeSpec = LLAMA_SERVER_RUNTIME,
): PinnedRuntimeArchive | undefined {
  return runtime.archives.find((archive) => archive.platform === platform);
}
