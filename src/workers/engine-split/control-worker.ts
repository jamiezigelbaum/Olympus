// The background engine's control thread (control-plane.ts starts it; bundled
// on its own as dist/engine-control-worker.js and started as a Bun Worker).
//
// It owns the two things the front and the owner wait on, so neither waits on
// the engine's loop: the command socket (accept, check, answer "received",
// answer results) and the status snapshot's publish. The loop hands it state
// by message: its word on each command, and the status it last collected. A
// loop held in one long SQLite call then shows as a command that is accepted
// and applied when the loop turns, and a status that says how old it is.
//
// This thread never opens a store and never waits on a disk: the snapshot is
// written with the asynchronous file calls.

import { chmodSync } from 'node:fs';
import { rename, utimes, writeFile } from 'node:fs/promises';
import type { AnalystModelCompletion, AnalystModelRequest } from '../../core/analyst.ts';
import { OperationError, type OperationErrorCode } from '../../core/operation-error.ts';
import { workerSocketServe } from '../../core/worker-transport.ts';
import { currentLocalInferencePriority } from '../answer-activity.ts';
import { createEngineCommandHandler } from './commands.ts';
import { EngineCommandMirror } from './control-mirror.ts';
import {
  CONTROL_BIND, CONTROL_BIND_BOUND, CONTROL_BIND_REFUSED, CONTROL_INTS, CONTROL_MESSAGE_BYTES, CONTROL_MESSAGE_LENGTH,
  CONTROL_STOPPED, CONTROL_TICK, type ControlInit, type ControlToLoop, type ControlToThread,
} from './control-plane.ts';
import { describeSnapshotFailure, ENGINE_STATUS_SNAPSHOT_SCHEMA } from './snapshot.ts';

declare const self: {
  onmessage: ((event: { data: ControlToThread }) => void) | null;
  postMessage(message: ControlToLoop): void;
};

/** How often commands the loop has not settled are asked about again, while the loop turns. */
const RESYNC_MS = 2_000;

