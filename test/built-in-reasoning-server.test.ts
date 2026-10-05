/**
 * The built-in model's llama-server lifecycle: stop() and reset resolve only
 * once the process has exited (SIGTERM, then SIGKILL), within a bound, and a
 * new server never starts while an earlier one is still alive. Stand-in
 * server scripts play llama-server; no real binary is needed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLlamaServerHandle,
  LlamaServerStartError,
  LlamaServerStopError,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../src/workers/source-index/built-in-reasoning/server.ts';

const temporaryDirectories: string[] = [];
const handles: LlamaServerHandle[] = [];
const realChildren: ChildProcess[] = [];

afterEach(async () => {
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

/** A model server that survives even SIGKILL until the test lets it exit. */
class UnkillableChild extends EventEmitter {
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  exitNow(): void {
    this.signalCode = 'SIGKILL';
    this.emit('exit', null, 'SIGKILL');
  }
}

describe('overall stop bound', () => {
  test('a process that outlives SIGKILL fails stop() with a typed error, and no new server starts until it is gone', async () => {
    const spawned: UnkillableChild[] = [];
    const aliases: string[] = [];
    const spawnImpl = ((_command: string, _args: readonly string[], options: { env?: Record<string, string> }) => {
      aliases.push(options.env?.LLAMA_ARG_ALIAS ?? '');
      const child = new UnkillableChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return new Response('{}');
      return Response.json({ data: [{ id: aliases[aliases.length - 1] }] });
    }) as typeof fetch;
    const handle = createLlamaServerHandle(launchFor('/unused'), { spawnImpl, fetchImpl, stopGraceMs: 20, killWaitMs: 50 });
    handles.push(handle);
    await handle.ensureRunning();
    const startedAt = Date.now();
    await expect(handle.stop()).rejects.toBeInstanceOf(LlamaServerStopError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(spawned[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // Refused, not started beside it; the retry sends SIGKILL again.
    await expect(handle.ensureRunning()).rejects.toThrow('has not exited yet');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    // Once its exit is observed, the next request starts a fresh server.
    spawned[0]!.exitNow();
    await handle.ensureRunning();
    expect(spawned).toHaveLength(2);
  }, 30_000);

  test('an abort while waiting for an old server to exit rejects at once with the abort reason', async () => {
    const spawned: UnkillableChild[] = [];
    const aliases: string[] = [];
    const spawnImpl = ((_command: string, _args: readonly string[], options: { env?: Record<string, string> }) => {
      aliases.push(options.env?.LLAMA_ARG_ALIAS ?? '');
      const child = new UnkillableChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return new Response('{}');
      return Response.json({ data: [{ id: aliases[aliases.length - 1] }] });
    }) as typeof fetch;
    const handle = createLlamaServerHandle(launchFor('/unused'), { spawnImpl, fetchImpl, stopGraceMs: 60_000, killWaitMs: 60_000 });
    handles.push(handle);
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
});
