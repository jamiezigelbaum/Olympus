// The engine split under the worker service's own unit (olympus-worker.service,
// `cli.js __worker-service-run`). There is no engine host on that path, so
// with worker.engineSplit on the unit's process supervises the two processes
// itself: the background first, the front once the background answers ready;
// the front stops first; a background that exits is restarted on the shared
// backoff. These start real child processes (a stand-in for cli.js that
// records what it was started as), so this file is in the deploy lane.
import { afterEach, describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkerForeground } from '../src/cli.ts';
import { engineBackgroundSocketPath } from '../src/core/engine-split.ts';
import { superviseWorkerServiceSplit, workerServiceSplitApplies } from '../src/core/worker-service-split.ts';
import { installWorkerService } from '../src/core/worker-service.ts';
import { waitFor } from './helpers/test-clock.ts';

const CHILD = join(import.meta.dir, 'fixtures', 'worker-service-split-child.ts');
const TOKEN = 'worker-service-split-test-token';

interface ChildEvent { role: string; event: 'start' | 'stop'; pid: number; argv?: string[]; socket?: string | null; managed?: string | null; signal?: string }

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

async function supervise(context: ReturnType<typeof setup>) {
  const handle = await superviseWorkerServiceSplit({
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
    exit: (code) => { context.exits.push(code); },
    log: () => {},
  });
  cleanups.push(() => handle.stop());
  return handle;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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

  test('a stop ends the front first, then the background, then the unit\'s process', async () => {
    const context = setup();
    await supervise(context);
    const started = await waitFor(() => context.read().filter((e) => e.event === 'start').length >= 2 ? context.read() : undefined);
    context.signals.get('SIGTERM')!();
    await waitFor(() => context.exits.length > 0 ? true : undefined);
    expect(context.exits).toEqual([143]);
    const stops = context.read().filter((e) => e.event === 'stop').map((e) => e.role);
    expect(stops).toEqual(['front', 'background']);
    for (const child of started) expect(alive(child.pid)).toBe(false);
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
  test('signals only its main process on stop, so the supervisor stops the front before the background', async () => {
    const result = await installWorkerService({ platform: 'linux', homeDir: '/home/friend', workingDirectory: '/home/friend/olympus', dryRun: true });
    expect(result.unit).toContain('KillMode=mixed');
    // Room for the front's and then the background's shutdown deadline, in turn.
    expect(result.unit).toMatch(/TimeoutStopSec=\d+/);
    expect(Number(/TimeoutStopSec=(\d+)/.exec(result.unit)![1])).toBeGreaterThanOrEqual(60);
  });
});
