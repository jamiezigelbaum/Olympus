/**
 * The built-in model's llama-server lifecycle: stop() and reset resolve only
 * once the process has exited (SIGTERM, then SIGKILL), within a bound, and a
 * new server never starts while an earlier one is still alive. Stand-in
 * server scripts play llama-server; no real binary is needed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { stopBuiltInModelOnShutdown } from '../src/workers/email-source/server.ts';
import { readBuiltInReasoningStatus, reportBuiltInReasoningState } from '../src/workers/source-index/built-in-reasoning/install.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import {
  createLlamaServerHandle,
  LlamaServerStartError,
  LlamaServerStillExitingError,
  LlamaServerStopError,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../src/workers/source-index/built-in-reasoning/server.ts';

const temporaryDirectories: string[] = [];
const handles: LlamaServerHandle[] = [];
const realChildren: ChildProcess[] = [];
/** Token directories a test made unremovable; restored and removed after it. */
const lockedDirs: string[] = [];

afterEach(async () => {
  for (const dir of lockedDirs.splice(0)) {
    if (existsSync(dir)) chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  // Kill first: a stand-in that ignores SIGTERM would otherwise hold stop() for its whole grace period.
  for (const child of realChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const handle of handles.splice(0)) await handle.stop().catch(() => undefined);
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Mode = 'prompt' | 'ignore-term' | 'exit-on-release';

/**
 * A stand-in llama-server. `prompt` exits on SIGTERM; `ignore-term` ignores
 * it (only SIGKILL stops it); `exit-on-release` notes SIGTERM and keeps
 * serving until GET /release, so a test controls exactly when it exits.
 * GET /state reports whether SIGTERM arrived.
 */
function standInServer(mode: Mode): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-llama-lifecycle-test-'));
  temporaryDirectories.push(dir);
  const script = join(dir, 'llama-server');
  writeFileSync(script, `#!/usr/bin/env bun
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const token = (await Bun.file(at('--api-key-file')).text()).trim();
let terminated = false;
if (mode !== 'prompt') process.on('SIGTERM', () => { terminated = true; });
Bun.serve({ hostname: '127.0.0.1', port: Number(at('--port')), fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('{}');
  if (url.pathname === '/state') return Response.json({ terminated });
  if (url.pathname === '/release') { setTimeout(() => process.exit(0), 0); return new Response('bye'); }
  if (request.headers.get('authorization') !== 'Bearer ' + token) return new Response('no', { status: 401 });
  if (url.pathname === '/v1/models') return Response.json({ data: [{ id: process.env.LLAMA_ARG_ALIAS }] });
  return new Response('ok');
} });
`);
  chmodSync(script, 0o755);
  return script;
}

function launchFor(serverPath: string): LlamaServerLaunch {
  return { serverPath, modelPath: '/m.gguf', contextTokens: 1, gpu: false, threads: 1, idleShutdownSeconds: 0, startupTimeoutMs: 30_000 };
}

/** Real spawns, each one and each exit appended to `log` as it happens. */
function recordingSpawn(log: string[]): { spawnImpl: typeof spawn; children: ChildProcess[] } {
  const children: ChildProcess[] = [];
  const spawnImpl = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    realChildren.push(child);
    const n = children.push(child);
    log.push(`spawn ${n}`);
    child.once('exit', () => log.push(`exit ${n}`));
    return child;
  }) as typeof spawn;
  return { spawnImpl, children };
}

