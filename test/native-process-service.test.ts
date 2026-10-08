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
    // An unconfirmed group stays in the host's record for its next sweep.
    expect(stopped).not.toContain(run.spawned[0]!.pid!);
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
 * The real kernel, no interposer: the leader exits 75 and leaves only a zombie
 * in its group (its parent moved to another group and has not reaped it yet).
 * macOS answers EPERM for that group; the supervisor must still replace the
 * child. Elsewhere the kernel signals zombies and this passes trivially.
 */
test.if(Bun.which('perl') !== null)('a self-restart that leaves only a zombie in its group is replaced (real kernel)', async () => {
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
  try {
    await run.service.start(run.context);
    await waitUntil(() => readyCount(run) === 2, 'the replacement child to become ready');
    expect(run.spawned).toHaveLength(2);
    expect(run.health.slice(0, 3)).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
    ]);
    expect(run.health.slice(-2)).toEqual(['Olympus fixture is starting.', 'clear']);
  } finally {
    await run.service.stop();
  }
}, 15_000);
