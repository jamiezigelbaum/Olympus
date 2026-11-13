// The request-serving thread sends model operations as messages. Downloads,
// checksums, filesystem work, tokenizers and native session/helper starts run
// in the sibling worker, shared by every built-in model. Status files remain the
// dashboard's authority, including while this thread is busy installing.
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuiltInReasoningStatus, PinnedModelInstallerOptions } from './install.ts';
import type { BuiltInEmbeddingInstallerOptions, BuiltInEmbeddingStatus, InstalledBuiltInEmbedding } from '../built-in-embedding/assets.ts';
import type { BuiltInEmbeddingModelSpec } from '../built-in-embedding/manifest.ts';
import type { SourceEmbeddingInput, SourceEmbeddingTaskType } from '../embeddings.ts';
import type { EvidenceRerankRequest } from '../../../core/evidence-reranker.ts';
import type { LiteRtDevice, LiteRtEmbedderOptions, LiteRtEmbedItem } from '../built-in-embedding/litert-runtime.ts';
import type { LlamaServerLaunch } from './server.ts';

export type ModelThreadRequest =
  | { kind: 'install'; options: PinnedModelInstallerOptions }
  | { kind: 'start'; handle: number; launch: LlamaServerLaunch; env?: Record<string, string | undefined> | undefined; stopGraceMs?: number | undefined; killWaitMs?: number | undefined; immediateKill?: boolean | undefined }
  | { kind: 'touch' | 'stop'; handle: number }
  | { kind: 'embedding-install'; options: BuiltInEmbeddingInstallerOptions }
  | { kind: 'embedding-load'; handle: number; installed: InstalledBuiltInEmbedding; model: BuiltInEmbeddingModelSpec; env: Record<string, string | undefined>; threads: number }
  | { kind: 'embedding-run'; handle: number; inputs: SourceEmbeddingInput[]; taskType: SourceEmbeddingTaskType; priority: boolean }
  | { kind: 'reranker-load'; handle: number; env: Record<string, string | undefined> }
  | { kind: 'reranker-run'; handle: number; request: Omit<EvidenceRerankRequest, 'signal'> }
  | { kind: 'litert-start'; handle: number; options: LiteRtEmbedderOptions }
  | { kind: 'litert-run'; handle: number; items: readonly LiteRtEmbedItem[] }
  | { kind: 'litert-release'; handle: number }
  | { kind: 'shutdown' };
export interface ModelThreadFailure { name: string; message: string; reason?: string | undefined; shortfall?: unknown; indexes?: readonly number[] | undefined; device?: LiteRtDevice | undefined; vision?: boolean | undefined }
export type ModelThreadReply = {
  id: number;
  result?: unknown;
  error?: ModelThreadFailure;
  progress?: BuiltInReasoningStatus;
  embeddingProgress?: BuiltInEmbeddingStatus;
  log?: string;
  handle?: number;
  pid?: number | undefined;
};

let shared: ModelThread | undefined;
let nextHandle = 1;
export function modelThreadHandleId(): number { return nextHandle++; }

/** Also accepts a worker path so responsiveness is testable with blocking fixtures. */
export class ModelThread {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: unknown) => void; reject: (error: Error) => void;
    progress?: ((status: BuiltInReasoningStatus) => void) | undefined; log?: ((line: string) => void) | undefined;
    embeddingProgress?: ((status: BuiltInEmbeddingStatus) => void) | undefined;
    cleanup: () => void;
  }>();
  readonly pids = new Map<number, number>();

  constructor(path = modelWorkerPath()) {
    const shutdown = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(path, { workerData: { shutdown } });
    // process.exit() cannot await a promise. The lifecycle thread can still
    // observe and stop its own ChildProcess objects while the parent waits.
    const onExit = () => {
      this.worker.postMessage({ shutdown: true });
      Atomics.wait(shutdown, 0, 0, 15_000);
    };
    process.once('exit', onExit);
    this.worker.on('message', (reply: ModelThreadReply) => {
      if (reply.handle !== undefined) {
        if (reply.pid === undefined) this.pids.delete(reply.handle);
        else this.pids.set(reply.handle, reply.pid);
      }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      if (reply.embeddingProgress) { pending.embeddingProgress?.(reply.embeddingProgress); return; }
      if (reply.progress) { pending.progress?.(reply.progress); return; }
      if (reply.log !== undefined) { pending.log?.(reply.log); return; }
      this.pending.delete(reply.id);
      pending.cleanup();
      if (this.pending.size === 0) this.worker.unref();
      if (reply.error) {
        const error = Object.assign(new Error(reply.error.message), reply.error);
        pending.reject(error);
      } else pending.resolve(reply.result);
    });
    const failed = (error: Error) => {
      if (shared === this) shared = undefined;
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
      this.pending.clear();
      this.pids.clear();
    };
    this.worker.on('error', failed);
    this.worker.on('exit', () => { process.removeListener('exit', onExit); failed(new Error('The built-in model worker stopped.')); });
    this.worker.unref();
  }

  call<T>(request: ModelThreadRequest, options: {
    signal?: AbortSignal | undefined; timeoutMs?: number;
    embeddingProgress?: ((status: BuiltInEmbeddingStatus) => void) | undefined;
    progress?: ((status: BuiltInReasoningStatus) => void) | undefined; log?: ((line: string) => void) | undefined;
  } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(cancelled());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.worker.postMessage({ cancel: id });
      const timer = setTimeout(() => {
        abort();
        this.pending.delete(id);
        cleanup();
        if (this.pending.size === 0) this.worker.unref();
        reject(new Error('The built-in model worker operation timed out.'));
      }, options.timeoutMs ?? 2 * 60 * 60_000);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: result => resolve(result as T), reject, cleanup, progress: options.progress, log: options.log, embeddingProgress: options.embeddingProgress });
      this.worker.ref();
      try { this.worker.postMessage({ id, request }); }
      catch (error) {
        this.pending.delete(id); cleanup();
        if (this.pending.size === 0) this.worker.unref();
        reject(error);
      }
    });
  }
}

function cancelled(): Error { return Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' }); }
function modelWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled beside cli.js/index.js; the source worker is a sibling too.
  for (const name of ['model-worker.js', 'model-worker.ts']) {
    const path = join(here, name);
    if (existsSync(path)) return path;
  }
  throw new Error('The built-in model worker is not installed.');
}
export function modelThread(): ModelThread {
  if (!shared) {
    shared = new ModelThread();
    const current = shared;
    // An unref'd thread must not keep a CLI alive, or leave its servers behind
    // when the event loop empties. Worker shutdown observes each child exit.
    process.once('beforeExit', () => { if (shared === current) void current.call({ kind: 'shutdown' }).catch(() => {}); });
  }
  return shared;
}
