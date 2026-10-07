// Runs the built-in private model in a child `llama-server` process: bound to
// loopback on a random port, guarded by a random bearer token passed through a
// 0600 file (never argv), at low scheduling priority with a capped CPU thread
// count so the Mac stays usable, and shut down after an idle period so the
// model's memory comes back. One process per model per Olympus process.
//
// The port is picked free and then handed to the child, so another process
// could take it in between. The child therefore also gets a random per-start
// model alias through its environment (not argv, which other users can read),
// and nothing is sent to the port until an authenticated /v1/models answer
// carries that alias: a squatter cannot know it. The child's environment is a
// short allow-list, never the worker's (which holds tokens and keys).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism, setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchModelEndpoint } from '../../../core/model-transport.ts';

export interface LlamaServerLaunch {
  serverPath: string;
  modelPath: string;
  contextTokens: number;
  gpu: boolean;
  /** CPU threads for generation and prompt processing. */
  threads: number;
  /** Seconds idle before the server process exits; 0 keeps it running. */
  idleShutdownSeconds: number;
  /** How long to wait for the model to load. */
  startupTimeoutMs: number;
}

export interface LlamaServerEndpoint {
  baseUrl: string;
  token: string;
}

/** The seam the analyst model talks to; tests substitute a stub. */
export interface LlamaServerHandle {
  /**
   * Starts the process if needed and resolves once it answers /health. A new
   * process is never started while an earlier one is not yet confirmed gone.
   */
  ensureRunning(signal?: AbortSignal): Promise<LlamaServerEndpoint>;
  /** Marks a request finished, re-arming the idle shutdown. */
  touch(): void;
  /**
   * Stops the process and resolves only once it has exited: SIGTERM, then
   * SIGKILL after a grace period. Bounded; rejects with LlamaServerStopError
   * when the process is still there after the bound.
   */
  stop(): Promise<void>;
  /** The current server's pid; a process still exiting after stop() has none. */
  readonly pid: number | undefined;
}

export class LlamaServerStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlamaServerStartError';
  }
}

/**
 * A new server was not started because an earlier one has not exited yet.
 * Transient: the install is fine, and a later request starts the server once
 * the old process is gone.
 */
export class LlamaServerStillExitingError extends LlamaServerStartError {
  constructor(message: string) {
    super(message);
    this.name = 'LlamaServerStillExitingError';
  }
}

/** A stopped server process did not exit even after SIGKILL within the bound. */
export class LlamaServerStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlamaServerStopError';
  }
}

const HEALTH_POLL_MS = 250;
/** Why a start (or a request waiting to start one) that a stop() superseded is refused. */
const STOPPED_WHILE_STARTING = 'The built-in model server was stopped while starting.';
/** SIGTERM to SIGKILL. llama-server stops its in-flight decode and exits well inside this. */
const DEFAULT_STOP_GRACE_MS = 5_000;
/**
 * After SIGKILL, how long to wait for the exit. Grace plus this (10 s) is the
 * whole stop() bound, inside the private-answer queue's 30 s reset budget.
 */
const DEFAULT_KILL_WAIT_MS = 5_000;
/** The only parent variables the model server gets. */
const LLAMA_SERVER_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

/** The model server's whole environment: a short allow-list plus its own settings. */
export function llamaServerEnvironment(
  parent: Record<string, string | undefined>,
  alias: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of LLAMA_SERVER_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env.LLAMA_ARG_HOST = '127.0.0.1';
  env.LLAMA_ARG_ALIAS = alias;
  return env;
}

/**
 * Threads for the built-in model: half the machine's logical cores, at most
 * four, at least one. On Apple silicon the model runs on the GPU, so these
 * threads mostly feed it; on CPU-only hosts they bound how much of the machine
 * a private answer may take.
 */
export function builtInReasoningThreads(parallelism = availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(parallelism / 2)));
}

