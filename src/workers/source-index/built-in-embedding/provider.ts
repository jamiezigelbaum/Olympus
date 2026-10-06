// The built-in embedding provider: a small model that runs inside the Olympus
// process, needs no account, no extra app and no network once installed, and
// sends nothing anywhere. The model and its runtime download once, on first
// use, into the Olympus data directory (see assets.ts).

import { modelInstallFailedReason, type ModelInstallFailedReason } from '../../../core/model-install-failure.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { OperationError } from '../../../core/operation-error.ts';
import { resolveEmbeddingEpoch } from '../embedding-identity.ts';
import {
  TransientSourceEmbeddingError,
  type SourceEmbeddingInput,
  type SourceEmbeddingProvider,
  type SourceEmbeddingTaskType,
} from '../embeddings.ts';
import {
  BuiltInEmbeddingInstallError,
  builtInEmbeddingPaths,
  installBuiltInEmbedding,
  readBuiltInEmbeddingStatus,
  reportBuiltInEmbeddingState,
  type BuiltInEmbeddingFailureReason,
  type BuiltInEmbeddingInstallerOptions,
  type BuiltInEmbeddingStatus,
  type InstalledBuiltInEmbedding,
} from './assets.ts';
import {
  BUILT_IN_EMBEDDING_MODEL,
  BUILT_IN_EMBEDDING_MODELS,
  builtInEmbeddingModel,
  type BuiltInEmbeddingModelSpec,
} from './manifest.ts';
import { onnxRuntimeFromDirectory, type EmbeddingRuntime, type EmbeddingSession } from './runtime.ts';
import { SentencePieceTokenizer } from './sentencepiece.ts';
import { WordPieceTokenizer } from './wordpiece.ts';

export const BUILT_IN_EMBEDDING_PROVIDER = 'built-in';
export const BUILT_IN_EMBEDDING_THREADS_ENV = 'OLYMPUS_BUILT_IN_EMBEDDING_THREADS';

/** A document longer than one model window is read as up to this many windows. */
const MAX_WINDOWS_PER_DOCUMENT = 8;
/**
 * Padded tokens per forward pass; bounds peak memory independent of input.
 * Measured on an M3 (arctic-m int8, 4 threads): 8,192 tokens peaked near
 * 1.5 GB RSS, 2,048 near 0.7 GB, at the same throughput.
 */
const MAX_BATCH_TOKENS = 2_048;
const MAX_BATCH_ROWS = 32;
/** After a failed install, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;

export interface BuiltInSourceEmbeddingProviderOptions {
  env?: Record<string, string | undefined>;
  model?: BuiltInEmbeddingModelSpec;
  /** Defaults to ONNX Runtime loaded from the installed pack. */
  runtime?: (installed: InstalledBuiltInEmbedding) => EmbeddingRuntime;
  /** Defaults to the pinned downloader. */
  install?: (options: BuiltInEmbeddingInstallerOptions) => Promise<InstalledBuiltInEmbedding>;
  installerOptions?: Omit<BuiltInEmbeddingInstallerOptions, 'env' | 'model'>;
  threads?: number;
  epochId?: string;
  now?: () => number;
}

interface LoadedModel {
  session: EmbeddingSession;
  tokenizer: WindowTokenizer;
}

/** A tokenizer as the windowing sees it: content ids, and the special ids around every window. */
interface WindowTokenizer {
  tokenize(text: string): number[];
  /** `[CLS]` or `<bos>`. */
  startId: number;
  /** `[SEP]` or `<eos>`. */
  endId: number;
  padId: number;
}

interface Window {
  input: number;
  ids: number[];
}

export class BuiltInSourceEmbeddingProvider implements SourceEmbeddingProvider {
  provider: string;
  modelId: string;
  dimension: number;
  configHash: string;
  epochId: string;
  backend: 'local';
  /** Forward passes this process may run in parallel. */
  readonly threads: number;

  private spec: BuiltInEmbeddingModelSpec;
  private env: Record<string, string | undefined>;
  private runtimeFactory: (installed: InstalledBuiltInEmbedding) => EmbeddingRuntime;
  private install: (options: BuiltInEmbeddingInstallerOptions) => Promise<InstalledBuiltInEmbedding>;
  private installerOptions: Omit<BuiltInEmbeddingInstallerOptions, 'env' | 'model'>;
  private now: () => number;
  private loading: Promise<LoadedModel> | undefined;
  private loaded: LoadedModel | undefined;
  private lastFailure: { atMs: number; error: Error } | undefined;
  /** One forward pass runs at a time; these wait for the slot, queries first. */
  private slotBusy = false;
  private readonly waiting: { query: Array<() => void>; document: Array<() => void> } = { query: [], document: [] };

