// Built-in model thread: installs, native ONNX sessions, tokenizers and inference.
// LiteRT inference remains in its helper process; the serving thread only sends messages.
import { parentPort, workerData } from 'node:worker_threads';
import { startLiteRtEmbedder, type LiteRtEmbedder } from '../built-in-embedding/litert-runtime.ts';
import { installBuiltInEmbedding, installBuiltInReranker } from '../built-in-embedding/assets.ts';
import { BuiltInSourceEmbeddingProvider } from '../built-in-embedding/provider.ts';
import { builtInRerankerFromEnv, type CrossEncoderReranker } from '../built-in-reranker.ts';
import { withPriorityQueryEmbedding } from '../embeddings.ts';
import { installPinnedModel } from './install.ts';
import { createLlamaServerHandle, type LlamaServerHandle } from './server.ts';
import type { ModelThreadFailure, ModelThreadReply, ModelThreadRequest } from './off-thread.ts';

const port = parentPort!;
const liteRtHelpers = new Map<number, LiteRtEmbedder>();
const embedders = new Map<number, BuiltInSourceEmbeddingProvider>();
const rerankers = new Map<number, CrossEncoderReranker>();
const handles = new Map<number, LlamaServerHandle>();
const controllers = new Map<number, AbortController>();
const stopAll = () => Promise.all([
  ...[...handles.values()].map(handle => handle.stop()),
  ...[...liteRtHelpers.values()].map(helper => helper.release()),
]);
const send = (reply: ModelThreadReply) => port.postMessage(reply);
port.on('message', async (message: { id: number; request: ModelThreadRequest; cancel?: number; shutdown?: boolean }) => {
  if (message.shutdown) {
    try { await stopAll(); }
    finally { Atomics.store(workerData.shutdown, 0, 1); Atomics.notify(workerData.shutdown, 0); }
    return;
  }
  if (message.cancel !== undefined) { controllers.get(message.cancel)?.abort(); return; }
  const { id, request } = message;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    let result: unknown;
    switch (request.kind) {
      case 'litert-start': {
        const helper = await startLiteRtEmbedder(request.options);
        liteRtHelpers.set(request.handle, helper);
        result = { device: helper.device, vision: helper.vision };
        break;
      }
      case 'litert-run': {
        const helper = liteRtHelpers.get(request.handle);
        if (!helper) throw new Error('The built-in search helper is not running.');
        const vectors = await helper.embed(request.items);
        result = { vectors, device: helper.device, vision: helper.vision };
        break;
      }
      case 'litert-release':
        await liteRtHelpers.get(request.handle)?.release();
        liteRtHelpers.delete(request.handle);
        break;
      case 'embedding-install':
        result = await installBuiltInEmbedding({ ...request.options, onProgress: embeddingProgress => send({ id, embeddingProgress }) });
        break;
      case 'reranker-install':
        await installBuiltInReranker({ ...request.options, onProgress: embeddingProgress => send({ id, embeddingProgress }) });
        break;
      case 'embedding-load': {
        const provider = new BuiltInSourceEmbeddingProvider({
          env: request.env, model: request.model, threads: request.threads,
          install: async () => request.installed,
        });
        await provider.prepare();
        embedders.set(request.handle, provider);
        break;
      }
      case 'embedding-run': {
        const provider = embedders.get(request.handle);
        if (!provider) throw new Error('The built-in search model is not loaded.');
        const run = () => provider.embed(request.inputs, { taskType: request.taskType });
        result = await (request.priority ? withPriorityQueryEmbedding(run) : run());
        break;
      }
      case 'reranker-load': {
        const reranker = builtInRerankerFromEnv({ env: request.env });
        if (!reranker) throw new Error('The built-in reranker is not configured.');
        await reranker.prepare();
        rerankers.set(request.handle, reranker);
        break;
      }
      case 'reranker-run': {
        const reranker = rerankers.get(request.handle);
        if (!reranker) throw new Error('The built-in reranker is not loaded.');
        result = await reranker.score({ ...request.request, signal: controller.signal });
        break;
      }
      case 'install':
        result = await installPinnedModel({ ...request.options,
          onProgress: progress => send({ id, progress }), log: log => send({ id, log }),
        });
        break;
      case 'start': {
        let handle = handles.get(request.handle);
        if (!handle) {
          handle = createLlamaServerHandle(request.launch, {
            ...(request.env ? { env: request.env } : {}),
            ...(request.stopGraceMs !== undefined ? { stopGraceMs: request.stopGraceMs } : {}),
            ...(request.killWaitMs !== undefined ? { killWaitMs: request.killWaitMs } : {}),
            ...(request.immediateKill !== undefined ? { immediateKill: request.immediateKill } : {}),
            onPid: pid => send({ id: 0, handle: request.handle, pid }),
          });
          handles.set(request.handle, handle);
        }
        result = await handle.ensureRunning(controller.signal);
        break;
      }
      case 'touch': handles.get(request.handle)?.touch(); break;
      case 'stop': await handles.get(request.handle)?.stop(); break;
      case 'shutdown': await stopAll(); break;
    }
    send({ id, result });
    if (request.kind === 'shutdown') port.close();
  } catch (error) {
    const failure = error as Error & ModelThreadFailure;
    const helper = request.kind === 'litert-run' ? liteRtHelpers.get(request.handle) : undefined;
    send({ id, error: { name: failure.name, message: failure.message, reason: failure.reason, shortfall: failure.shortfall,
      indexes: failure.indexes, device: helper?.device, vision: helper?.vision,
    } });
  } finally { controllers.delete(id); }
});
