/**
 * The supervisor replaces a ready child whatever way it exits, and a process
 * group it cannot signal never strands it with no child.
 *
 * Incident 2026-10-08 07:05:32Z: the Mac dashboard saved the zkAPI
 * acknowledgements, the worker reloaded itself (exit 75), and the engine host
 * logged "descendants could not be stopped after an unexpected exit" two
 * milliseconds later and never restarted it. macOS answers kill(-pgid) with
 * EPERM when the group holds only exiting or zombie members (the built-in
 * model server shares the worker's group and was mid-exit), and that EPERM was
 * treated as a cleanup failure that skipped the restart.
 */
import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeProcessService,
  setNativeProcessChildObserver,
  type NativeProcessServiceContext,
  type NativeProcessServiceDefinition,
} from '../src/core/native-process-service.ts';

const READY_ENV = 'OLYMPUS_RESTART_READY_PATH';
const INSTANCE_ENV = 'OLYMPUS_RESTART_INSTANCE';
const WRITE_RECEIPT = `require('node:fs').writeFileSync(process.env.${READY_ENV}, process.env.${INSTANCE_ENV} + ':' + process.pid);`;
/** Produces its receipt and stays up until the supervisor stops it. */
const STAY_ALIVE = `${WRITE_RECEIPT} setInterval(() => {}, 1000);`;
/** The worker's reload: ready, then a deliberate exit 75 with nothing left in its group. */
const SELF_RESTART_75 = `${WRITE_RECEIPT} setTimeout(() => process.exit(75), 150);`;
/** Ready, then shuts down on its own SIGTERM handler and exits 0. */
const SIGTERM_HANDLED_EXIT_0 = `${WRITE_RECEIPT}
process.once('SIGTERM', () => { console.log('shutting down on SIGTERM.'); process.exit(0); });
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 150);`;
/** Ready, then killed by an unhandled SIGTERM. */
const SIGTERM_UNHANDLED = `${WRITE_RECEIPT} setTimeout(() => process.kill(process.pid, 'SIGTERM'), 150);`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Harness {
  service: NativeProcessServiceDefinition;
  health: string[];
  logs: string[];
  warnings: string[];
  spawned: ChildProcess[];
  context: NativeProcessServiceContext;
}

type Launch = string | { command: string; args: string[] };

function harness(scriptForLaunch: (launchIndex: number) => Launch, options: { descendantSettleMs?: number } = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'olympus-native-restart-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const readyPath = join(directory, 'ready');
  const health: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const spawned: ChildProcess[] = [];
  let launchIndex = 0;
  const service = createNativeProcessService({
    id: 'fixture',
    label: 'fixture',
    initialConfig: {},
    reload: { configPrefixes: [] },
    readinessPollMs: 10,
    stopGraceMs: 200,
    restartDelaysMs: [20, 40],
    ...(options.descendantSettleMs === undefined ? {} : { descendantSettleMs: options.descendantSettleMs }),
    spawn: ((command: string, args: readonly string[], spawnOptions: object) => {
      const child = spawnProcess(command, args as string[], spawnOptions as Parameters<typeof spawnProcess>[2]);
      spawned.push(child);
      return child;
    }) as unknown as typeof spawnProcess,
    async prepareStart() {
      const launch = scriptForLaunch(launchIndex);
      launchIndex += 1;
      const instance = randomUUID();
      return {
        command: typeof launch === 'string' ? process.execPath : launch.command,
        args: typeof launch === 'string' ? ['-e', launch] : launch.args,
        env: { PATH: process.env.PATH ?? '', [READY_ENV]: readyPath, [INSTANCE_ENV]: instance },
        startupTimeoutMs: 5_000,
        endpointOccupied: false,
        readinessProbe: async (child) => {
          try {
            return readFileSync(readyPath, 'utf8') === `${instance}:${String(child.pid)}`;
          } catch {
            return false;
          }
        },
      };
    },
  });
  const context: NativeProcessServiceContext = {
    logger: { info: (message) => { logs.push(message); }, warn: (message) => { warnings.push(message); } },
    serviceHealth: {
      reportFailure: (error) => { health.push(error.message); },
      clearFailure: () => { health.push('clear'); },
    },
  };
  return { service, health, logs, warnings, spawned, context };
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const readyCount = (run: Harness): number => run.logs.filter((line) => line === 'Olympus fixture is ready.').length;

/**
 * Interposes on group signals for the first spawned child only: `answer`
 * decides what the kernel says to each kill(-pgid, signal). Everything else
 * goes to the real process.kill.
 */
function interposeGroupKill(run: Harness, answer: (signal: NodeJS.Signals | number | undefined, call: number) => 'ESRCH' | 'EPERM' | 'ok') {
  const realKill = process.kill;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let calls = 0;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    const first = run.spawned[0];
    if (!first?.pid || pid !== -first.pid) return realKill(pid, signal);
    signals.push(signal);
    const result = answer(signal, calls);
    calls += 1;
    if (result === 'ok') return true;
    throw Object.assign(new Error(`synthetic ${result}`), { code: result });
  }) as typeof process.kill;
  const restore = () => { process.kill = realKill; };
  cleanups.push(restore);
  return { signals, restore };
}