export function llamaServerArguments(launch: LlamaServerLaunch, port: number, tokenFile: string): string[] {
  return [
    '--model', launch.modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--api-key-file', tokenFile,
    '--ctx-size', String(launch.contextTokens),
    '--parallel', '1',
    // Small prompt batches make an abandoned call stop reading its prompt
    // within about 0.2 s instead of up to a whole 2,048-token batch (5-6 s),
    // with no measured cost to ordinary answers. See
    // docs/design/consult-m0-measurement.md.
    '--batch-size', '64',
    '--ubatch-size', '64',
    '--threads', String(launch.threads),
    '--threads-batch', String(launch.threads),
    '--n-gpu-layers', launch.gpu ? '999' : '0',
    '--prio', '-1',
    // Answers are a single JSON object; the analyst prompt asks for no hidden
    // reasoning, and thinking tokens would multiply latency on a small model.
    '--reasoning', 'off',
    '--no-webui',
    '--cache-ram', '0',
    '--no-slots',
    '--log-disable',
    // The server also unloads the model itself when idle, so even a process
    // orphaned by a crashed parent gives the model's memory back.
    ...(launch.idleShutdownSeconds > 0 ? ['--sleep-idle-seconds', String(launch.idleShutdownSeconds)] : []),
  ];
}