function start(init: ControlInit): void {
  const ints = new Int32Array(init.shared, 0, CONTROL_INTS);
  const post = (message: ControlToLoop) => self.postMessage(message);

  // The loop's tick: one that stops means the loop is held.
  let lastTick = Atomics.load(ints, CONTROL_TICK);
  let lastTickAt = performance.now();
  const sampleTick = (): number => {
    const tick = Atomics.load(ints, CONTROL_TICK);
    if (tick !== lastTick) { lastTick = tick; lastTickAt = performance.now(); }
    return tick;
  };
  const loopHeldMs = (): number => {
    sampleTick();
    return Math.max(0, performance.now() - lastTickAt - init.tickMs);
  };

  let ready = false;
  const mirror = new EngineCommandMirror({
    instanceId: init.instanceId,
    send: (envelope) => post({ type: 'submit', envelope }),
    loopHeldMs,
  });

  // A model completion runs on the loop, which holds the model: asked for by
  // message, answered by message, and stopped when the request closes.
  let nextModelId = 1;
  const models = new Map<number, { resolve: (completion: AnalystModelCompletion) => void; reject: (error: Error) => void }>();
  const modelComplete = (request: AnalystModelRequest): Promise<AnalystModelCompletion> => {
    const { signal, ...body } = request;
    const id = nextModelId++;
    return new Promise<AnalystModelCompletion>((resolve, reject) => {
      const stop = () => {
        if (!models.delete(id)) return;
        post({ type: 'model_stop', id });
        reject(new DOMException('The model request was closed.', 'AbortError'));
      };
      if (signal?.aborted) { reject(new DOMException('The model request was closed.', 'AbortError')); return; }
      signal?.addEventListener('abort', stop, { once: true });
      models.set(id, {
        resolve: (completion) => { signal?.removeEventListener('abort', stop); resolve(completion); },
        reject: (error) => { signal?.removeEventListener('abort', stop); reject(error); },
      });
      post({ type: 'model', id, request: body, priority: currentLocalInferencePriority() });
    });
  };

  const handler = createEngineCommandHandler({
    authToken: init.authToken,
    ledger: mirror,
    ready: () => ready,
    ...(init.model ? { modelComplete } : {}),
  });

  // Publish changed state atomically and refresh the heartbeat on unchanged state.
  let state: { at: number; body: Record<string, unknown> } | undefined;
  // The loop's collect threw: said in the snapshot until a collect succeeds.
  let stateError: { attempts: number; error: string; at: number } | undefined;
  let statusPath: string | undefined;
  let writing = false;
  let owed = false;
  let published: { path: string; content: string } | undefined;
  // A snapshot that cannot be written is said at once, then once a minute
  // with the count, and once when it is written again (as the loop's publisher does).
  let failures = 0;
  let saidAt = 0;
  // What a front reads before any state was collected: a background with nothing to report.
  const EMPTY_STATE = { scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: null };
  const publish = async (): Promise<void> => {
    const path = statusPath;
    if (!path || (!state && !stateError)) return;
    if (writing) { owed = true; return; }
    writing = true;
    // One name, written over each time: a write that failed leaves nothing to clean up.
    const partial = `${path}.control.tmp`;
    try {
      const now = new Date();
      const snapshot = {
        schema: ENGINE_STATUS_SNAPSHOT_SCHEMA,
        instance_id: init.instanceId,
        heartbeat: 'mtime',
        ...(state ? { state_at: new Date(state.at).toISOString() } : {}),
        loop_held_ms: Math.round(loopHeldMs()),
        ...(stateError ? { state_error: { attempts: stateError.attempts, error: stateError.error, at: new Date(stateError.at).toISOString() } } : {}),
        ...(state?.body ?? EMPTY_STATE),
      };
      const content = JSON.stringify(snapshot);
      if (published?.path === path && published.content === content) {
        await utimes(path, now, now);
      } else {
        await writeFile(partial, `${JSON.stringify({ ...snapshot, written_at: now.toISOString() })}\n`, { mode: 0o600 });
        await rename(partial, path);
        published = { path, content };
      }
      if (failures > 0) post({ type: 'log', line: `[engine-split] status snapshot written again after ${failures} failed attempt(s)` });
      failures = 0;
    } catch (error) {
      published = undefined;
      failures += 1;
      if (failures === 1 || performance.now() - saidAt >= 60_000) {
        saidAt = performance.now();
        post({ type: 'log', line: `[engine-split] status snapshot not written by the control thread (${failures} attempt(s) in a row): ${describeSnapshotFailure(error)}` });
      }
    } finally {
      writing = false;
      if (owed) { owed = false; void publish(); }
    }
  };

  let server: { stop(closeActiveConnections?: boolean): unknown } | undefined;
  try {
    server = Bun.serve(workerSocketServe({ unix: init.socketPath, fetch: (request: Request) => handler(request) }));
    chmodSync(init.socketPath, 0o600);
    Atomics.store(ints, CONTROL_BIND, CONTROL_BIND_BOUND);
  } catch (error) {
    const bytes = new TextEncoder().encode(error instanceof Error ? error.message : String(error)).slice(0, CONTROL_MESSAGE_BYTES);
    new Uint8Array(init.shared, CONTROL_INTS * 4).set(bytes);
    Atomics.store(ints, CONTROL_MESSAGE_LENGTH, bytes.length);
    Atomics.store(ints, CONTROL_BIND, CONTROL_BIND_REFUSED);
  }
  Atomics.notify(ints, CONTROL_BIND);
  if (!server) return;

  const tickTimer = setInterval(sampleTick, init.tickMs);
  const publishTimer = setInterval(() => { void publish(); }, init.publishMs);
  // Ask again about commands the loop has not settled, once per turn of the
  // loop at most: a held loop is not sent a pile of the same question.
  let askedAtTick = -1;
  const resyncTimer = setInterval(() => {
    const tick = sampleTick();
    if (tick === askedAtTick) return;
    const ids = mirror.unsettled();
    if (!ids.length) return;
    askedAtTick = tick;
    post({ type: 'sync', ids });
  }, RESYNC_MS);

  self.onmessage = ({ data }) => {
    switch (data.type) {
      case 'ready':
        ready = data.ready;
        return;
      case 'receipts':
        mirror.apply(data.receipts, data.unknown);
        return;
      case 'state':
        state = { at: data.at, body: data.state };
        stateError = undefined;
        statusPath = data.path;
        void publish();
        return;
      case 'state_failed':
        stateError = { attempts: data.attempts, error: data.error, at: data.at };
        statusPath = data.path;
        void publish();
        return;
      case 'model_result': {
        const waiting = models.get(data.id);
        if (!waiting) return;
        models.delete(data.id);
        if (data.completion) waiting.resolve(data.completion);
        else if (data.operationError) waiting.reject(new OperationError(data.operationError.error as OperationErrorCode, data.operationError.message, data.operationError.suggestion));
        else waiting.reject(new Error(data.message ?? 'The model call failed.'));
        return;
      }
      case 'stop':
        clearInterval(tickTimer);
        clearInterval(publishTimer);
        clearInterval(resyncTimer);
        void server?.stop(true);
        Atomics.store(ints, CONTROL_STOPPED, 1);
        Atomics.notify(ints, CONTROL_STOPPED);
        return;
      default:
        return;
    }
  };
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') start(data);
};