  constructor(options: BuiltInSourceEmbeddingProviderOptions = {}) {
    this.spec = options.model ?? BUILT_IN_EMBEDDING_MODEL;
    this.env = options.env ?? process.env;
    this.provider = BUILT_IN_EMBEDDING_PROVIDER;
    this.backend = 'local';
    this.modelId = this.spec.modelId;
    this.dimension = this.spec.dimension;
    this.threads = resolveThreads(options.threads, this.env);
    this.runtimeFactory = options.runtime ?? ((installed) => onnxRuntimeFromDirectory(installed.runtimeDir));
    this.install = options.install ?? installBuiltInEmbedding;
    this.installerOptions = options.installerOptions ?? {};
    this.now = options.now ?? Date.now;
    this.epochId = resolveEmbeddingEpoch({
      provider: this.provider,
      modelId: this.modelId,
      dimension: this.dimension,
      backend: this.backend,
      ...(options.epochId ? { epochOverride: options.epochId } : {}),
    });
    // Keys a WordPiece model never set are left out, so a model's hash (and
    // the vectors stored under it) does not move when another model is added.
    this.configHash = createHash('sha256').update(JSON.stringify({
      provider: this.provider,
      model: this.modelId,
      repository: this.spec.repository,
      revision: this.spec.revision,
      weights: this.spec.model.sha256,
      ...(this.spec.modelData ? { weightsData: this.spec.modelData.sha256 } : {}),
      vocabulary: this.spec.vocabulary.sha256,
      ...(this.spec.tokenizer && this.spec.tokenizer !== 'wordpiece' ? { tokenizer: this.spec.tokenizer } : {}),
      dimension: this.dimension,
      maxTokens: this.spec.maxTokens,
      pooling: this.spec.pooling,
      queryPrefix: this.spec.queryPrefix,
      documentPrefix: this.spec.documentPrefix,
      windows: MAX_WINDOWS_PER_DOCUMENT,
      backend: this.backend,
    })).digest('hex');
  }

  /** The install/load status, as last written by any process. */
  status(): BuiltInEmbeddingStatus {
    return readBuiltInEmbeddingStatus(this.env, this.spec);
  }

  /** Downloads and loads the model now instead of on first use. */
  async prepare(): Promise<void> {
    await this.load();
  }

  /**
   * Loads the model and runs one short query through it, so the first
   * question after a start does not pay for the runtime's first-run setup.
   */
  async warm(): Promise<void> {
    await this.load();
    await this.embed([{ text: 'warm up' }], { taskType: 'RETRIEVAL_QUERY' });
  }

  /** The owner asked to try a failed install again: no back-off wait. */
  async retry(): Promise<void> {
    if (!this.loading) this.lastFailure = undefined;
    await this.load();
  }

