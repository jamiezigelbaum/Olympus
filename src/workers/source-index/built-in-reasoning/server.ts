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
  /** Starts the process if needed and resolves once it answers /health. */
  ensureRunning(signal?: AbortSignal): Promise<LlamaServerEndpoint>;
  /** Marks a request finished, re-arming the idle shutdown. */
  touch(): void;
  stop(): Promise<void>;
  readonly pid: number | undefined;
}

export class LlamaServerStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlamaServerStartError';
  }
}

const HEALTH_POLL_MS = 250;
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
  } = {},
): LlamaServerHandle {
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  let child: ChildProcess | undefined;
  let endpoint: LlamaServerEndpoint | undefined;
  let starting: Promise<LlamaServerEndpoint> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let tokenDir: string | undefined;
  let exitHookInstalled = false;

  const cleanupTokenDir = () => {
    if (tokenDir) rmSync(tokenDir, { recursive: true, force: true });
    tokenDir = undefined;
  };

  const killChild = () => {
    const current = child;
    child = undefined;
    endpoint = undefined;
    if (current && current.exitCode === null && current.signalCode === null) {
      current.kill('SIGTERM');
    }
    cleanupTokenDir();
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (launch.idleShutdownSeconds <= 0 || !child) return;
    idleTimer = setTimeout(killChild, launch.idleShutdownSeconds * 1000);
    idleTimer.unref?.();
  };

  const start = async (signal?: AbortSignal): Promise<LlamaServerEndpoint> => {
    const port = await freeLoopbackPort();
    const token = randomBytes(24).toString('base64url');
    const alias = `olympus-${randomBytes(12).toString('hex')}`;
    tokenDir = mkdtempSync(join(tmpdir(), 'olympus-built-in-model-'));
    const tokenFile = join(tokenDir, 'token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const spawned = spawnImpl(launch.serverPath, llamaServerArguments(launch, port, tokenFile), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: llamaServerEnvironment(options.env ?? process.env, alias),
      detached: false,
    });
    child = spawned;
    let stderrTail = '';
    spawned.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_000);
    });
    spawned.on('exit', () => {
      if (child === spawned) {
        child = undefined;
        endpoint = undefined;
        cleanupTokenDir();
      }
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
      process.once('exit', killChild);
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + launch.startupTimeoutMs;
    for (;;) {
      if (signal?.aborted) {
        killChild();
        throw signal.reason instanceof Error ? signal.reason : new LlamaServerStartError('The request was cancelled.');
      }
      if (child !== spawned) {
        throw new LlamaServerStartError(
          `The built-in model server exited while starting.${stderrTail ? ` ${lastLine(stderrTail)}` : ''}`,
        );
      }
      if (await healthy(fetchImpl, baseUrl)) {
        if (await servesAlias(fetchImpl, baseUrl, token, alias)) break;
        // Something answers on the port but it is not this child: another
        // process took the port before the child could bind it.
        killChild();
        throw new LlamaServerStartError('The built-in model server\'s port was taken by another process; it will start again on a new port.');
      }
      if (Date.now() > deadline) {
        killChild();
        throw new LlamaServerStartError(`The built-in model server did not load within ${Math.round(launch.startupTimeoutMs / 1000)}s.`);
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    endpoint = { baseUrl, token };
    return endpoint;
  };

  return {
    async ensureRunning(signal) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      if (endpoint && child) return endpoint;
      starting ??= start(signal).finally(() => {
        starting = undefined;
      });
      return starting;
    },
    touch() {
      armIdle();
    },
    async stop() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      killChild();
    },
    get pid() {
      return child?.pid;
    },
  };
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