for (const [name, script] of [
  ['a deliberate self-restart (exit 75)', SELF_RESTART_75],
  ['a SIGTERM handled with exit 0', SIGTERM_HANDLED_EXIT_0],
  ['an unhandled SIGTERM', SIGTERM_UNHANDLED],
] as const) {
  test(`a ready child that exits by itself through ${name}, with an empty process group, is replaced`, async () => {
    const run = harness((launch) => (launch === 0 ? script : STAY_ALIVE));
    try {
      await run.service.start(run.context);
      await waitUntil(() => readyCount(run) === 2, 'the replacement child to become ready');
      expect(run.spawned).toHaveLength(2);
      expect(run.spawned[0]!.pid).not.toBe(run.spawned[1]!.pid);
      expect(run.health).toEqual([
        'Olympus fixture is starting.',
        'clear',
        'Olympus fixture exited unexpectedly.',
        'Olympus fixture is starting.',
        'clear',
      ]);
      expect(run.warnings).toEqual([]);
    } finally {
      await run.service.stop();
    }
  }, 15_000);
}

test('a group kill that answers ESRCH counts as stopped: the observer is told and the child is replaced', async () => {
  const run = harness((launch) => (launch === 0 ? SELF_RESTART_75 : STAY_ALIVE));
  const stopped: number[] = [];
  setNativeProcessChildObserver({ spawned() {}, stopped: (_id, pgid) => { stopped.push(pgid); } });
  cleanups.push(() => setNativeProcessChildObserver(undefined));
  const kill = interposeGroupKill(run, () => 'ESRCH');
  try {
    await run.service.start(run.context);
    await waitUntil(() => readyCount(run) === 2, 'the replacement child to become ready');
    expect(kill.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(stopped).toContain(run.spawned[0]!.pid!);
    expect(run.warnings).toEqual([]);
    expect(run.health.filter((line) => line.includes('could not be stopped'))).toEqual([]);
  } finally {
    kill.restore();
    await run.service.stop();
  }
}, 15_000);

test('the incident: EPERM from a group of exiting members after a self-restart settles as stopped and the child is replaced', async () => {
  const run = harness((launch) => (launch === 0 ? SELF_RESTART_75 : STAY_ALIVE));
  // macOS: the group answers EPERM while its last members are mid-exit, then
  // ESRCH once launchd has reaped them.
  let reapedAt: number | undefined;
  const kill = interposeGroupKill(run, () => {
    reapedAt ??= Date.now() + 150;
    return Date.now() < reapedAt ? 'EPERM' : 'ESRCH';
  });
  try {
    await run.service.start(run.context);
    await waitUntil(() => readyCount(run) === 2, 'the replacement child to become ready');
    expect(kill.signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(kill.signals.slice(2)).toContain(0);
    expect(run.warnings).toEqual([]);
    expect(run.health).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
      'Olympus fixture is starting.',
      'clear',
    ]);
  } finally {
    kill.restore();
    await run.service.stop();
  }
}, 15_000);

test('a group that truly cannot be stopped gets the forced kill, a loud report, and the child is still replaced', async () => {
  const run = harness((launch) => (launch === 0 ? SELF_RESTART_75 : STAY_ALIVE), { descendantSettleMs: 200 });
  const stopped: number[] = [];
  setNativeProcessChildObserver({ spawned() {}, stopped: (_id, pgid) => { stopped.push(pgid); } });
  cleanups.push(() => setNativeProcessChildObserver(undefined));
  const kill = interposeGroupKill(run, () => 'EPERM');
  const message = 'Olympus fixture descendants could not be stopped after an unexpected exit; restarting it anyway.';
  try {
    await run.service.start(run.context);
    await waitUntil(() => readyCount(run) === 2, 'the replacement child to become ready');
    // The forced kill was sent, then the bounded settle probed the group.
    expect(kill.signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(kill.signals.slice(2).every((signal) => signal === 0)).toBe(true);
    expect(kill.signals.length).toBeGreaterThan(2);
    // Loud: a warning in the log and the health failure, before the restart.
    expect(run.warnings).toEqual([message]);
    expect(run.health).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
      message,
      'Olympus fixture is starting.',
      'clear',
    ]);
    // The record is retired either way: the host's next-start sweep cannot
    // act on a group whose leader is gone, so keeping it would promise nothing.
    expect(stopped).toContain(run.spawned[0]!.pid!);
  } finally {
    kill.restore();
    await run.service.stop();
  }
}, 15_000);