export function createLlamaServerHandle(
  launch: LlamaServerLaunch,
  options: {
    spawnImpl?: typeof spawn;
    fetchImpl?: typeof fetch;
    /** The parent environment the allow-list reads; defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** SIGTERM to SIGKILL on stop (default 5 s). */
    stopGraceMs?: number;
    /** After SIGKILL, how long stop() waits for the exit before it rejects (default 5 s). */
    killWaitMs?: number;
    /**
     * Stop with SIGKILL at once, never SIGTERM first. The consult writer's
     * server is stopped this way (design frontier-consult-lane.md §A.7, B2):
     * a process that is killed cannot keep the GPU busy finishing a batch.
     */
    immediateKill?: boolean;
  } = {},
): LlamaServerHandle {
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
  const immediateKill = options.immediateKill === true;
  // Every process is tracked by its ChildProcess object and exit promise,
  // never by a bare pid, so a signal can never reach a recycled pid.
  //
  // The child stays in the worker's process group (detached: false). When
  // the engine supervisor stops the worker it signals that whole group
  // (SIGTERM, then SIGKILL), so the model server goes with it even if this
  // code never runs. Not guaranteed: if the worker is SIGKILLed on its own
  // (no group signal, no exit hook), the model server is orphaned until it
  // is killed or its host restarts; --sleep-idle-seconds still gives its
  // model memory back. llama-server started with --model runs as one
  // process and starts no helpers.
  /** The server being started or serving. */
  let current: ServerProcess | undefined;
  /** Servers told to stop whose exit has not been observed yet. */
  const retiring = new Set<ServerProcess>();
  let endpoint: LlamaServerEndpoint | undefined;
  /** The one in-flight start, shared by every concurrent ensureRunning(). */
  let starting: SharedStart | undefined;
  /** Bumped by every stop(): a start from an older generation never spawns. */
  let generation = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let exitHookInstalled = false;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  /**
   * Takes the current server out of service and starts its termination. It
   * is tracked in `retiring` before anything that could fail runs, so a
   * cleanup error can never leave a live process untracked.
   */
  const retireCurrent = () => {
    const server = current;
    current = undefined;
    endpoint = undefined;
    if (!server) return;
    if (!server.exited) {
      retiring.add(server);
      terminate(server).catch(() => undefined);
    }
    server.cleanupTokenDir();
  };

  /**
   * SIGTERM, then SIGKILL after the grace period; resolves on the observed
   * exit. Shared by concurrent callers. When the process outlives the bound
   * it rejects and stays in `retiring`; the next attempt sends SIGKILL again.
   */
  const terminate = (server: ServerProcess): Promise<void> => {
    if (server.exited) return Promise.resolve();
    server.terminating ??= (async () => {
      if (!server.killed && !immediateKill) {
        server.signal('SIGTERM');
        if (await server.waitExit(stopGraceMs)) return;
      }
      server.killed = true;
      server.signal('SIGKILL');
      if (await server.waitExit(killWaitMs)) return;
      throw new LlamaServerStopError(
        `The built-in model server (pid ${server.pid ?? 'unknown'}) has not exited ${Math.round((stopGraceMs + killWaitMs) / 1000)}s after it was told to stop.`,
      );
    })().catch((error: unknown) => {
      server.terminating = undefined;
      throw error;
    });
    return server.terminating;
  };

  /** Waits (bounded) until every retiring server has exited. */
  const awaitRetired = async (): Promise<void> => {
    const results = await Promise.allSettled([...retiring].map((server) => terminate(server)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  };

  const stopAll = async (): Promise<void> => {
    clearIdle();
    generation += 1;
    const superseded = starting;
    starting = undefined;
    superseded?.controller.abort(new LlamaServerStartError(STOPPED_WHILE_STARTING));
    retireCurrent();
    await awaitRetired();
  };

  const armIdle = () => {
    clearIdle();
    if (launch.idleShutdownSeconds <= 0 || !current) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      stopAll().catch(() => undefined);
    }, launch.idleShutdownSeconds * 1000);
    idleTimer.unref?.();
  };

  const start = async (startGeneration: number, signal?: AbortSignal): Promise<LlamaServerEndpoint> => {
    const superseded = () => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new LlamaServerStartError('The request was cancelled.');
      }
      if (generation !== startGeneration) throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
    };
    // Cancelled before it began: nothing is created, so nothing is left unobserved.
    superseded();
    // Never two model servers at once: an earlier one must be confirmed gone.
    // The wait is observed here whatever abortable() does with it.
    const retired = awaitRetired();
    retired.catch(() => undefined);
    try {
      await abortable(retired, signal);
    } catch (error) {
      superseded();
      throw new LlamaServerStillExitingError(
        `A previous built-in model server has not exited yet, so a new one was not started. ${error instanceof Error ? error.message : ''}`.trim(),
      );
    }
    superseded();
    const port = await freeLoopbackPort();
    superseded();
    const token = randomBytes(24).toString('base64url');
    const alias = `olympus-${randomBytes(12).toString('hex')}`;
    const tokenDir = mkdtempSync(join(tmpdir(), 'olympus-built-in-model-'));
    const tokenFile = join(tokenDir, 'token');
    let spawnedProcess: ChildProcess;
    try {
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      spawnedProcess = spawnImpl(launch.serverPath, llamaServerArguments(launch, port, tokenFile), {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: llamaServerEnvironment(options.env ?? process.env, alias),
        detached: false,
      });
    } catch (error) {
      removeTokenDir(tokenDir);
      throw error;
    }
    const spawned = trackServerProcess(spawnedProcess, tokenDir, (server) => {
      retiring.delete(server);
      if (current === server) {
        current = undefined;
        endpoint = undefined;
      }
    });
    current = spawned;
    let stderrTail = '';
    spawnedProcess.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_000);
    });
    if (spawned.pid !== undefined) {
      try {
        setPriority(spawned.pid, 10);
      } catch {
        // --prio -1 already lowers the server's own threads.
      }
    }
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      // The process is leaving and cannot wait to escalate; llama-server has
      // nothing to flush (no slot or prompt cache is saved), so SIGKILL.
      process.once('exit', () => {
        for (const server of [current, ...retiring]) {
          server?.signal('SIGKILL');
          server?.cleanupTokenDir();
        }
      });
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + launch.startupTimeoutMs;
    const fail = (error: Error): never => {
      if (current === spawned) retireCurrent();
      throw error;
    };
    for (;;) {
      if (signal?.aborted) {
        fail(signal.reason instanceof Error ? signal.reason : new LlamaServerStartError('The request was cancelled.'));
      }
      if (current !== spawned || spawned.exited) {
        if (current === spawned) current = undefined;
        if (generation !== startGeneration) throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
        throw new LlamaServerStartError(
          `The built-in model server exited while starting.${stderrTail ? ` ${lastLine(stderrTail)}` : ''}`,
        );
      }
      if (await healthy(fetchImpl, baseUrl)) {
        if (current !== spawned) continue;
        if (await servesAlias(fetchImpl, baseUrl, token, alias)) break;
        // Something answers on the port but it is not this child: another
        // process took the port before the child could bind it.
        fail(new LlamaServerStartError('The built-in model server\'s port was taken by another process; it will start again on a new port.'));
      }
      if (Date.now() > deadline) {
        fail(new LlamaServerStartError(`The built-in model server did not load within ${Math.round(launch.startupTimeoutMs / 1000)}s.`));
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    // Cancelled or stopped while the identity check ran: never hand out an endpoint.
    if (current !== spawned || spawned.exited) {
      throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
    }
    if (signal?.aborted) {
      fail(signal.reason instanceof Error ? signal.reason : new LlamaServerStartError('The request was cancelled.'));
    }
    endpoint = { baseUrl, token };
    return endpoint;
  };

  return {
    async ensureRunning(signal) {
      // An already-cancelled caller never gets a warm endpoint.
      if (signal?.aborted) throw callerCancelled(signal.reason);
      clearIdle();
      if (endpoint && current && !current.exited) return endpoint;
      // A request made before a stop() is superseded by it, like any start.
      const callerGeneration = generation;
      // Never join a start that was cancelled (every earlier caller gave up):
      // wait for it to settle, which retires its child, then start afresh.
      while (starting?.controller.signal.aborted) {
        const cancelled = starting;
        try {
          await abortable(cancelled.promise.then(() => undefined, () => undefined), signal);
        } catch {
          throw callerCancelled(signal?.reason);
        }
        if (generation !== callerGeneration) throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
        if (starting === cancelled) starting = undefined;
        if (endpoint && current && !current.exited) return endpoint;
      }
      if (!starting) {
        const controller = new AbortController();
        const shared: SharedStart = {
          controller,
          waiters: 0,
          promise: start(generation, controller.signal).finally(() => {
            if (starting === shared) starting = undefined;
          }),
        };
        // Every caller may abort and walk away; the shared start is always observed.
        shared.promise.catch(() => undefined);
        starting = shared;
      }
      const shared = starting;
      // A caller without a signal waits for the outcome; the start is never
      // cancelled under it.
      if (!signal) {
        shared.waiters = Number.POSITIVE_INFINITY;
        return shared.promise;
      }
      shared.waiters += 1;
      try {
        return await abortable(shared.promise, signal);
      } catch (error) {
        // Each caller observes its own signal. The start itself is cancelled
        // only when every caller waiting on it has gone.
        if (signal.aborted) {
          shared.waiters -= 1;
          if (shared.waiters <= 0) shared.controller.abort(signal.reason);
          throw callerCancelled(signal.reason);
        }
        throw error;
      }
    },
    touch() {
      armIdle();
    },
    stop() {
      return stopAll();
    },
    get pid() {
      return current?.pid;
    },
  };
}

