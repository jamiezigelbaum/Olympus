// The engine split under the worker service's own unit (olympus-worker.service,
// `cli.js __worker-service-run`). There is no engine host on that path, so
// with worker.engineSplit on the unit's process supervises the two processes
// itself: the background first, the front once the background answers ready;
// the front stops first; a background that exits is restarted on the shared
// backoff. These start real child processes (a stand-in for cli.js that
// records what it was started as), so this file is in the deploy lane.
import { afterEach, describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkerForeground } from '../src/cli.ts';
import { engineBackgroundSocketPath } from '../src/core/engine-split.ts';
import { superviseWorkerServiceSplit, workerServiceSplitApplies } from '../src/core/worker-service-split.ts';
import { installWorkerService } from '../src/core/worker-service.ts';
import { workerSetupEnvPath } from '../src/core/worker-auth.ts';
import { waitFor } from './helpers/test-clock.ts';

const CHILD = join(import.meta.dir, 'fixtures', 'worker-service-split-child.ts');
const SUPERVISOR = join(import.meta.dir, 'fixtures', 'worker-service-split-supervisor.ts');
const TOKEN = 'worker-service-split-test-token';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface ChildEvent { role: string; event: 'start' | 'stop'; pid: number; argv?: string[]; socket?: string | null; managed?: string | null; probe?: string | null; signal?: string }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-wss-'));
  const runtime = join(root, 'run');
  mkdirSync(runtime, { mode: 0o700 });
  const events = join(root, 'events.jsonl');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_RUNTIME_DIR: runtime,
    OLYMPUS_MANAGED_WORKER: '1',
    OLYMPUS_WORKER_AUTH_TOKEN: TOKEN,
    EVENTS_PATH: events,
  };
  const read = (): ChildEvent[] => {
    try { return readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ChildEvent); } catch { return []; }
  };
  const signals = new Map<string, () => void>();
  const exits: number[] = [];
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  return { root, env, read, signals, exits };
}

function superviseOptions(context: ReturnType<typeof setup>, log: (line: string) => void = () => {}) {
  return {
    env: context.env,
    runtimePath: process.execPath,
    executablePath: CHILD,
    authToken: TOKEN,
    spawn: (command, args, options) => childProcess.spawn(command, args, options),
    restartDelaysMs: [50],
    readinessPollMs: 20,
    startupTimeoutMs: 10_000,
    stopGraceMs: 5_000,
    signals: { once: (signal, handler) => { context.signals.set(signal, handler); } },
    exit: (code: number) => { context.exits.push(code); },
    log,
    childStdio: 'ignore' as const,
  } satisfies Parameters<typeof superviseWorkerServiceSplit>[0];
}

async function supervise(context: ReturnType<typeof setup>, log?: (line: string) => void) {
  const handle = await superviseWorkerServiceSplit(superviseOptions(context, log));
  cleanups.push(() => handle.stop());
  return handle;
}