test('EPERM while the child itself is alive still fails the stop and keeps custody', async () => {
  const run = harness(() => STAY_ALIVE);
  const kill = interposeGroupKill(run, () => 'EPERM');
  try {
    await run.service.start(run.context);
    await waitUntil(() => readyCount(run) === 1, 'the child to become ready');
    await expect(run.service.stop()).rejects.toThrow('synthetic EPERM');
    expect(run.spawned[0]!.exitCode).toBeNull();
    expect(kill.signals).toEqual(['SIGTERM']);
  } finally {
    kill.restore();
    await run.service.stop();
  }
}, 15_000);

/**
 * The real kernel, no stubbed answers: the leader exits 75 and leaves only a
 * zombie in its group (its parent moved to another group and has not reaped
 * it yet). macOS answers EPERM for that group, which is the incident; the
 * supervisor must still replace the child. Linux signals zombies, so it never
 * produces that EPERM and this test is skipped there rather than passing
 * without covering anything.
 */
const darwinWithPerl = process.platform === 'darwin' && Bun.which('perl') !== null;
test.skipIf(!darwinWithPerl)('macOS only (Linux never answers EPERM for a zombie group): a self-restart that leaves only a zombie in its group is replaced (real kernel)', async () => {
  const zombieLeader = `
my $c = fork();
if ($c == 0) {
  my $g = fork();
  if ($g == 0) { exit 0; }
  setpgrp(0, 0);
  select(undef, undef, undef, 0.6);
  exit 0;
}
open(my $f, '>', $ENV{${READY_ENV}}) or die; print $f "$ENV{${INSTANCE_ENV}}:$$"; close($f);
select(undef, undef, undef, 0.4);
exit 75;
`;
  const run = harness((launch) => (launch === 0 ? { command: 'perl', args: ['-e', zombieLeader] } : STAY_ALIVE));
  // Pass every call through to the real kernel; only record what it answered.
  const realKill = process.kill;
  const answers: string[] = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    const first = run.spawned[0];
    if (!first?.pid || pid !== -first.pid) return realKill(pid, signal);
    try {
      const result = realKill(pid, signal);
      answers.push('ok');
      return result;
    } catch (error) {
      answers.push(String((error as NodeJS.ErrnoException).code));
      throw error;
    }
  }) as typeof process.kill;
  cleanups.push(() => { process.kill = realKill; });
  try {
    await run.service.start(run.context);
    await waitUntil(() => readyCount(run) === 2, 'the replacement child to become ready');
    // The kernel really answered EPERM: this is the incident, not a stub.
    expect(answers).toContain('EPERM');
    expect(run.spawned).toHaveLength(2);
    expect(run.health.slice(0, 3)).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
    ]);
    expect(run.health.slice(-2)).toEqual(['Olympus fixture is starting.', 'clear']);
  } finally {
    process.kill = realKill;
    await run.service.stop();
  }
}, 15_000);

interface SyntheticChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  directKills: string[];
  kill(signal?: NodeJS.Signals): boolean;
  exitNow(signal: NodeJS.Signals): void;
}

/**
 * Synthetic children under the real supervisor. `stuck(index)` decides how
 * child `index` answers group signals while it lives: `eperm` refuses them,
 * `accepts` takes them without ever exiting (an uninterruptible wait), and
 * `false` exits on the signal. Direct kills are only recorded; a stuck child
 * leaves only when the test calls exitNow. `ready(index)` is its readiness.
 */