/** One spawned model server: its exit is observed once and shared. */
interface ServerProcess {
  readonly pid: number | undefined;
  readonly exited: boolean;
  /** Whether SIGKILL has been sent. */
  killed: boolean;
  /** The in-flight termination, shared by concurrent stop()/start() callers. */
  terminating: Promise<void> | undefined;
  /** Resolves true on exit, false when `timeoutMs` passes first. */
  waitExit(timeoutMs: number): Promise<boolean>;
  /** Signals this process object only (never a bare pid); a no-op once exited. */
  signal(signal: NodeJS.Signals): void;
  cleanupTokenDir(): void;
}

/**
 * A caller's cancellation, as the AbortError the analyst callers recognise
 * by name; the caller's own reason is kept (as itself, or as the cause).
 */
function callerCancelled(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error(reason instanceof Error ? reason.message : 'The request was cancelled.', { cause: reason });
  error.name = 'AbortError';
  return error;
}

/** One start shared by concurrent ensureRunning() callers. */
interface SharedStart {
  promise: Promise<LlamaServerEndpoint>;
  /** Aborted by stop(), or once every caller waiting on the start has aborted. */
  controller: AbortController;
  /** Callers still waiting; Infinity once one waits without a signal. */
  waiters: number;
}

/**
 * Removes a token directory, best effort: a failure here must never stop a
 * process from being tracked, signalled or seen to exit. Returns whether the
 * directory is gone. A failed removal is tried again only by a later cleanup
 * of the same server (on its exit, or at process exit); after the last one
 * the directory stays in the temp folder, holding the token of a server that
 * is gone. The note carries no path or token.
 */