function handleFor(mode: Mode, log: string[], extra: { stopGraceMs?: number; killWaitMs?: number } = {}) {
  const { spawnImpl, children } = recordingSpawn(log);
  const handle = createLlamaServerHandle(launchFor(standInServer(mode)), { spawnImpl, ...extra });
  handles.push(handle);
  return { handle, children };
}

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function terminated(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/state`);
    return ((await response.json()) as { terminated: boolean }).terminated;
  } catch {
    return false;
  }
}

describe('stop() waits for the model server to exit', () => {
  test('a server that exits on SIGTERM: stop() resolves after its exit, never before', async () => {
    const log: string[] = [];
    const { handle, children } = handleFor('prompt', log);
    await handle.ensureRunning();
    const pid = handle.pid;
    expect(pid).toBeNumber();
    await handle.stop();
    log.push('stopped');
    expect(log).toEqual(['spawn 1', 'exit 1', 'stopped']);
    expect(children[0]!.signalCode).toBe('SIGTERM');
    expect(handle.pid).toBeUndefined();
  }, 60_000);

  test('a server that ignores SIGTERM is SIGKILLed, and stop() resolves only after it exits', async () => {
    const log: string[] = [];
    const { handle, children } = handleFor('ignore-term', log, { stopGraceMs: 300, killWaitMs: 10_000 });
    const endpoint = await handle.ensureRunning();
    const stopped = handle.stop().then(() => log.push('stopped'));
    await until(() => terminated(endpoint.baseUrl));
    await stopped;
    expect(log).toEqual(['spawn 1', 'exit 1', 'stopped']);
    expect(children[0]!.signalCode).toBe('SIGKILL');
  }, 60_000);
});

describe('a new server never overlaps an old one', () => {
  test('a server slow to exit: ensureRunning starts the next one only after the old exit is observed', async () => {
    const log: string[] = [];
    const { handle, children } = handleFor('exit-on-release', log, { stopGraceMs: 60_000 });
    const first = await handle.ensureRunning();
    const stopped = handle.stop().then(() => log.push('stopped'));
    await until(() => terminated(first.baseUrl));
    const next = handle.ensureRunning().then((endpoint) => {
      log.push('running again');
      return endpoint;
    });
    // The old process is alive and told to stop; nothing new may start yet.
    expect(await terminated(first.baseUrl)).toBe(true);
    expect(children).toHaveLength(1);
    expect(handle.pid).toBeUndefined();
    await fetch(`${first.baseUrl}/release`);
    const second = await next;
    await stopped;
    expect(second.baseUrl).not.toBe(first.baseUrl);
    expect(log.indexOf('exit 1')).toBeGreaterThan(-1);
    expect(log.indexOf('exit 1')).toBeLessThan(log.indexOf('spawn 2'));
    expect(log.indexOf('exit 1')).toBeLessThan(log.indexOf('stopped'));
    expect(children).toHaveLength(2);
  }, 60_000);

  test('concurrent stop and ensureRunning calls: one kill, one new spawn, shared endpoint', async () => {
    const log: string[] = [];
    const { handle, children } = handleFor('prompt', log);
    await handle.ensureRunning();
    const [, a, b] = await Promise.all([handle.stop(), handle.ensureRunning(), handle.ensureRunning()]);
    expect(a).toEqual(b);
    expect(children).toHaveLength(2);
    expect(log.slice(0, 3)).toEqual(['spawn 1', 'exit 1', 'spawn 2']);
    expect(handle.pid).toBe(children[1]!.pid);
    await Promise.all([handle.stop(), handle.stop()]);
    expect(log).toEqual(['spawn 1', 'exit 1', 'spawn 2', 'exit 2']);
  }, 60_000);

  test('stop() while a server is still starting cancels that start and leaves nothing running', async () => {
    const log: string[] = [];
    const { handle } = handleFor('prompt', log);
    const starting = handle.ensureRunning();
    const outcome = starting.then(() => 'started', (error: unknown) => error);
    await handle.stop();
    const result = await outcome;
    expect(result).toBeInstanceOf(LlamaServerStartError);
    expect(handle.pid).toBeUndefined();
    // Anything spawned has exited by the time stop() resolved.
    expect(log.filter((entry) => entry.startsWith('spawn')).length).toBe(log.filter((entry) => entry.startsWith('exit')).length);
  }, 60_000);
});

/**
 * A fake model server process. It exits on the signals in `exitsOn` (none:
 * it survives even SIGKILL until the test calls exitNow()).
 */
class FakeChild extends EventEmitter {
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  constructor(private readonly exitsOn: readonly NodeJS.Signals[]) {
    super();
  }
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitsOn.includes(signal)) queueMicrotask(() => this.exitNow(signal));
    return true;
  }
  exitNow(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

interface FakeHarnessOptions {
  exitsOn?: NodeJS.Signals[];
  /** Whether /health answers 200 (default: always). */
  health?: () => boolean;
  /** Runs while the identity check (/v1/models) is in flight. */
  onIdentity?: () => void | Promise<void>;
  /** Runs inside spawn, with the token file path. */
  onSpawn?: (tokenFile: string) => void;
  stopGraceMs?: number;
  killWaitMs?: number;
  idleShutdownSeconds?: number;
}

function fakeHarness(options: FakeHarnessOptions = {}) {
  const spawned: FakeChild[] = [];
  const aliases: string[] = [];
  const spawnImpl = ((_command: string, args: readonly string[], spawnOptions: { env?: Record<string, string> }) => {
    aliases.push(spawnOptions.env?.LLAMA_ARG_ALIAS ?? '');
    options.onSpawn?.(args[args.indexOf('--api-key-file') + 1]!);
    const child = new FakeChild(options.exitsOn ?? []);
    spawned.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/health') {
      return (options.health?.() ?? true) ? new Response('{}') : new Response('loading', { status: 503 });
    }
    await options.onIdentity?.();
    return Response.json({ data: [{ id: aliases[aliases.length - 1] }] });
  }) as typeof fetch;
  const handle = createLlamaServerHandle(
    { ...launchFor('/unused'), idleShutdownSeconds: options.idleShutdownSeconds ?? 0 },
    { spawnImpl, fetchImpl, stopGraceMs: options.stopGraceMs ?? 20, killWaitMs: options.killWaitMs ?? 50 },
  );
  handles.push(handle);
  return { handle, spawned };
}

describe('overall stop bound', () => {
  test('a process that outlives SIGKILL fails stop() with a typed error, and no new server starts until it is gone', async () => {
    const { handle, spawned } = fakeHarness();
    await handle.ensureRunning();
    const startedAt = Date.now();
    await expect(handle.stop()).rejects.toBeInstanceOf(LlamaServerStopError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(spawned[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // Refused, not started beside it; the retry sends SIGKILL again.
    const refused = await handle.ensureRunning().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LlamaServerStillExitingError);
    expect((refused as Error).message).toContain('has not exited yet');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    // Once its exit is observed, the next request starts a fresh server.
    spawned[0]!.exitNow();
    await handle.ensureRunning();
    expect(spawned).toHaveLength(2);
  }, 30_000);

  test('a token directory that cannot be removed never untracks a live server', async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const { handle, spawned } = fakeHarness({
        onSpawn: (tokenFile) => {
          // Make the token file unremovable: cleanup fails with EACCES.
          lockedDirs.push(dirname(tokenFile));
          chmodSync(dirname(tokenFile), 0o500);
        },
      });
      await handle.ensureRunning();
      await expect(handle.stop()).rejects.toBeInstanceOf(LlamaServerStopError);
      // It was still signalled, and it is still tracked: no second server.
      expect(spawned[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
      await expect(handle.ensureRunning()).rejects.toBeInstanceOf(LlamaServerStillExitingError);
      expect(spawned).toHaveLength(1);
      spawned[0]!.exitNow();
      await handle.ensureRunning();
      expect(spawned).toHaveLength(2);
    } finally {
      console.warn = warn;
    }
  }, 30_000);

  test('an abort while waiting for an old server to exit rejects at once with the abort reason', async () => {
    const { handle, spawned } = fakeHarness({ stopGraceMs: 60_000, killWaitMs: 60_000 });
    await handle.ensureRunning();
    const stopping = handle.stop().catch(() => undefined);
    const abort = new AbortController();
    const next = handle.ensureRunning(abort.signal);
    abort.abort(new Error('cancelled by the queue'));
    await expect(next).rejects.toThrow('cancelled by the queue');
    expect(spawned).toHaveLength(1);
    spawned[0]!.exitNow();
    await stopping;
  }, 30_000);

  test('a start with an already-aborted signal while an old server times out leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { handle, spawned } = fakeHarness({ stopGraceMs: 20, killWaitMs: 50 });
      await handle.ensureRunning();
      const stopping = handle.stop().then(() => 'stopped', (error: unknown) => error);
      const abort = new AbortController();
      abort.abort(new Error('already cancelled'));
      await expect(handle.ensureRunning(abort.signal)).rejects.toThrow('already cancelled');
      expect(await stopping).toBeInstanceOf(LlamaServerStopError);
      // Give any stray rejection its turn to surface.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      spawned[0]!.exitNow();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);
});

describe('cancellation and crashes after spawn', () => {
  test('an abort during the health check stops the spawned server; the next start waits for its exit', async () => {
    let healthy = false;
    const { handle, spawned } = fakeHarness({ exitsOn: ['SIGTERM'], health: () => healthy });
    const abort = new AbortController();
    const first = handle.ensureRunning(abort.signal);
    await until(() => spawned.length === 1);
    abort.abort(new Error('caller gone'));
    await expect(first).rejects.toThrow('caller gone');
    await until(() => spawned[0]!.signalCode !== null);
    expect(spawned[0]!.signals).toEqual(['SIGTERM']);
    healthy = true;
    await handle.ensureRunning();
    expect(spawned).toHaveLength(2);
  }, 30_000);

  test('a server that crashes during the health check fails the start, and the next start spawns fresh', async () => {
    const { handle, spawned } = fakeHarness({ exitsOn: ['SIGTERM'], health: () => spawned.length > 1 });
    const first = handle.ensureRunning();
    await until(() => spawned.length === 1);
    spawned[0]!.exitNow('SIGSEGV');
    await expect(first).rejects.toThrow('exited while starting');
    expect(handle.pid).toBeUndefined();
    await handle.ensureRunning();
    expect(spawned).toHaveLength(2);
  }, 30_000);

  test('an abort during the identity check never hands out the endpoint', async () => {
    const abort = new AbortController();
    const { handle, spawned } = fakeHarness({ exitsOn: ['SIGTERM'], onIdentity: () => abort.abort(new Error('caller gone')) });
    await expect(handle.ensureRunning(abort.signal)).rejects.toThrow('caller gone');
    await until(() => spawned[0]!.signalCode !== null);
    expect(spawned[0]!.signals).toEqual(['SIGTERM']);
    expect(handle.pid).toBeUndefined();
  }, 30_000);

  test('a stale start whose identity check completes after stop() is discarded', async () => {
    let stopped: Promise<void> | undefined;
    let handleRef: LlamaServerHandle | undefined;
    const { handle, spawned } = fakeHarness({
      exitsOn: ['SIGTERM'],
      onIdentity: () => {
        if (!stopped) stopped = handleRef!.stop();
      },
    });
    handleRef = handle;
    const outcome = await handle.ensureRunning().catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(LlamaServerStartError);
    expect((outcome as Error).message).toContain('stopped while starting');
    await stopped;
    expect(spawned[0]!.signals).toEqual(['SIGTERM']);
    expect(handle.pid).toBeUndefined();
    // The next start is a fresh one, after the old exit.
    await handle.ensureRunning();
    expect(spawned).toHaveLength(2);
  }, 30_000);
});

describe('per-caller cancellation of a shared start', () => {
  test('one caller aborting does not cancel the start another caller still waits for', async () => {
    let healthy = false;
    const { handle, spawned } = fakeHarness({ exitsOn: ['SIGTERM'], health: () => healthy });
    const abort = new AbortController();
    const a = handle.ensureRunning(abort.signal);
    const b = handle.ensureRunning();
    await until(() => spawned.length === 1);
    abort.abort(new Error('a gave up'));
    await expect(a).rejects.toThrow('a gave up');
    healthy = true;
    const endpoint = await b;
    expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.signals).toEqual([]);
  }, 30_000);

  test('when every caller aborts, the shared start is cancelled and its server stopped', async () => {
    const { handle, spawned } = fakeHarness({ exitsOn: ['SIGTERM'], health: () => false });
    const one = new AbortController();
    const two = new AbortController();
    const a = handle.ensureRunning(one.signal);
    const b = handle.ensureRunning(two.signal);
    await until(() => spawned.length === 1);
    one.abort(new Error('one gone'));
    await expect(a).rejects.toThrow('one gone');
    expect(spawned[0]!.signals).toEqual([]);
    two.abort(new Error('two gone'));
    await expect(b).rejects.toThrow('two gone');
    await until(() => spawned[0]!.signalCode !== null);
    expect(spawned[0]!.signals).toEqual(['SIGTERM']);
  }, 30_000);
});

describe('idle shutdown versus a new request', () => {
  test('a request arriving while the idle shutdown waits for the exit starts the next server only after it', async () => {
    const log: string[] = [];
    const { spawnImpl, children } = recordingSpawn(log);
    const handle = createLlamaServerHandle(
      { ...launchFor(standInServer('exit-on-release')), idleShutdownSeconds: 1 },
      { spawnImpl, stopGraceMs: 60_000 },
    );
    handles.push(handle);
    const first = await handle.ensureRunning();
    handle.touch();
    await until(() => terminated(first.baseUrl));
    const next = handle.ensureRunning();
    expect(children).toHaveLength(1);
    await fetch(`${first.baseUrl}/release`);
    await next;
    expect(log.indexOf('exit 1')).toBeGreaterThan(-1);
    expect(log.indexOf('exit 1')).toBeLessThan(log.indexOf('spawn 2'));
  }, 60_000);
});

describe('callers of the handle', () => {
  test('a refused restart (old server still exiting) leaves the model available, and the next request starts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-built-in-retry-test-'));
    temporaryDirectories.push(dir);
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    let refuse = true;
    const server: LlamaServerHandle = {
      async ensureRunning() {
        if (refuse) throw new LlamaServerStillExitingError('A previous built-in model server has not exited yet.');
        return { baseUrl: 'http://127.0.0.1:1', token: 't' };
      },
      touch() {},
      async stop() {},
      pid: undefined,
    };
    const model = createBuiltInAnalystModel({
      env,
      model: QWEN35_4B,
      install: async () => ({ modelPath: '/m.gguf', serverPath: '/llama-server', gpu: true }),
      createServer: () => server,
      fetchImpl: (async () => Response.json({ choices: [{ message: { content: '{}' } }] })) as unknown as typeof fetch,
      waitForInstall: true,
    });
    await model.prepare();
    await expect(model.complete({ system: 's', prompt: 'p', localOnly: true })).rejects.toThrow();
    expect(readBuiltInReasoningStatus(QWEN35_4B, env).state).toBe('ready');
    refuse = false;
    await expect(model.complete({ system: 's', prompt: 'p', localOnly: true })).resolves.toMatchObject({ text: '{}' });
  });

  test('"Try again" (prepare) re-arms a cached install after a runtime failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-built-in-retry-test-'));
    temporaryDirectories.push(dir);
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    let installs = 0;
    const model = createBuiltInAnalystModel({
      env,
      model: QWEN35_4B,
      install: async () => {
        installs += 1;
        reportBuiltInReasoningState({ model: QWEN35_4B, env }, 'ready');
        return { modelPath: '/m.gguf', serverPath: '/llama-server', gpu: true };
      },
      createServer: () => ({ async ensureRunning() { return { baseUrl: 'http://127.0.0.1:1', token: 't' }; }, touch() {}, async stop() {}, pid: undefined }),
      waitForInstall: true,
    });
    await model.prepare();
    reportBuiltInReasoningState({ model: QWEN35_4B, env }, 'failed', { reason: 'runtime_load_failed', message: 'did not load' });
    await model.prepare();
    expect(readBuiltInReasoningStatus(QWEN35_4B, env).state).toBe('ready');
    expect(installs).toBe(1);
    // Other failures are not papered over.
    reportBuiltInReasoningState({ model: QWEN35_4B, env }, 'failed', { reason: 'checksum_mismatch', message: 'bad' });
    await model.prepare();
    expect(readBuiltInReasoningStatus(QWEN35_4B, env).state).toBe('failed');
  });

  test('worker shutdown stops the built-in model and swallows a failed stop', async () => {
    let stops = 0;
    stopBuiltInModelOnShutdown({ stop: async () => { stops += 1; } });
    expect(stops).toBe(1);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      stopBuiltInModelOnShutdown({ stop: async () => { throw new LlamaServerStopError('stuck'); } });
      stopBuiltInModelOnShutdown({ stop: () => { throw new Error('sync'); } });
      stopBuiltInModelOnShutdown(undefined);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
