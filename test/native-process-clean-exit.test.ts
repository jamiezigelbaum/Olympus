import { expect, test } from 'bun:test';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeProcessService,
  type NativeProcessServiceContext,
  type NativeProcessServiceDefinition,
} from '../src/core/native-process-service.ts';

const READY_ENV = 'OLYMPUS_CLEAN_EXIT_READY_PATH';
const INSTANCE_ENV = 'OLYMPUS_CLEAN_EXIT_INSTANCE';

interface Fixture {
  instanceId: string;
  readyPath: string;
  cleanup(): void;
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'olympus-native-clean-exit-'));
  return {
    instanceId: randomUUID(),
    readyPath: join(directory, 'readiness.json'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * The exact-instance receipt the supervisor must see before a zero exit counts
 * as completion: what this child wrote, for this child's pid.
 */
function readinessProbe(fx: Fixture): (child: ChildProcess) => Promise<boolean> {
  return async (child) => {
    try {
      const receipt = readFileSync(fx.readyPath, 'utf8');
      return receipt === `${fx.instanceId}:${String(child.pid)}`;
    } catch {
      return false;
    }
  };
}

function countingSpawn(spawned: ChildProcess[]): typeof spawnProcess {
  return ((command: string, args: readonly string[], options: object) => {
    const child = spawnProcess(command, args as string[], options as Parameters<typeof spawnProcess>[2]);
    spawned.push(child);
    return child;
  }) as unknown as typeof spawnProcess;
}

function fixtureEnv(fx: Fixture): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    [READY_ENV]: fx.readyPath,
    [INSTANCE_ENV]: fx.instanceId,
  };
}

const WRITE_RECEIPT = `require('node:fs').writeFileSync(process.env.${READY_ENV}, process.env.${INSTANCE_ENV} + ':' + process.pid);`;

/** Writes its receipt and leaves cleanly, faster than the first readiness poll. */
const FAST_CLEAN_SCRIPT = `${WRITE_RECEIPT} process.exit(0);`;

/** Writes its receipt, leaves a descendant in its group, then leaves cleanly. */
const DELAYED_CLEAN_SCRIPT = `${WRITE_RECEIPT}
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
setTimeout(() => process.exit(0), 150);`;

/** Writes its receipt, then fails. */
const DELAYED_FAILURE_SCRIPT = `${WRITE_RECEIPT} setTimeout(() => process.exit(3), 150);`;

/** Writes its receipt, then dies from a signal. */
const DELAYED_SIGNAL_SCRIPT = `${WRITE_RECEIPT} setTimeout(() => process.kill(process.pid, 'SIGKILL'), 150);`;

/** Writes its receipt, then leaves zero with no descendants left behind. */
const DELAYED_CLEAN_LEAF_SCRIPT = `${WRITE_RECEIPT} setTimeout(() => process.exit(0), 150);`;

/** Leaves zero without ever producing a readiness receipt. */
const ZERO_WITHOUT_RECEIPT_SCRIPT = 'process.exit(0);';

/** Produces its receipt and stays up until the supervisor stops it. */
const STAY_ALIVE_SCRIPT = `${WRITE_RECEIPT} setInterval(() => {}, 1000);`;

interface Harness {
  service: NativeProcessServiceDefinition;
  health: string[];
  logs: string[];
  spawned: ChildProcess[];
}

function harness(fx: Fixture, options: {
  restartOnCleanExit?: boolean;
  scriptForLaunch: (launchIndex: number) => string;
  readinessPollMs?: number;
}): Harness {
  const health: string[] = [];
  const logs: string[] = [];
  const spawned: ChildProcess[] = [];
  let launchIndex = 0;
  const service = createNativeProcessService({
    id: 'fixture',
    label: 'fixture',
    initialConfig: {},
    reload: { configPrefixes: [] },
    readinessPollMs: options.readinessPollMs ?? 10,
    stopGraceMs: 300,
    restartDelaysMs: [20, 40],
    spawn: countingSpawn(spawned),
    ...(options.restartOnCleanExit === undefined ? {} : { restartOnCleanExit: options.restartOnCleanExit }),
    async prepareStart() {
      const script = options.scriptForLaunch(launchIndex);
      launchIndex += 1;
      return {
        command: process.execPath,
        args: ['-e', script],
        env: fixtureEnv(fx),
        startupTimeoutMs: 5_000,
        endpointOccupied: false,
        readinessProbe: readinessProbe(fx),
      };
    },
  });
  return { service, health, logs, spawned };
}