function removeTokenDir(tokenDir: string): boolean {
  try {
    rmSync(tokenDir, { recursive: true, force: true });
    return true;
  } catch {
    console.warn('Olympus built-in model: could not remove a model server token directory.');
    return false;
  }
}

function trackServerProcess(
  child: ChildProcess,
  tokenDir: string,
  onExit: (server: ServerProcess) => void,
): ServerProcess {
  let exited = child.exitCode !== null || child.signalCode !== null;
  let tokenDirPresent = true;
  /** Pending waitExit() calls; each removes itself when it settles. */
  const exitWaiters = new Set<() => void>();
  const server: ServerProcess = {
    pid: child.pid,
    get exited() {
      return exited;
    },
    killed: false,
    terminating: undefined,
    waitExit(timeoutMs) {
      if (exited) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const settle = (value: boolean) => {
          clearTimeout(timer);
          exitWaiters.delete(onExited);
          resolve(value);
        };
        const onExited = () => settle(true);
        const timer = setTimeout(() => settle(false), timeoutMs);
        exitWaiters.add(onExited);
      });
    },
    signal(signal) {
      if (exited) return;
      try {
        child.kill(signal);
      } catch {
        // Already gone between the check and the signal.
      }
    },
    cleanupTokenDir() {
      if (!tokenDirPresent) return;
      tokenDirPresent = !removeTokenDir(tokenDir);
    },
  };
  const finish = () => {
    if (exited) return;
    exited = true;
    // Exit is recorded and announced before any filesystem work.
    for (const waiter of [...exitWaiters]) waiter();
    onExit(server);
    server.cleanupTokenDir();
  };
  child.once('exit', finish);
  // A spawn that failed outright (no pid) never runs and may never emit exit.
  child.once('error', () => {
    if (child.pid === undefined) finish();
  });
  if (exited) server.cleanupTokenDir();
  return server;
}

/** `promise`, or the signal's abort reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function healthy(fetchImpl: typeof fetch, baseUrl: string): Promise<boolean> {
  try {
    // /health is the one route llama-server serves without the API key; it
    // answers 503 while the model is loading and 200 once it can serve.
    const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the server on `baseUrl` is the child started with `alias`. The
 * alias reaches the child through its environment only, so a different
 * process on the port cannot echo it.
 */
async function servesAlias(fetchImpl: typeof fetch, baseUrl: string, token: string, alias: string): Promise<boolean> {
  try {
    // The server's bearer token rides this request: a redirect is refused
    // (and reads as "not our server"), never followed.
    const response = await fetchModelEndpoint(fetchImpl, `${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const text = await response.text();
    return text.length <= 1_000_000 && text.includes(alias);
  } catch {
    return false;
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new LlamaServerStartError('No free loopback port.'))));
    });
  });
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

