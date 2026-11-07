// Dedicated lifecycle thread. No item text, question or inference enters it.
import { parentPort, workerData } from 'node:worker_threads';
import { installPinnedModel } from './install.ts';
import { createLlamaServerHandle, type LlamaServerHandle } from './server.ts';
import type { ModelThreadFailure, ModelThreadReply, ModelThreadRequest } from './off-thread.ts';

const port = parentPort!;
const handles = new Map<number, LlamaServerHandle>();
const controllers = new Map<number, AbortController>();
const send = (reply: ModelThreadReply) => port.postMessage(reply);
port.on('message', async (message: { id: number; request: ModelThreadRequest; cancel?: number; shutdown?: boolean }) => {
  if (message.shutdown) {
    try { await Promise.all([...handles.values()].map(handle => handle.stop())); }
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
      case 'shutdown': await Promise.all([...handles.values()].map(handle => handle.stop())); break;
    }
    send({ id, result });
    if (request.kind === 'shutdown') port.close();
  } catch (error) {
    const failure = error as Error & ModelThreadFailure;
    send({ id, error: { name: failure.name, message: failure.message, reason: failure.reason, shortfall: failure.shortfall } });
  } finally { controllers.delete(id); }
});