function context(target: Harness): NativeProcessServiceContext {
  return {
    logger: { info: (message) => { target.logs.push(message); } },
    serviceHealth: {
      reportFailure: (error) => { target.health.push(error.message); },
      clearFailure: () => { target.health.push('clear'); },
    },
  };
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function processGroupGone(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

test('a zero exit before the first poll completes only with an exact-instance receipt', async () => {
  const fx = fixture();
  const run = harness(fx, { restartOnCleanExit: false, readinessPollMs: 250, scriptForLaunch: () => FAST_CLEAN_SCRIPT });
  try {
    await run.service.start(context(run));
    await Bun.sleep(200);

    // No replacement was spawned after the restart delay, and the fast child was
    // settled as completion (the ready marker is never logged for that path).
    expect(run.spawned.length).toBe(1);
    expect(run.logs).toEqual(['Olympus fixture completed a clean exit.']);
    expect(run.health).toEqual(['Olympus fixture is starting.', 'clear']);
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);

test('a ready child that leaves cleanly later completes and still stops its process group', async () => {
  const fx = fixture();
  const run = harness(fx, { restartOnCleanExit: false, scriptForLaunch: () => DELAYED_CLEAN_SCRIPT });
  try {
    await run.service.start(context(run));
    await waitUntil(() => run.logs.includes('Olympus fixture is ready.'), 'the child to be ready');
    const childPid = run.spawned[0]?.pid;
    expect(childPid).toBeGreaterThan(0);

    // The child left a descendant running in its group: completion still owns
    // that group, so the descendant cannot outlive the clean exit.
    await waitUntil(() => processGroupGone(childPid), 'the descendant process group to exit');
    expect(processGroupGone(childPid)).toBe(true);

    // A clean exit is never a crash: no replacement and no readiness failure.
    await Bun.sleep(200);
    expect(run.spawned.length).toBe(1);
    expect(run.health).not.toContain('Olympus fixture exited unexpectedly.');
    expect(run.health).not.toContain('Olympus fixture failed to become ready.');
    expect(run.health.filter((message) => message === 'Olympus fixture is starting.')).toHaveLength(1);
    // Not asserted: signaling a group whose last member is still reaping can be
    // denied, and the strict EPERM rule reports that rather than swallowing it.
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);

test('a ready child that exits nonzero still restarts under the same option', async () => {
  const fx = fixture();
  const run = harness(fx, {
    restartOnCleanExit: false,
    scriptForLaunch: (launchIndex) => (launchIndex === 0 ? DELAYED_FAILURE_SCRIPT : STAY_ALIVE_SCRIPT),
  });
  try {
    await run.service.start(context(run));
    await waitUntil(
      () => run.logs.filter((message) => message === 'Olympus fixture is ready.').length === 2,
      'the replacement child to become ready',
    );
    expect(run.health).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
      'Olympus fixture is starting.',
      'clear',
    ]);
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);

test('a zero exit without a readiness receipt fails instead of completing', async () => {
  const fx = fixture();
  const run = harness(fx, { restartOnCleanExit: false, scriptForLaunch: () => ZERO_WITHOUT_RECEIPT_SCRIPT });
  try {
    await expect(run.service.start(context(run))).rejects.toThrow('Olympus fixture failed to become ready.');
    await Bun.sleep(200);

    expect(run.spawned.length).toBe(1);
    expect(run.health).toEqual([
      'Olympus fixture is starting.',
      'Olympus fixture failed to become ready.',
    ]);
    expect(run.logs).toEqual([]);
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);

test('a ready child killed by a signal still restarts under the same option', async () => {
  const fx = fixture();
  const run = harness(fx, {
    restartOnCleanExit: false,
    scriptForLaunch: (launchIndex) => (launchIndex === 0 ? DELAYED_SIGNAL_SCRIPT : STAY_ALIVE_SCRIPT),
  });
  try {
    await run.service.start(context(run));
    await waitUntil(
      () => run.logs.filter((message) => message === 'Olympus fixture is ready.').length === 2,
      'the replacement child to become ready',
    );
    expect(run.health).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
      'Olympus fixture is starting.',
      'clear',
    ]);
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);

test('the default supervision still fails a zero exit that lands before the first poll', async () => {
  const fx = fixture();
  const run = harness(fx, { readinessPollMs: 250, scriptForLaunch: () => FAST_CLEAN_SCRIPT });
  try {
    await expect(run.service.start(context(run))).rejects.toThrow('Olympus fixture failed to become ready.');
    expect(run.spawned.length).toBe(1);
    expect(run.logs).toEqual([]);
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);

test('the default supervision still restarts a ready child that exits zero', async () => {
  const fx = fixture();
  const run = harness(fx, {
    scriptForLaunch: (launchIndex) => (launchIndex === 0 ? DELAYED_CLEAN_LEAF_SCRIPT : STAY_ALIVE_SCRIPT),
  });
  try {
    await run.service.start(context(run));
    await waitUntil(
      () => run.logs.filter((message) => message === 'Olympus fixture is ready.').length === 2,
      'the replacement child to become ready',
    );
    expect(run.health).toEqual([
      'Olympus fixture is starting.',
      'clear',
      'Olympus fixture exited unexpectedly.',
      'Olympus fixture is starting.',
      'clear',
    ]);
  } finally {
    await run.service.stop();
    fx.cleanup();
  }
}, 15_000);
