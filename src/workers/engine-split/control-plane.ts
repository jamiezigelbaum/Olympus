/**
 * The background engine's control plane, on its own thread
 * (control-worker.ts). The engine's loop calls SQLite synchronously, and how
 * long such a call takes is set by the disk, not the code; on a busy store
 * the loop was held about a fifth of the time (16 Nov, worst 30 s) and once
 * for minutes. Whatever the owner or the front waits on must not share that
 * thread. So the command socket and the status snapshot's publish live on a
 * Worker, as the heartbeat does (core/engine-heartbeat.ts):
 *
 * - a command is accepted and answered "received" by the thread at once, and
 *   handed to the loop by message; the ledger on the loop still applies it,
 *   once, and its result goes back by message;
 * - the loop hands the thread the status it collects; the thread writes the
 *   snapshot every few seconds whether the loop turns or not, with how old
 *   that state is and how long the loop has been held.
 *
 * This file is the loop's side. No engine or store code runs on the thread.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalystModelCompletion, AnalystModelRequest } from '../../core/analyst.ts';
import { OperationError } from '../../core/operation-error.ts';
import { runAtLocalInferencePriority, type LocalInferencePriority } from '../answer-activity.ts';
import { type EngineCommandEnvelope, type EngineCommandLedger, type EngineCommandReceipt } from './commands.ts';
import { ENGINE_STATUS_PUBLISH_INTERVAL_MS } from './snapshot.ts';

// The buffer both threads see: four counters, then the text of a refused bind.
export const CONTROL_INTS = 4;
/** Counts the loop's turns: one that stops means the loop is held. */
export const CONTROL_TICK = 0;
export const CONTROL_BIND = 1;
export const CONTROL_STOPPED = 2;
export const CONTROL_MESSAGE_LENGTH = 3;
export const CONTROL_MESSAGE_BYTES = 512;
export const CONTROL_BIND_BOUND = 1;
export const CONTROL_BIND_REFUSED = 2;

/** How often the loop ticks. */
const LOOP_TICK_MS = 250;
/** The longest the loop waits for the thread to start and bind, at boot. A thread that has not by then is not used. */
const CONTROL_START_WAIT_MS = 30_000;
/** The longest a stop waits for the thread to close its socket. */
const CONTROL_STOP_WAIT_MS = 2_000;

export interface ControlInit {
  type: 'init';
  socketPath: string;
  authToken: string;
  instanceId: string;
  shared: SharedArrayBuffer;
  tickMs: number;
  publishMs: number;
  /** Whether this background serves the built-in model's completions. */
  model: boolean;
}

export type ControlToThread =
  | ControlInit
  | { type: 'ready'; ready: boolean }
  /** The loop's word on commands; `unknown` are ids it was asked about and does not hold. */
  | { type: 'receipts'; receipts: EngineCommandReceipt[]; unknown?: string[] }
  /** The status the loop collected at `at`, and the snapshot file it goes in. */
  | { type: 'state'; at: number; state: Record<string, unknown>; path: string }
  /** The loop's collect threw: the thread keeps publishing the last state and says so in it. */
  | { type: 'state_failed'; at: number; attempts: number; error: string; path: string }
  | { type: 'model_result'; id: number; completion?: AnalystModelCompletion; operationError?: { error: string; message: string; suggestion?: string }; message?: string }
  | { type: 'stop' };

export type ControlToLoop =
  | { type: 'submit'; envelope: EngineCommandEnvelope }
  | { type: 'sync'; ids: string[] }
  | { type: 'model'; id: number; request: Omit<AnalystModelRequest, 'signal'>; priority: LocalInferencePriority }
  | { type: 'model_stop'; id: number }
  | { type: 'log'; line: string };

export interface EngineControlPlane {
  setReady(ready: boolean): void;
  /** Hands the thread the status the loop just collected; false when the thread is gone. */
  publishState(state: Record<string, unknown>, at: number, path: string): boolean;
  /** Tells the thread the loop could not collect its status. */
  publishFailure(failure: { attempts: number; error: string; at: number }, path: string): void;
  stop(): void;
}

export interface EngineControlPlaneInput {
  socketPath: string;
  authToken: string;
  instanceId: string;
  /** The ledger on this loop: the one place a command is applied. */
  ledger: EngineCommandLedger;
  modelComplete?: (request: AnalystModelRequest) => Promise<AnalystModelCompletion>;
  publishMs?: number;
  log?: (line: string) => void;
  /** The thread ended on its own: the caller serves the socket and the snapshot from the loop again. */
  onLost: (reason: string) => void;
  /** Tests only: how the thread is made (to fail a start). */
  createWorker?: (path: string) => Worker;
}

function controlWorkerPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/engine-control-worker.js beside dist/cli.js; from source: the .ts sibling.
  for (const name of ['engine-control-worker.js', 'control-worker.ts']) {
    const candidate = join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const NEVER = new Promise<void>(() => {});

/**
 * Starts the control thread and waits, at boot, until it holds the command
 * socket. Returns undefined when there is no thread to use here (the caller
 * then serves from the loop, as before the thread existed, and says so).
 * Throws when the thread could not bind the socket.
 */
export function startEngineControlPlane(input: EngineControlPlaneInput): EngineControlPlane | undefined {
  const log = input.log ?? ((line: string) => console.warn(line));
  const path = typeof Worker === 'function' && (globalThis as { Bun?: unknown }).Bun ? controlWorkerPath() : undefined;
  if (!path) return undefined;
  const shared = new SharedArrayBuffer(CONTROL_INTS * 4 + CONTROL_MESSAGE_BYTES);
  const ints = new Int32Array(shared, 0, CONTROL_INTS);
  let worker: Worker;
  try {
    worker = (input.createWorker ?? ((file) => new Worker(file)))(path);
  } catch (error) {
    log(`[engine-split] the control thread could not be started: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  // The thread holds the process open while it serves, as the socket's server
  // on the loop did; stop() ends it.
  // Nothing is posted to a thread that has ended or been stopped.
  let gone = false;
  const send = (message: ControlToThread) => { if (!gone) worker.postMessage(message); };

  // The socket is created under a private umask, as bindWorkerSocket does on
  // the loop. The umask is the process's, so this thread sets it and waits
  // here, doing nothing else, until the control thread has bound.
  const previous = process.umask(0o177);
  let bind: number;
  try {
    send({
      type: 'init', socketPath: input.socketPath, authToken: input.authToken, instanceId: input.instanceId,
      shared, tickMs: LOOP_TICK_MS, publishMs: input.publishMs ?? ENGINE_STATUS_PUBLISH_INTERVAL_MS, model: input.modelComplete !== undefined,
    });
    Atomics.wait(ints, CONTROL_BIND, 0, CONTROL_START_WAIT_MS);
    bind = Atomics.load(ints, CONTROL_BIND);
  } finally {
    process.umask(previous);
  }
  if (bind === CONTROL_BIND_REFUSED) {
    worker.terminate();
    const text = new TextDecoder().decode(new Uint8Array(shared, CONTROL_INTS * 4).slice(0, Atomics.load(ints, CONTROL_MESSAGE_LENGTH)));
    throw new Error(`The background command socket could not be bound: ${text || 'unknown error'}`);
  }
  if (bind !== CONTROL_BIND_BOUND) {
    worker.terminate();
    log(`[engine-split] the control thread did not start within ${CONTROL_START_WAIT_MS / 1000} s.`);
    return undefined;
  }

  const tick = setInterval(() => { Atomics.add(ints, CONTROL_TICK, 1); }, LOOP_TICK_MS);
  tick.unref?.();
  let lost = false;
  let stopping = false;
  const followed = new Set<string>();
  const modelCalls = new Map<number, AbortController>();

  const submit = (envelope: EngineCommandEnvelope): void => {
    let receipt: EngineCommandReceipt;
    try {
      receipt = input.ledger.submit(envelope);
    } catch (error) {
      // The thread checked the command and its id; a refusal here is the ledger's own, and the command's answer.
      send({ type: 'receipts', receipts: [{ id: envelope.id, state: 'failed', instance_id: input.instanceId, error: error instanceof Error ? error.message : 'The command was refused.' }] });
      return;
    }
    send({ type: 'receipts', receipts: [receipt] });
    if (receipt.state !== 'received' || followed.has(envelope.id)) return;
    followed.add(envelope.id);
    void input.ledger.settled(envelope.id, NEVER).then((settled) => {
      followed.delete(envelope.id);
      if (settled) send({ type: 'receipts', receipts: [settled] });
    });
  };

  const runModel = (id: number, request: Omit<AnalystModelRequest, 'signal'>, priority: LocalInferencePriority): void => {
    const modelComplete = input.modelComplete;
    if (!modelComplete) { send({ type: 'model_result', id, message: 'This background serves no model.' }); return; }
    const controller = new AbortController();
    modelCalls.set(id, controller);
    void runAtLocalInferencePriority(priority, () => modelComplete({ ...request, signal: controller.signal })).then(
      (completion) => { send({ type: 'model_result', id, completion }); },
      (error: unknown) => {
        if (error instanceof OperationError) send({ type: 'model_result', id, operationError: error.toJSON() as { error: string; message: string; suggestion?: string } });
        else send({ type: 'model_result', id, message: error instanceof Error ? error.message : 'unknown error' });
      },
    ).finally(() => { modelCalls.delete(id); });
  };

  worker.onmessage = (event: MessageEvent<ControlToLoop>) => {
    const message = event.data;
    switch (message.type) {
      case 'submit':
        submit(message.envelope);
        return;
      case 'sync': {
        const receipts: EngineCommandReceipt[] = [];
        const unknown: string[] = [];
        for (const id of message.ids) {
          const receipt = input.ledger.get(id);
          if (receipt) receipts.push(receipt);
          else unknown.push(id);
        }
        send({ type: 'receipts', receipts, unknown });
        return;
      }
      case 'model':
        runModel(message.id, message.request, message.priority);
        return;
      case 'model_stop':
        modelCalls.get(message.id)?.abort();
        return;
      case 'log':
        log(message.line);
        return;
      default:
        return;
    }
  };

  const lose = (reason: string): void => {
    if (lost || stopping) return;
    lost = true;
    gone = true;
    clearInterval(tick);
    for (const controller of modelCalls.values()) controller.abort();
    input.onLost(reason);
  };
  worker.onerror = (event: ErrorEvent) => lose(event.message || 'an error on the thread');
  worker.addEventListener('close', () => lose('the thread ended'));

  return {
    setReady: (ready) => { send({ type: 'ready', ready }); },
    publishState: (state, at, path) => {
      if (gone) return false;
      send({ type: 'state', at, state, path });
      return true;
    },
    publishFailure: (failure, path) => { send({ type: 'state_failed', ...failure, path }); },
    stop: () => {
      if (stopping) return;
      stopping = true;
      clearInterval(tick);
      if (lost) return;
      // The socket is closed before this returns: a successor can bind it at once.
      send({ type: 'stop' });
      gone = true;
      Atomics.wait(ints, CONTROL_STOPPED, 0, CONTROL_STOP_WAIT_MS);
      worker.terminate();
    },
  };
}