/** The unit's process itself, run for real: its own signals, exit and stdio. */
function superviseAsProcess(context: ReturnType<typeof setup>, extraEnv: Record<string, string> = {}) {
  const child = childProcess.spawn(process.execPath, [SUPERVISOR], { env: { ...context.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout!.on('data', (chunk: Buffer) => { output.stdout += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { output.stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    for (const event of context.read()) if (alive(event.pid)) process.kill(event.pid, 'SIGKILL');
  });
  return { child, output, exited };
}


describe('the worker service runs the engine split itself', () => {
  test('background first; the front starts once it is ready, told the background\'s socket', async () => {
    const context = setup();
    await supervise(context);
    const events = await waitFor(() => { const all = context.read(); return all.filter((e) => e.event === 'start').length >= 2 ? all : undefined; });
    const [first, second] = events.filter((e) => e.event === 'start');
    expect(first!.role).toBe('background');
    expect(second!.role).toBe('front');
    const socket = engineBackgroundSocketPath({ env: context.env, platform: 'linux' });
    expect(first!.socket).toBe(socket);
    expect(second!.socket).toBe(socket);
    // Both children run the same entry the unit does, still under the unit's management.
    expect(first!.argv).toEqual(['__worker-service-run']);
    expect(second!.argv).toEqual(['__worker-service-run']);
    expect(first!.managed).toBe('1');
    expect(second!.managed).toBe('1');
  }, 30_000);

  test('a background that exits is started again; the front keeps running', async () => {
    const context = setup();
    await supervise(context);
    const started = await waitFor(() => context.read().filter((e) => e.event === 'start').length >= 2 ? context.read() : undefined);
    const background = started.find((e) => e.role === 'background')!;
    const front = started.find((e) => e.role === 'front')!;
    process.kill(background.pid, 'SIGKILL');
    const again = await waitFor(() => context.read().filter((e) => e.role === 'background' && e.event === 'start').length >= 2 ? context.read() : undefined);
    expect(again.filter((e) => e.role === 'background' && e.event === 'start').at(-1)!.pid).not.toBe(background.pid);
    expect(alive(front.pid)).toBe(true);
    expect(again.filter((e) => e.role === 'front' && e.event === 'start')).toHaveLength(1);
  }, 30_000);

  // Under the unit, an exit 75 used to restart the whole unit, which read
  // worker.env again (EnvironmentFile=). A child restarted by the supervisor
  // must see a credential saved there since, too.
  test('a restarted child gets worker.env as it is now, not as it was when the unit started', async () => {
    const context = setup();
    const envFile = workerSetupEnvPath({ env: context.env });
    mkdirSync(join(envFile, '..'), { recursive: true });
    writeFileSync(envFile, 'SPLIT_PROBE_KEY=old\n', { mode: 0o600 });
    // The unit's EnvironmentFile= put the file's value in the supervisor's environment.
    context.env.SPLIT_PROBE_KEY = 'old';
    await supervise(context);
    const started = await waitFor(() => context.read().filter((e) => e.event === 'start').length >= 2 ? context.read() : undefined);
    expect(started.find((e) => e.role === 'background')!.probe).toBe('old');
    writeFileSync(envFile, 'SPLIT_PROBE_KEY=new\n', { mode: 0o600 });
    process.kill(started.find((e) => e.role === 'background')!.pid, 'SIGKILL');
    const again = await waitFor(() => context.read().filter((e) => e.role === 'background' && e.event === 'start').at(1));
    expect(again.probe).toBe('new');
  }, 30_000);

  test('a stop of the unit\'s process alone stops both children, then exits', async () => {
    const context = setup();
    await supervise(context);
    const started = await waitFor(() => context.read().filter((e) => e.event === 'start').length >= 2 ? context.read() : undefined);
    context.signals.get('SIGTERM')!();
    await waitFor(() => context.exits.length > 0 ? true : undefined);
    expect(context.exits).toEqual([143]);
    const stops = context.read().filter((e) => e.event === 'stop').map((e) => e.role);
    expect(stops.sort()).toEqual(['background', 'front']);
    for (const child of started) expect(alive(child.pid)).toBe(false);
  }, 30_000);
});

describe('a busy background is never judged dead (gate7, 13 Nov)', () => {
  // The class behind every split install failure on the owner's data: the
  // background's only thread sits in one long synchronous SQLite call (a store
  // backup, row checks, a first-open migration) and neither answers nor
  // writes progress. Here it blocks for 60 s in its boot work and 60 s again
  // just after it answers ready, each far past the 10 s start window. Neither
  // process may be replaced, and the front, which waits on the background,
  // must end up serving.
  test('a background blocked for 60 s at boot and 60 s after ready keeps running, and the front serves', async () => {
    const context = setup();
    context.env.BLOCK_BOOT_MS = '60000';
    context.env.BLOCK_AFTER_READY_MS = '60000';
    context.env.FRONT_WAITS = '1';
    await supervise(context);
    const events = await waitFor(() => {
      const all = context.read();
      return all.some((e) => (e.event as string) === 'serving' || (e.event as string) === 'gave-up') ? all : undefined;
    }, { timeoutMs: 170_000, intervalMs: 500 });
    expect(events.filter((e) => (e.event as string) === 'gave-up')).toEqual([]);
    expect(events.filter((e) => (e.event as string) === 'blocked')).toHaveLength(2);
    const starts = events.filter((e) => e.event === 'start');
    expect(starts.map((e) => e.role)).toEqual(['background', 'front']);
    expect(events.filter((e) => e.event === 'stop')).toEqual([]);
  }, 180_000);

  test('a background that exits part way through its boot is replaced, and the front serves once the new one is done', async () => {
    const context = setup();
    context.env.BLOCK_BOOT_MS = '3000';
    context.env.EXIT_DURING_BOOT = '1';
    context.env.FRONT_WAITS = '1';
    await supervise(context);
    const events = await waitFor(() => {
      const all = context.read();
      return all.some((e) => (e.event as string) === 'serving') ? all : undefined;
    }, { timeoutMs: 30_000, intervalMs: 100 });
    const backgrounds = events.filter((e) => e.event === 'start' && e.role === 'background');
    expect(backgrounds).toHaveLength(2);
    expect(events.filter((e) => (e.event as string) === 'exit')).toHaveLength(1);
    expect(events.find((e) => (e.event as string) === 'serving')?.role).toBe('front');
  }, 60_000);
});

describe('a unit stop signals every process at once (KillMode=control-group)', () => {
  test('the supervisor, the front and the background all get SIGTERM: all stop, none is started again, exit 143', async () => {
    const context = setup();
    const { child, exited } = superviseAsProcess(context);
    const started = await waitFor(() => { const all = context.read(); return all.filter((e) => e.event === 'start').length >= 2 ? all : undefined; });
    const background = started.find((e) => e.role === 'background')!;
    const front = started.find((e) => e.role === 'front')!;
    process.kill(background.pid, 'SIGTERM');
    process.kill(front.pid, 'SIGTERM');
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    const events = context.read();
    expect(events.filter((e) => e.event === 'start')).toHaveLength(2);
    expect(events.filter((e) => e.event === 'stop').map((e) => e.role).sort()).toEqual(['background', 'front']);
    expect(alive(background.pid)).toBe(false);
    expect(alive(front.pid)).toBe(false);
  }, 30_000);
});

describe('the unit\'s process stays the supervisor for its whole life', () => {
  test('it stays up while both children wait out their restart backoff, and starts them again', async () => {
    const context = setup();
    const { child, exited } = superviseAsProcess(context, { CRASH_AFTER_MS: '200' });
    // Both children exit 1 shortly after each start; every one is replaced.
    await waitFor(() => context.read().filter((e) => e.role === 'background' && e.event === 'start').length >= 3 ? true : undefined);
    await waitFor(() => context.read().filter((e) => e.role === 'front' && e.event === 'start').length >= 2 ? true : undefined);
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
  }, 30_000);

  test('what the children print reaches the unit\'s log', async () => {
    const context = setup();
    const { child, output, exited } = superviseAsProcess(context, { SAY: '1' });
    await waitFor(() => output.stdout.includes('hello from the background on stdout') && output.stdout.includes('hello from the front on stdout') ? true : undefined);
    await waitFor(() => output.stderr.includes('hello from the background on stderr') && output.stderr.includes('hello from the front on stderr') ? true : undefined);
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
  }, 30_000);

  test('a child that fails is reported in the unit\'s log', async () => {
    const context = setup();
    const lines: string[] = [];
    await supervise(context, (line) => lines.push(line));
    const started = await waitFor(() => context.read().filter((e) => e.event === 'start').length >= 2 ? context.read() : undefined);
    process.kill(started.find((e) => e.role === 'background')!.pid, 'SIGKILL');
    await waitFor(() => lines.some((line) => /background engine exited unexpectedly/.test(line)) ? true : undefined);
  }, 30_000);

  test('a stop while the background is still starting never starts the front', async () => {
    const context = setup();
    context.env.READY_DELAY_MS = '1500';
    const spawnedRoles: string[] = [];
    const supervising = superviseWorkerServiceSplit({
      ...superviseOptions(context),
      spawn: (command, args, options) => {
        spawnedRoles.push(String(options.env?.OLYMPUS_WORKER_ENGINE_ROLE));
        return childProcess.spawn(command, args, options);
      },
    });
    await waitFor(() => context.read().some((e) => e.role === 'background' && e.event === 'start') ? true : undefined);
    context.signals.get('SIGTERM')!();
    await waitFor(() => context.exits.length > 0 ? true : undefined);
    const handle = await supervising;
    cleanups.push(() => handle.stop());
    expect(context.exits).toEqual([143]);
    expect(spawnedRoles).toEqual(['background']);
  }, 30_000);

  // The command runs the way an interpreter-launched tool (ocrmypdf: python3
  // plus a script) does: what the process table shows is not what was spawned.
  test('a background that dies leaves no extraction command of its running', async () => {
    const context = setup();
    context.env.SPAWN_EXTRACTION = '1';
    await supervise(context);
    const extraction = await waitFor(() => context.read().find((e) => e.role === 'extraction'));
    const background = context.read().find((e) => e.role === 'background' && e.event === 'start')!;
    cleanups.push(() => { if (alive(extraction.pid)) process.kill(extraction.pid, 'SIGKILL'); });
    process.kill(background.pid, 'SIGKILL');
    // The replacement starts only once the dead background's extraction is gone.
    await waitFor(() => context.read().filter((e) => e.role === 'background' && e.event === 'start').length >= 2 ? true : undefined);
    expect(alive(extraction.pid)).toBe(false);
  }, 30_000);
});

describe('when it applies', () => {
  test('only the unit\'s own process on Linux, with the switch on', () => {
    const base = { platform: 'linux' as const, managed: false, engineSplit: true, env: {} };
    expect(workerServiceSplitApplies(base)).toBe(true);
    expect(workerServiceSplitApplies({ ...base, engineSplit: false })).toBe(false);
    // A child it started (or one an engine host started) already has its role.
    expect(workerServiceSplitApplies({ ...base, env: { OLYMPUS_WORKER_ENGINE_ROLE: 'front' } })).toBe(false);
    expect(workerServiceSplitApplies({ ...base, env: { OLYMPUS_WORKER_ENGINE_ROLE: 'background' } })).toBe(false);
    // The Gateway's and the engine host's validated launch supervise it themselves.
    expect(workerServiceSplitApplies({ ...base, managed: true })).toBe(false);
    // Macs run the split under the standalone engine.
    expect(workerServiceSplitApplies({ ...base, platform: 'darwin' })).toBe(false);
  });

  test('with the switch off __worker-service-run starts the worker exactly as before', async () => {
    const launches: unknown[] = [];
    let supervised = 0;
    await runWorkerForeground({
      env: {},
      applySetupEnv: () => {},
      startWorker: (launch) => { launches.push(launch); },
      engineSplit: () => false,
      platform: 'linux',
      superviseSplit: async () => { supervised += 1; },
    });
    expect(launches).toEqual([{ nativeServiceSupervised: false }]);
    expect(supervised).toBe(0);
    await runWorkerForeground({
      env: {},
      applySetupEnv: () => {},
      startWorker: (launch) => { launches.push(launch); },
      engineSplit: () => true,
      platform: 'linux',
      superviseSplit: async () => { supervised += 1; },
    });
    expect(launches).toHaveLength(1);
    expect(supervised).toBe(1);
  });
});

describe('the systemd unit', () => {
  test('keeps the default control-group stop: every process in the unit gets SIGTERM at once', async () => {
    const result = await installWorkerService({ platform: 'linux', homeDir: '/home/friend', workingDirectory: '/home/friend/olympus', dryRun: true });
    // An ordered stop (front, then background) needs KillMode=mixed: a later, opt-in change.
    expect(result.unit).not.toContain('KillMode=');
    expect(result.unit).not.toContain('TimeoutStopSec=');
  });
});