  async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    if (inputs.length === 0) return [];
    // A question must not wait minutes for a first download: start it, and
    // let the query lane fall back to keyword search until it finishes.
    if (options.taskType === 'RETRIEVAL_QUERY' && !this.loaded) {
      const status = this.status();
      if (status.state !== 'ready' && status.state !== 'loading') {
        void this.load().catch(() => undefined);
        throw new BuiltInEmbeddingNotReadyError(this.status());
      }
    }
    const model = this.loaded ?? await this.load();
    return this.embedLoaded(model, inputs, options.taskType);
  }

  private load(): Promise<LoadedModel> {
    if (this.loading) return this.loading;
    if (this.lastFailure && this.now() - this.lastFailure.atMs < RETRY_AFTER_FAILURE_MS) {
      return Promise.reject(this.lastFailure.error);
    }
    const loading = this.loadOnce();
    this.loading = loading;
    loading.then(
      (model) => {
        this.loaded = model;
        this.lastFailure = undefined;
      },
      (error: Error) => {
        this.lastFailure = { atMs: this.now(), error };
        if (this.loading === loading) this.loading = undefined;
      },
    );
    return loading;
  }

  private async loadOnce(): Promise<LoadedModel> {
    const reporterOptions = {
      env: this.env,
      model: this.spec,
      ...(this.installerOptions.now ? { now: this.installerOptions.now } : {}),
      ...(this.installerOptions.onProgress ? { onProgress: this.installerOptions.onProgress } : {}),
    };
    let installed: InstalledBuiltInEmbedding;
    try {
      installed = await this.install({ ...this.installerOptions, env: this.env, model: this.spec });
    } catch (error) {
      throw builtInEmbeddingOperationError(error);
    }
    try {
      reportBuiltInEmbeddingState(reporterOptions, 'loading');
      const tokenizer = loadTokenizer(this.spec, installed.vocabularyPath);
      const session = await this.runtimeFactory(installed).createSession(installed.modelPath, {
        threads: this.threads,
        output: this.spec.pooling === 'model' ? 'sentence_embedding' : 'last_hidden_state',
      });
      reportBuiltInEmbeddingState(reporterOptions, 'ready');
      return { session, tokenizer };
    } catch (error) {
      const failure = new BuiltInEmbeddingInstallError(
        'runtime_load_failed',
        `The built-in search model could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportBuiltInEmbeddingState(reporterOptions, 'failed', { reason: failure.reason, message: failure.message });
      throw builtInEmbeddingOperationError(failure);
    }
  }

  /**
   * One forward pass at a time per process, so the thread cap is the CPU cap.
   * A question's pass goes before every waiting document pass: a search never
   * waits behind a whole indexing batch (32 documents of several windows
   * each), only behind the one pass already running. Indexing right after a
   * start once held a ChatGPT question's Private search past its deadline.
   */
  private async withSlot<T>(taskType: SourceEmbeddingTaskType, run: () => Promise<T>): Promise<T> {
    if (this.slotBusy) {
      await new Promise<void>((resolve) => this.waiting[taskType === 'RETRIEVAL_QUERY' ? 'query' : 'document'].push(resolve));
    } else {
      this.slotBusy = true;
    }
    try {
      return await run();
    } finally {
      const next = this.waiting.query.shift() ?? this.waiting.document.shift();
      // The slot passes straight to the next pass; it is free only when none waits.
      if (next) next();
      else this.slotBusy = false;
    }
  }

  private async embedLoaded(
    model: LoadedModel,
    inputs: SourceEmbeddingInput[],
    taskType: SourceEmbeddingTaskType,
  ): Promise<number[][]> {
    const windowTokens = this.spec.maxTokens - 2;
    const windows: Window[] = [];
    inputs.forEach((input, index) => {
      const ids = model.tokenizer.tokenize(promptText(this.spec, input, taskType));
      const maxWindows = taskType === 'RETRIEVAL_QUERY' ? 1 : MAX_WINDOWS_PER_DOCUMENT;
      const count = Math.max(1, Math.min(maxWindows, Math.ceil(ids.length / windowTokens)));
      for (let window = 0; window < count; window += 1) {
        windows.push({
          input: index,
          ids: [model.tokenizer.startId, ...ids.slice(window * windowTokens, (window + 1) * windowTokens), model.tokenizer.endId],
        });
      }
    });

    const sums = inputs.map(() => new Float64Array(this.dimension));
    for (const batch of planBatches(windows)) {
      const vectors = await this.withSlot(taskType, () => this.forward(model, batch));
      batch.forEach((window, row) => {
        const vector = vectors[row]!;
        const weight = window.ids.length - 2;
        const sum = sums[window.input]!;
        for (let d = 0; d < this.dimension; d += 1) sum[d]! += vector[d]! * Math.max(1, weight);
      });
    }
    return sums.map((sum) => normalize(sum));
  }

  private async forward(model: LoadedModel, batch: Window[]): Promise<Float64Array[]> {
    const rows = batch.length;
    const length = Math.max(...batch.map((window) => window.ids.length));
    const inputIds = new BigInt64Array(rows * length);
    const attentionMask = new BigInt64Array(rows * length);
    const tokenTypeIds = new BigInt64Array(rows * length);
    if (model.tokenizer.padId !== 0) inputIds.fill(BigInt(model.tokenizer.padId));
    batch.forEach((window, row) => {
      window.ids.forEach((id, column) => {
        inputIds[row * length + column] = BigInt(id);
        attentionMask[row * length + column] = 1n;
      });
    });
    let output;
    try {
      output = await model.session.run({ inputIds, attentionMask, tokenTypeIds, batchSize: rows, sequenceLength: length });
    } catch (error) {
      throw new OperationError(
        'source_index_error',
        `The built-in search model failed while embedding: ${error instanceof Error ? error.message : String(error)}`,
        'This is a local runtime failure; restarting Olympus reloads the model.',
      );
    }
    const pooled = this.spec.pooling === 'model';
    const expected = pooled ? [rows, this.dimension] : [rows, length, this.dimension];
    if (output.dims.length !== expected.length || output.dims.some((size, axis) => size !== expected[axis])) {
      throw new OperationError(
        'source_index_error',
        `The built-in search model returned shape [${output.dims.join(', ')}], expected [${expected.join(', ')}].`,
      );
    }
    const hidden = this.dimension;
    if (pooled) {
      return batch.map((_, row) => Float64Array.from(normalize(output.data.subarray(row * hidden, (row + 1) * hidden))));
    }
    return batch.map((window, row) => {
      const vector = new Float64Array(hidden);
      const base = row * length * hidden;
      if (this.spec.pooling === 'cls') {
        for (let d = 0; d < hidden; d += 1) vector[d] = output.data[base + d]!;
      } else {
        for (let token = 0; token < window.ids.length; token += 1) {
          const offset = base + token * hidden;
          for (let d = 0; d < hidden; d += 1) vector[d]! += output.data[offset + d]!;
        }
        for (let d = 0; d < hidden; d += 1) vector[d]! /= window.ids.length;
      }
      return Float64Array.from(normalize(vector));
    });
  }
}

function loadTokenizer(spec: BuiltInEmbeddingModelSpec, path: string): WindowTokenizer {
  if (spec.tokenizer === 'sentencepiece') {
    const tokenizer = new SentencePieceTokenizer(readFileSync(path));
    return {
      tokenize: (text) => tokenizer.tokenize(text),
      startId: tokenizer.bosId,
      endId: tokenizer.eosId,
      padId: tokenizer.padId,
    };
  }
  const tokenizer = new WordPieceTokenizer(readFileSync(path, 'utf8'));
  return {
    tokenize: (text) => tokenizer.tokenize(text),
    startId: tokenizer.clsId,
    endId: tokenizer.sepId,
    padId: tokenizer.padId,
  };
}

/** The text a model reads for one input: its task prefix, then the title and text as the model was trained to see them. */
function promptText(spec: BuiltInEmbeddingModelSpec, input: SourceEmbeddingInput, taskType: SourceEmbeddingTaskType): string {
  if (taskType === 'RETRIEVAL_QUERY') return `${spec.queryPrefix}${input.title ? `${input.title}\n` : ''}${input.text}`;
  if (spec.documentPrefix.includes('{title}')) {
    const title = input.title?.replace(/\s+/g, ' ').trim() || 'none';
    return `${spec.documentPrefix.replace('{title}', () => title)}${input.text}`;
  }
  return `${spec.documentPrefix}${input.title ? `${input.title}\n` : ''}${input.text}`;
}

/** Thrown for a query while the model is still downloading; the query lane degrades to keyword search. */
export class BuiltInEmbeddingNotReadyError extends TransientSourceEmbeddingError {
  readonly status: BuiltInEmbeddingStatus;

  constructor(status: BuiltInEmbeddingStatus) {
    super(BUILT_IN_EMBEDDING_PROVIDER, 'timeout', 0);
    this.name = 'BuiltInEmbeddingNotReadyError';
    this.status = status;
    this.message = status.state === 'failed'
      ? `The built-in search model is not available: ${status.failure?.message ?? 'install failed'}.`
      : `The built-in search model is still being prepared (${status.percent}%).`;
    this.suggestion = 'Answers use keyword search until it is ready; nothing needs to be done.';
  }
}

export interface BuiltInEmbeddingAttention {
  id: 'built-in-embedding';
  reason: BuiltInEmbeddingFailureReason;
  message: string;
}

/**
 * The needs-you item for a failed install, or nothing while it is healthy or
 * still in progress. The dashboard owns the wording; this owns the facts.
 */
export function builtInEmbeddingAttention(status: BuiltInEmbeddingStatus): BuiltInEmbeddingAttention | undefined {
  if (status.state !== 'failed' || !status.failure) return undefined;
  return { id: 'built-in-embedding', reason: status.failure.reason, message: status.failure.message };
}

export function builtInEmbeddingStatusFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltInEmbeddingStatus & { directory: string } {
  return { ...readBuiltInEmbeddingStatus(env), directory: builtInEmbeddingPaths(env).root };
}

function builtInEmbeddingOperationError(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const reason = error instanceof BuiltInEmbeddingInstallError ? error.reason : undefined;
  return new OperationError(
    'source_index_error',
    message,
    reason === 'unsupported_platform'
      ? 'Choose another embedding provider for this machine in the model settings.'
      : reason === 'download_failed'
        ? 'Check the internet connection; Olympus tries the download again automatically.'
        : reason === 'disk_write_failed'
          ? 'Free some disk space; Olympus tries again automatically.'
          : 'Olympus removes the bad file and downloads it again automatically.',
  );
}

function planBatches(windows: Window[]): Window[][] {
  const ordered = [...windows].sort((left, right) => right.ids.length - left.ids.length);
  const batches: Window[][] = [];
  let current: Window[] = [];
  let currentLength = 0;
  for (const window of ordered) {
    const length = Math.max(currentLength, window.ids.length);
    if (current.length > 0 && (current.length >= MAX_BATCH_ROWS || length * (current.length + 1) > MAX_BATCH_TOKENS)) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(window);
    currentLength = Math.max(currentLength, window.ids.length);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function normalize(vector: ArrayLike<number>): number[] {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) norm += vector[index]! * vector[index]!;
  norm = Math.sqrt(norm);
  const out = new Array<number>(vector.length);
  for (let index = 0; index < vector.length; index += 1) out[index] = norm > 0 ? vector[index]! / norm : 0;
  return out;
}

function resolveThreads(explicit: number | undefined, env: Record<string, string | undefined>): number {
  const configured = explicit ?? (env[BUILT_IN_EMBEDDING_THREADS_ENV]?.trim()
    ? Number(env[BUILT_IN_EMBEDDING_THREADS_ENV])
    : undefined);
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw new OperationError(
        'config_error',
        `${BUILT_IN_EMBEDDING_THREADS_ENV} must be a positive whole number.`,
      );
    }
    return configured;
  }
  // Half the cores, at most four: indexing runs in the background and should
  // never make the machine feel busy.
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

// One model per process and data directory: every trust domain that resolves
// to the built-in profile shares the session, its memory, and its thread cap.
let sharedProviders: Map<string, BuiltInSourceEmbeddingProvider> | undefined;

/**
 * The process-wide built-in provider for a configured model id. Refuses a
 * model id this build does not ship, so a config written by a newer Olympus
 * cannot silently embed under an identity it does not match.
 */
export function sharedBuiltInSourceEmbeddingProvider(options: {
  modelId: string;
  env?: Record<string, string | undefined>;
}): BuiltInSourceEmbeddingProvider {
  const model = builtInEmbeddingModel(options.modelId);
  if (!model) {
    throw new OperationError(
      'config_error',
      `This version of Olympus does not include the built-in embedding model "${options.modelId}".`,
      `Use one of ${BUILT_IN_EMBEDDING_MODELS.map((spec) => `"${spec.modelId}"`).join(', ')} for the built-in profile, or update Olympus.`,
    );
  }
  const env = options.env ?? process.env;
  const key = `${builtInEmbeddingPaths(env).root}\u0000${options.modelId}`;
  sharedProviders ??= new Map();
  let provider = sharedProviders.get(key);
  if (!provider) {
    provider = new BuiltInSourceEmbeddingProvider({ env, model });
    sharedProviders.set(key, provider);
  }
  return provider;
}

/**
 * The dashboard contract's `models.embedding` for the built-in model:
 * installing, verifying and loading all read as `downloading`.
 */
export function builtInEmbeddingDashboardState(
  status: BuiltInEmbeddingStatus,
): {
  kind: 'built_in';
  state: 'downloading' | 'verifying' | 'ready' | 'failed';
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  failedReason?: ModelInstallFailedReason;
} {
  if (status.state === 'ready') return { kind: 'built_in', state: 'ready' };
  if (status.state === 'failed') return { kind: 'built_in', state: 'failed', failedReason: modelInstallFailedReason(status.failure) };
  // Loading the verified model into memory is the last step of checking it.
  const state = status.state === 'verifying' || status.state === 'loading' ? 'verifying' : 'downloading';
  return {
    kind: 'built_in',
    state,
    percent: status.percent,
    ...(status.bytesTotal > 0 ? { bytesDone: status.bytesDone, bytesTotal: status.bytesTotal } : {}),
  };
}