function syntheticSupervisor(options: {
  stuck: (index: number) => 'eperm' | 'accepts' | false;
  ready: (index: number) => boolean;
  startupTimeoutMs?: number;
}) {
  const children: SyntheticChild[] = [];
  const health: string[] = [];
  const warnings: string[] = [];
  const stopped: number[] = [];
  let launches = 0;
  const live = (child: SyntheticChild) => child.exitCode === null && child.signalCode === null;
  const makeChild = (): SyntheticChild => {
    const child: SyntheticChild = Object.assign(new EventEmitter(), {
      pid: 980_000 + children.length,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      directKills: [] as string[],
      kill(signal?: NodeJS.Signals) { child.directKills.push(signal ?? 'SIGTERM'); return true; },
      exitNow(signal: NodeJS.Signals) {
        if (!live(child)) return;
        child.signalCode = signal;
        child.emit('exit', null, signal);
      },
    }) as SyntheticChild;
    children.push(child);
    return child;
  };
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    const child = children.find((entry) => entry.pid === -pid);
    if (!child) return realKill(pid, signal);
    if (!live(child)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    const stuck = options.stuck(children.indexOf(child));
    if (stuck === 'eperm') throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' });
    if (stuck === false && signal !== 0) setTimeout(() => child.exitNow(signal as NodeJS.Signals), 0);
    return true;
  }) as typeof process.kill;
  const restore = () => { process.kill = realKill; };
  cleanups.push(restore);
  setNativeProcessChildObserver({ spawned() {}, stopped: (_id, pgid) => { stopped.push(pgid); } });
  cleanups.push(() => setNativeProcessChildObserver(undefined));
  const service = createNativeProcessService({
    id: 'fixture',
    label: 'fixture',
    initialConfig: {},
    reload: { configPrefixes: [] },
    readinessPollMs: 10,
    stopGraceMs: 50,
    restartDelaysMs: [20, 40],
    spawn: (() => makeChild()) as unknown as typeof spawnProcess,
    async prepareStart() {
      const launch = launches;
      launches += 1;
      return {
        command: '/synthetic/unused',
        args: [],
        env: {},
        startupTimeoutMs: options.ready(launch) ? 2_000 : (options.startupTimeoutMs ?? 150),
        endpointOccupied: false,
        readinessProbe: async () => options.ready(launch),
      };
    },
  });
  const context: NativeProcessServiceContext = {
    logger: { warn: (message) => { warnings.push(message); } },
    serviceHealth: { reportFailure: (error) => { health.push(error.message); }, clearFailure: () => { health.push('clear'); } },
  };
  const finish = async () => {
    for (const child of children) child.exitNow('SIGKILL');
    try { await service.stop(); } finally { restore(); }
  };
  return { service, context, children, health, warnings, stopped, finish };
}

const WAITING = 'Olympus fixture could not be stopped after a failed start; waiting for it to exit before starting another.';

for (const [name, stuck] of [
  ['refuses group signals (EPERM)', 'eperm'],
  ['takes every signal but never exits', 'accepts'],
] as const) {
  test(`a failed relaunch whose child is alive, unready and ${name} is never spawned over: the next start waits for its exit`, async () => {
    // Child 0 starts ready and then crashes, so the relaunch path runs. Child
    // 1 (the failed relaunch) never becomes ready and will not go away until
    // the test lets it. Later children behave.
    const run = syntheticSupervisor({ stuck: (index) => (index === 1 ? stuck : false), ready: (index) => index !== 1 });
    try {
      await run.service.start(run.context);
      expect(run.children).toHaveLength(1);
      run.children[0]!.exitNow('SIGSEGV');
      await waitUntil(() => run.children.length === 2, 'the relaunch');
      await waitUntil(() => run.warnings.includes(WAITING), 'the failed relaunch to be reported');
      // Through several cleanup rounds: still one live child, killed directly
      // each round, never spawned over, and its record kept.
      await waitUntil(() => run.children[1]!.directKills.filter((signal) => signal === 'SIGKILL').length >= 2, 'repeated direct kills');
      expect(run.children).toHaveLength(2);
      expect(run.warnings.filter((message) => message === WAITING)).toHaveLength(1);
      expect(run.stopped).not.toContain(run.children[1]!.pid);
      // Once it exits, the next start follows.
      run.children[1]!.exitNow('SIGKILL');
      await waitUntil(() => run.children.length === 3 && run.health.at(-1) === 'clear', 'the replacement after the exit');
      expect(run.health).toContain('Olympus fixture failed to become ready.');
      expect(run.stopped).toContain(run.children[1]!.pid);
    } finally {
      await run.finish();
    }
  }, 15_000);
}

test('stop() never reports success while the child took every signal but has not exited, and keeps custody', async () => {
  let stuck = true;
  const run = syntheticSupervisor({ stuck: () => (stuck ? 'accepts' : false), ready: () => true });
  try {
    await run.service.start(run.context);
    const child = run.children[0]!;
    await expect(run.service.stop()).rejects.toThrow('has not exited after the forced kill');
    expect(child.signalCode).toBeNull();
    expect(run.stopped).not.toContain(child.pid);
    // Custody kept: a new start must not spawn beside it.
    await expect(run.service.start(run.context)).rejects.toThrow('has not exited after the forced kill');
    expect(run.children).toHaveLength(1);
    // Once it can exit, the retained stop completes and a start may follow.
    stuck = false;
    await run.service.stop();
    expect(child.signalCode).not.toBeNull();
    expect(run.stopped).toContain(child.pid);
  } finally {
    await run.finish();
  }
}, 15_000);
